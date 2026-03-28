import { randomUUID } from 'node:crypto';
import { log, finishRun } from '@agent-collab/runtime-acp';
/** Persist a ServerEvent from a remote run into core DB as a node/event entry */
function appendNodeEvent(db, runId, seq, event) {
    db.prepare('INSERT OR IGNORE INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)').run(runId, seq, 'node/event', JSON.stringify(event), Date.now());
}
/** Event types worth persisting for history replay */
const REPLAY_EVENT_TYPES = new Set([
    'content.delta',
    'tool.call',
    'tool.result',
    'thinking.delta',
    'plan.update',
    'task.update',
]);
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
         AND sender_type = 'agent'`)
        .get(runId);
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
function isCancelStopReason(stopReason) {
    return Boolean(stopReason?.includes('cancel'));
}
function normalizeComparisonText(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function stripLegacyStatusText(text) {
    return text
        .split('\n')
        .filter((line) => !/^\s*(?:-\s*)?\[(?:plan|task)\]\b/i.test(line))
        .join('\n');
}
function stripInternalReminderTail(text) {
    return text
        .replace(/\(?System reminder acknowledged[\s\S]*$/i, '')
        .trim();
}
function cleanFallbackText(text) {
    return stripInternalReminderTail(stripLegacyStatusText(text)).trim();
}
function hasSubstantiveFallbackText(text) {
    return text.replace(/\s+/g, '').length >= 16;
}
function listRunAgentMessages(db, runId) {
    return db.prepare(`SELECT content, created_at, channel_id, seq
     FROM channel_messages
     WHERE run_id = ?
       AND sender_type = 'agent'
     ORDER BY created_at ASC, seq ASC`).all(runId);
}
function listRunDeltaEvents(db, runId) {
    const rows = db
        .prepare(`SELECT payload_json as payloadJson
              ,created_at as createdAt
              ,seq
       FROM events
       WHERE run_id = ?
         AND method = 'node/event'
       ORDER BY seq ASC`).all(runId);
    const deltas = [];
    for (const row of rows) {
        try {
            const payload = JSON.parse(row.payloadJson);
            if (payload.type === 'content.delta' && typeof payload.text === 'string') {
                deltas.push({
                    createdAt: row.createdAt,
                    seq: row.seq,
                    text: payload.text,
                });
            }
        }
        catch {
            // Ignore malformed historic payloads
        }
    }
    return deltas;
}
function collectFallbackSegments(db, runId) {
    const replyRows = listRunAgentMessages(db, runId);
    const deltaRows = listRunDeltaEvents(db, runId);
    if (deltaRows.length === 0)
        return [];
    const timeline = [
        ...replyRows.map((row, index) => ({ type: 'message', createdAt: row.created_at, order: index })),
        ...deltaRows.map((row, index) => ({ type: 'delta', createdAt: row.createdAt, order: index, text: row.text, seq: row.seq })),
    ].sort((a, b) => {
        if (a.createdAt !== b.createdAt)
            return a.createdAt - b.createdAt;
        if (a.type !== b.type)
            return a.type === 'delta' ? -1 : 1;
        return a.order - b.order;
    });
    let buffer = '';
    const rawSegments = [];
    const flushBuffer = () => {
        if (!buffer)
            return;
        rawSegments.push(buffer);
        buffer = '';
    };
    for (const item of timeline) {
        if (item.type === 'delta') {
            buffer += item.text;
            continue;
        }
        flushBuffer();
    }
    flushBuffer();
    const existingNormalized = new Set(replyRows.map((row) => normalizeComparisonText(cleanFallbackText(row.content))).filter(Boolean));
    const emittedNormalized = new Set();
    return rawSegments
        .map((segment) => cleanFallbackText(segment))
        .filter((segment) => hasSubstantiveFallbackText(segment))
        .filter((segment) => {
        const normalized = normalizeComparisonText(segment);
        if (!normalized)
            return false;
        if (existingNormalized.has(normalized) || emittedNormalized.has(normalized))
            return false;
        emittedNormalized.add(normalized);
        return true;
    });
}
function getFallbackMessageContext(db, conversationId, humanUserName) {
    const row = db.prepare(`SELECT c.id as conversationId,
            c.agent_id as agentId,
            c.channel_id as channelId,
            c.thread_kind as threadKind,
            c.is_primary_thread as isPrimaryThread,
            c.thread_root_id as threadRootId,
            ch.name as channelName,
            a.name as agentName
     FROM conversations c
     JOIN agents a ON a.agent_id = c.agent_id
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`).get(conversationId);
    if (!row?.agentId)
        return null;
    const target = row.threadKind === 'direct'
        ? (row.isPrimaryThread
            ? `dm:@${humanUserName}`
            : `dm:@${humanUserName}:${row.conversationId.slice(0, 8)}`)
        : `${`#${row.channelName ?? row.channelId}`}${row.threadRootId ? `:${row.threadRootId}` : ''}`;
    return {
        agentId: row.agentId,
        agentName: row.agentName,
        channelId: row.threadKind === 'direct' ? `dm:${row.agentId}` : row.channelId,
        target,
        threadRootId: row.threadRootId ?? null,
    };
}
function nextChannelMessageSeq(db, channelId) {
    const row = db.prepare('SELECT MAX(seq) as maxSeq FROM channel_messages WHERE channel_id = ?')
        .get(channelId);
    return (row.maxSeq ?? 0) + 1;
}
function persistDeltaFallbackMessages(params) {
    if (!requiresMcpReplyContract(params.db, params.conversationId))
        return 0;
    const context = getFallbackMessageContext(params.db, params.conversationId, params.manager.getConfig().humanUserName);
    if (!context)
        return 0;
    const segments = collectFallbackSegments(params.db, params.runId);
    if (segments.length === 0)
        return 0;
    let createdAt = Date.now();
    let emittedCount = 0;
    for (const content of segments) {
        const seq = nextChannelMessageSeq(params.db, context.channelId);
        const messageId = randomUUID();
        params.db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind, message_source)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)`).run(messageId, context.channelId, context.agentId, context.agentName, context.target, content, seq, createdAt, params.runId, context.threadRootId, null, 'delta_fallback');
        params.broadcast(params.conversationId, {
            type: 'channel.message',
            message: {
                id: messageId,
                senderName: context.agentName,
                senderType: 'agent',
                content,
                createdAt: new Date(createdAt).toISOString(),
                seq,
                ...(context.threadRootId ? { threadRootId: context.threadRootId } : {}),
            },
        });
        createdAt += 1;
        emittedCount += 1;
    }
    return emittedCount;
}
function getRunEndError(msg, db, conversationId, runId) {
    if (msg.error)
        return msg.error;
    if (isCancelStopReason(msg.stopReason)) {
        if (hasRunFinalReplyMessage(db, runId))
            return null;
        if (requiresMcpReplyContract(db, conversationId)) {
            return 'Agent run was cancelled before sending a final reply';
        }
        return 'Run cancelled before completion';
    }
    return null;
}
function updateConversationStatus(db, broadcast, conversationId, status) {
    db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), conversationId);
    broadcast(conversationId, {
        type: 'conversation.status',
        conversationId,
        status,
    });
}
function finishConversationRun(params) {
    const endedAt = Date.now();
    finishRun(params.db, params.error
        ? { runId: params.runId, error: params.error }
        : { runId: params.runId, stopReason: params.stopReason ?? 'end_turn' });
    updateConversationStatus(params.db, params.broadcast, params.conversationId, params.error ? 'failed' : 'idle');
    params.broadcast(params.conversationId, {
        type: 'turn.end',
        turnId: params.runId,
        stopReason: params.error ? 'error' : (params.stopReason ?? 'end_turn'),
        endedAt,
        error: params.error,
    });
    if (params.error) {
        params.broadcast(params.conversationId, { type: 'error', message: params.error });
    }
    void params.manager.onConversationSettled(params.conversationId);
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
                const runEndError = getRunEndError(msg, db, msg.conversationId, msg.runId);
                if (!msg.error && !isCancelStopReason(msg.stopReason)) {
                    const fallbackCount = persistDeltaFallbackMessages({
                        db,
                        conversationId: msg.conversationId,
                        runId: msg.runId,
                        broadcast,
                        manager,
                    });
                    if (fallbackCount > 0) {
                        log.info('[node-ws] emitted delta fallback messages', {
                            conversationId: msg.conversationId,
                            runId: msg.runId,
                            count: fallbackCount,
                        });
                    }
                }
                finishConversationRun({
                    db,
                    broadcast,
                    manager,
                    conversationId: msg.conversationId,
                    runId: msg.runId,
                    stopReason: msg.stopReason,
                    error: runEndError ?? undefined,
                });
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
