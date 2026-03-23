import { log, finishRun } from '@agent-collab/runtime-acp';
/** Persist a ServerEvent from a remote run into core DB as a node/event entry */
function appendNodeEvent(db, runId, seq, event) {
    db.prepare('INSERT OR IGNORE INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)').run(runId, seq, 'node/event', JSON.stringify(event), Date.now());
}
/** Event types worth persisting for history replay */
const REPLAY_EVENT_TYPES = new Set(['content.delta', 'tool.call', 'tool.result', 'thinking.delta']);
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
                const existing = db.prepare('SELECT node_id FROM nodes WHERE node_id = ?').get(msg.nodeId);
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
                }
                broadcast(msg.conversationId, msg.event);
                // Persist replay-worthy events to core DB immediately
                if (REPLAY_EVENT_TYPES.has(msg.event.type)) {
                    const seq = (runSeq.get(msg.runId) ?? 0) + 1;
                    runSeq.set(msg.runId, seq);
                    appendNodeEvent(db, msg.runId, seq, msg.event);
                }
                break;
            }
            case 'run.end': {
                log.info('[node-ws] run.end', { runId: msg.runId, conversationId: msg.conversationId, error: msg.error ?? null });
                runSeq.delete(msg.runId);
                // Mark run as finished in core DB
                finishRun(db, msg.error
                    ? { runId: msg.runId, error: msg.error }
                    : { runId: msg.runId, stopReason: msg.stopReason ?? 'end_turn' });
                // Update conversation status in DB
                db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
                    .run(msg.error ? 'failed' : 'idle', Date.now(), msg.conversationId);
                broadcast(msg.conversationId, {
                    type: 'turn.end',
                    turnId: msg.runId,
                    stopReason: msg.error ? 'error' : (msg.stopReason ?? 'end_turn'),
                });
                if (msg.error) {
                    broadcast(msg.conversationId, { type: 'error', message: msg.error });
                }
                broadcast(msg.conversationId, {
                    type: 'conversation.status',
                    conversationId: msg.conversationId,
                    status: msg.error ? 'failed' : 'idle',
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
