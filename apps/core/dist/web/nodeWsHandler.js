import { log } from '@agent-collab/runtime-acp';
export function handleNodeWebSocket(socket, registry, broadcast) {
    let nodeId = null;
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
                registry.register({
                    nodeId: msg.nodeId,
                    hostname: msg.hostname,
                    agentTypes: msg.agentTypes,
                    version: msg.version,
                    ws: socket,
                    lastSeen: Date.now(),
                });
                socket.send(JSON.stringify({ type: 'node.ack', nodeId: msg.nodeId }));
                log.info(`[node-ws] registered: ${msg.nodeId} (${msg.hostname})`);
                break;
            }
            case 'node.heartbeat': {
                registry.heartbeat(msg.nodeId);
                break;
            }
            case 'run.event': {
                broadcast(msg.conversationId, msg.event);
                break;
            }
            case 'run.end': {
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
                    status: 'idle',
                });
                break;
            }
            case 'permission.request': {
                broadcast(msg.conversationId, {
                    type: 'approval.request',
                    requestId: msg.requestId,
                    toolName: msg.toolName,
                    toolArgs: msg.toolArgs,
                    toolKind: msg.toolKind,
                });
                break;
            }
            default: {
                log.warn('[node-ws] unknown message type', msg.type);
            }
        }
    });
    socket.on('close', () => {
        if (nodeId) {
            registry.unregister(nodeId);
            log.info(`[node-ws] disconnected: ${nodeId}`);
        }
    });
    socket.on('error', (err) => {
        log.warn('[node-ws] socket error', err);
    });
}
