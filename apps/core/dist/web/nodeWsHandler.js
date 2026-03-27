import { log, finishRun } from '@agent-collab/runtime-acp';
/** Persist a ServerEvent from a remote run into core DB as a node/event entry */
function appendNodeEvent(db, runId, seq, event) {
    db.prepare('INSERT OR IGNORE INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)').run(runId, seq, 'node/event', JSON.stringify(event), Date.now());
}
/** Event types worth persisting for history replay */
const REPLAY_EVENT_TYPES = new Set(['content.delta', 'tool.call', 'tool.result', 'thinking.delta']);
function requiresMcpReplyContract(db, conversationId) {
    const row = db
        .prepare('SELECT agent_id as agentId FROM conversations WHERE id = ?')
        .get(conversationId);
    return Boolean(row?.agentId);
}
function hasRunReplyMessage(db, conversationId, runId) {
    const row = db
        .prepare(`SELECT COUNT(1) as count
       FROM channel_messages
       WHERE run_id = ?
         AND channel_id = (
           SELECT 'dm:' || agent_id
           FROM conversations
           WHERE id = ?
         )`)
        .get(runId, conversationId);
    return (row?.count ?? 0) > 0;
}
function hasRunFinalReplyMessage(db, runId) {
    const row = db
        .prepare(`SELECT COUNT(1) as count
       FROM channel_messages
       WHERE run_id = ?
         AND sender_type = 'agent'
         AND message_kind = 'final'`)
        .get(runId);
    return (row?.count ?? 0) > 0;
}
function hasSubstantiveOutputAfterLastReply(db, runId) {
    const lastReply = db
        .prepare(`SELECT MAX(created_at) as lastCreatedAt
       FROM channel_messages
       WHERE run_id = ?
         AND sender_type = 'agent'`)
        .get(runId);
    if (!lastReply?.lastCreatedAt)
        return false;
    const rows = db
        .prepare(`SELECT payload_json as payloadJson
       FROM events
       WHERE run_id = ?
         AND method = 'node/event'
         AND created_at > ?
       ORDER BY seq ASC`)
        .all(runId, lastReply.lastCreatedAt);
    let textAfterReply = '';
    for (const row of rows) {
        try {
            const payload = JSON.parse(row.payloadJson);
            if (payload.type === 'content.delta' && typeof payload.text === 'string') {
                textAfterReply += payload.text;
            }
        }
        catch {
            // Ignore malformed historic payloads
        }
    }
    const normalized = textAfterReply.replace(/\s+/g, ' ').trim();
    return normalized.length >= 32;
}
function getReplyContractError(msg, db, conversationId, runId) {
    if (msg.error)
        return null;
    if (msg.stopReason?.includes('cancel'))
        return null;
    if (!requiresMcpReplyContract(db, conversationId))
        return null;
    if (!hasRunReplyMessage(db, conversationId, runId)) {
        return 'Agent did not reply via send_message';
    }
    if (hasRunFinalReplyMessage(db, runId)) {
        return null;
    }
    if (hasSubstantiveOutputAfterLastReply(db, runId)) {
        return 'Agent did not send a final reply via send_message';
    }
    return null;
}
export function handleNodeWebSocket(socket, registry, broadcast, db, manager, workspaceBroker) {
    let nodeId = null;
    // Sequence counter per runId for node/event persistence
    const runSeq = new Map();
    socket.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(String(raw));
        }
        catch {
            log.warn('[node-ws] invalid JSON from node');
            return;
        }
        switch (msg.type) {
            case 'node.register': {
                nodeId = msg.nodeId;
                const now = Date.now();
                const existing = db.prepare('SELECT node_id, status FROM nodes WHERE node_id = ?').get(msg.nodeId);
                if (existing?.status === 'deleted') {
                    log.warn(`[node-ws] connection rejected: node ${msg.nodeId} was deleted`);
                    socket.close(4000, 'Machine has been deleted');
                    return;
                }
                registry.register({
                    nodeId: msg.nodeId,
                    hostname: msg.hostname,
                    agentTypes: msg.agentTypes,
                    version: msg.version,
                    ws: socket,
                    lastSeen: now,
                });
                // Persist to DB: update existing pre-provisioned row or insert new
                const agentTypesJson = JSON.stringify(msg.agentTypes);
                if (existing) {
                    db.prepare(`UPDATE nodes SET hostname=?, agent_types_json=?, version=?, status='online', last_seen=?,
             created_at=CASE WHEN created_at=0 THEN ? ELSE created_at END WHERE node_id=?`).run(msg.hostname, agentTypesJson, msg.version, now, now, msg.nodeId);
                }
                else {
                    db.prepare(`INSERT INTO nodes(node_id, hostname, agent_types_json, version, status, last_seen, created_at, provisioned_at, display_name, env_var_keys)
             VALUES(?,?,?,?,'online',?,?,0,NULL,'[]')`).run(msg.nodeId, msg.hostname, agentTypesJson, msg.version, now, now);
                }
                socket.send(JSON.stringify({ type: 'node.ack', nodeId: msg.nodeId }));
                log.info(`[node-ws] registered: ${msg.nodeId} (${msg.hostname})`);
                break;
            }
            case 'node.heartbeat': {
                registry.heartbeat(msg.nodeId);
                break;
            }
            case 'run.event': {
                log.debug('[node-ws] run.event', { conversationId: msg.conversationId, eventType: msg.event.type });
                if (msg.event.type === 'conversation.status') {
                    db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
                        .run(msg.event.status, Date.now(), msg.conversationId);
                    broadcast(msg.conversationId, msg.event);
                    break;
                }
                // Silently discard events for runs that no longer exist (deleted by reset/clear-chat)
                const runKnown = !!(db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(msg.runId));
                if (!runKnown) {
                    log.debug('[node-ws] ignoring run.event for unknown/deleted run', { runId: msg.runId });
                    break;
                }
                const broadcastEvent = msg.event.type === 'tool.call'
                    ? { ...msg.event, startedAt: msg.event.startedAt ?? Date.now() }
                    : msg.event.type === 'tool.result'
                        ? { ...msg.event, endedAt: msg.event.endedAt ?? Date.now() }
                        : msg.event;
                broadcast(msg.conversationId, broadcastEvent);
                // Persist replay-worthy events to core DB immediately
                if (REPLAY_EVENT_TYPES.has(msg.event.type)) {
                    const seq = (runSeq.get(msg.runId) ?? 0) + 1;
                    runSeq.set(msg.runId, seq);
                    appendNodeEvent(db, msg.runId, seq, broadcastEvent);
                }
                break;
            }
            case 'run.end': {
                log.info('[node-ws] run.end', { runId: msg.runId, conversationId: msg.conversationId, error: msg.error ?? null });
                runSeq.delete(msg.runId);
                const endedAt = Date.now();
                // Check if this run still exists in core's DB.
                // After reset/clear-chat the run rows are deleted — ignore stale run.end messages
                // so they don't overwrite the conversation status set by the reset operation.
                const runExists = !!(db
                    .prepare('SELECT 1 FROM runs WHERE run_id = ?')
                    .get(msg.runId));
                if (!runExists) {
                    log.warn('[node-ws] ignoring run.end for unknown/deleted run', { runId: msg.runId });
                    void manager.onConversationSettled(msg.conversationId);
                    break;
                }
                const replyContractError = getReplyContractError(msg, db, msg.conversationId, msg.runId);
                const terminalError = msg.error ?? replyContractError ?? undefined;
                // Mark run as finished in core DB
                finishRun(db, terminalError
                    ? { runId: msg.runId, error: terminalError }
                    : { runId: msg.runId, stopReason: msg.stopReason ?? 'end_turn' });
                // Update conversation status in DB
                db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
                    .run(terminalError ? 'failed' : 'idle', endedAt, msg.conversationId);
                broadcast(msg.conversationId, {
                    type: 'turn.end',
                    turnId: msg.runId,
                    stopReason: terminalError ? 'error' : (msg.stopReason ?? 'end_turn'),
                    endedAt,
                    error: terminalError,
                });
                if (terminalError) {
                    broadcast(msg.conversationId, { type: 'error', message: terminalError });
                }
                broadcast(msg.conversationId, {
                    type: 'conversation.status',
                    conversationId: msg.conversationId,
                    status: terminalError ? 'failed' : 'idle',
                });
                void manager.onConversationSettled(msg.conversationId);
                break;
            }
            case 'permission.request': {
                db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
                    .run('awaiting_approval', Date.now(), msg.conversationId);
                broadcast(msg.conversationId, {
                    type: 'conversation.status',
                    conversationId: msg.conversationId,
                    status: 'awaiting_approval',
                });
                broadcast(msg.conversationId, {
                    type: 'approval.request',
                    requestId: msg.requestId,
                    toolName: msg.toolName,
                    toolArgs: msg.toolArgs,
                    toolKind: msg.toolKind,
                });
                break;
            }
            case 'workspace.list.response': {
                workspaceBroker?.handleWorkspaceListResponse(msg);
                break;
            }
            case 'workspace.read.response': {
                workspaceBroker?.handleWorkspaceReadResponse(msg);
                break;
            }
            case 'workspace.write.response': {
                workspaceBroker?.handleWorkspaceWriteResponse(msg);
                break;
            }
            case 'workspace.reset.response': {
                workspaceBroker?.handleWorkspaceResetResponse(msg);
                break;
            }
            default: {
                log.warn('[node-ws] unknown message type', msg.type);
            }
        }
    });
    socket.on('close', () => {
        if (nodeId) {
            workspaceBroker?.rejectPendingForNode(nodeId);
            registry.unregister(nodeId);
            manager.clearQueuedPromptsForNode(nodeId);
            db.prepare(`UPDATE nodes SET status='offline', last_seen=? WHERE node_id=?`)
                .run(Date.now(), nodeId);
            const affected = db.prepare(`SELECT id FROM conversations WHERE node_id = ? AND status != 'idle'`).all(nodeId);
            db.prepare(`UPDATE conversations SET status='failed', updated_at=? WHERE node_id=? AND status != 'idle'`)
                .run(Date.now(), nodeId);
            for (const conv of affected) {
                broadcast(conv.id, {
                    type: 'conversation.status',
                    conversationId: conv.id,
                    status: 'failed',
                });
                broadcast(conv.id, {
                    type: 'error',
                    message: `Agent node disconnected: ${nodeId}`,
                });
            }
            log.info(`[node-ws] disconnected: ${nodeId}`);
        }
    });
    socket.on('error', (err) => {
        log.warn('[node-ws] socket error', err);
    });
}
