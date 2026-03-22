import { log } from '@agent-collab/runtime-acp';
// Active WebSocket connections per conversation
const connectionsByConversation = new Map();
/** Broadcast a ServerEvent to all connected clients for a conversation */
export function broadcast(conversationId, event) {
    const sockets = connectionsByConversation.get(conversationId);
    if (!sockets)
        return;
    const data = JSON.stringify(event);
    for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) {
            ws.send(data);
        }
    }
}
/** Handle a new WebSocket connection for a conversation */
export function handleWebSocket(socket, conversationId, manager) {
    // Register this connection
    let sockets = connectionsByConversation.get(conversationId);
    if (!sockets) {
        sockets = new Set();
        connectionsByConversation.set(conversationId, sockets);
    }
    sockets.add(socket);
    // Verify conversation exists
    const conv = manager.getConversation(conversationId);
    if (!conv) {
        const errEvent = { type: 'error', message: 'Conversation not found' };
        socket.send(JSON.stringify(errEvent));
        socket.close();
        return;
    }
    // Send current status
    const statusEvent = {
        type: 'conversation.status',
        conversationId,
        status: conv.status,
    };
    socket.send(JSON.stringify(statusEvent));
    // 回放历史消息
    replayHistory(socket, conversationId, manager);
    // Signal history replay complete (client can now expect live events)
    const historyDone = { type: 'history.complete' };
    socket.send(JSON.stringify(historyDone));
    // Handle incoming messages
    socket.on('message', (raw) => {
        let event;
        try {
            event = JSON.parse(String(raw));
        }
        catch {
            const errEvent = { type: 'error', message: 'Invalid JSON' };
            socket.send(JSON.stringify(errEvent));
            return;
        }
        handleClientEvent(conversationId, event, manager).catch((err) => {
            log.warn('WebSocket client event error', err);
            broadcast(conversationId, { type: 'error', message: String(err?.message ?? err) });
        });
    });
    // Clean up on close
    socket.on('close', () => {
        sockets.delete(socket);
        if (sockets.size === 0) {
            connectionsByConversation.delete(conversationId);
        }
    });
}
/** 从 DB 读取历史 runs/events，回放为 ServerEvent 发送给客户端 */
function replayHistory(socket, conversationId, manager) {
    const db = manager.getDb();
    const row = db
        .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
        .get(conversationId);
    if (!row)
        return;
    // 获取所有 runs，按时间正序
    const runs = db
        .prepare(`SELECT run_id as runId, prompt_text as promptText, stop_reason as stopReason, ended_at as endedAt
       FROM runs WHERE session_key = ? ORDER BY started_at ASC`)
        .all(row.sessionKey);
    const send = (event) => {
        if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(event));
        }
    };
    for (const run of runs) {
        // 发送用户消息
        send({ type: 'history.user_message', text: run.promptText });
        // 发送 turn
        const turnId = `replay-${run.runId}`;
        send({ type: 'turn.begin', turnId });
        // 读取 node/event（remote runs）— 直接回放 ServerEvent
        const nodeEvents = db
            .prepare(`SELECT payload_json as payloadJson FROM events
         WHERE run_id = ? AND method = 'node/event'
         ORDER BY seq ASC`)
            .all(run.runId);
        if (nodeEvents.length > 0) {
            for (const evt of nodeEvents) {
                try {
                    send(JSON.parse(evt.payloadJson));
                }
                catch {
                    // skip malformed
                }
            }
        }
        else {
            // 本地 run：读取 session/update 事件并重新合并
            const events = db
                .prepare(`SELECT payload_json as payloadJson FROM events
           WHERE run_id = ? AND method = 'session/update'
           ORDER BY seq ASC`)
                .all(run.runId);
            let agentText = '';
            const toolCalls = new Map();
            for (const evt of events) {
                try {
                    const payload = JSON.parse(evt.payloadJson);
                    const update = payload?.update;
                    if (!update)
                        continue;
                    if (update.sessionUpdate === 'agent_message_chunk') {
                        agentText += update.content?.text ?? '';
                    }
                    if (update.sessionUpdate === 'tool_call') {
                        const toolCallId = extractToolCallIdFromUpdate(update) ?? '';
                        const name = String(update.title ?? toolCallId ?? 'tool');
                        toolCalls.set(toolCallId, { name });
                    }
                    if (update.sessionUpdate === 'tool_call_update') {
                        const toolCallId = extractToolCallIdFromUpdate(update) ?? '';
                        const existing = toolCalls.get(toolCallId);
                        const status = `${update.status ?? update.state ?? update.outcome ?? ''}`.toLowerCase();
                        if (status.includes('done') || status.includes('complete') || status.includes('success') || status.includes('error') || status.includes('fail')) {
                            if (existing) {
                                existing.output = update.output ?? status;
                                existing.error = status.includes('error') || status.includes('fail');
                            }
                        }
                    }
                }
                catch {
                    // 跳过解析失败的事件
                }
            }
            if (agentText) {
                send({ type: 'content.delta', text: agentText });
            }
            for (const [toolCallId, tc] of toolCalls) {
                send({ type: 'tool.call', toolCallId, name: tc.name, input: null });
                if (tc.output !== undefined) {
                    send({ type: 'tool.result', toolCallId, output: tc.output, error: tc.error });
                }
            }
        }
        if (run.endedAt !== null) {
            send({ type: 'turn.end', turnId, stopReason: run.stopReason ?? 'end_turn' });
        }
    }
}
/** 从 update 中提取 toolCallId */
function extractToolCallIdFromUpdate(update) {
    return update?.toolCallId ?? update?.tool_call_id ?? update?.callId ?? update?.call_id ?? null;
}
async function handleClientEvent(conversationId, event, manager) {
    switch (event.type) {
        case 'prompt': {
            const conv = manager.getConversation(conversationId);
            if (!conv?.nodeId) {
                broadcast(conversationId, { type: 'error', message: 'No agent node assigned. Connect an agent-node first.' });
                break;
            }
            log.info('[ws] prompt → remote node', { conversationId, nodeId: conv.nodeId });
            broadcast(conversationId, { type: 'conversation.status', conversationId, status: 'active' });
            try {
                await manager.dispatchToNode(conversationId, event.text);
            }
            catch (error) {
                broadcast(conversationId, { type: 'error', message: String(error?.message ?? error) });
                broadcast(conversationId, { type: 'conversation.status', conversationId, status: 'idle' });
            }
            // turn.end and idle status come from nodeWsHandler on run.end
            break;
        }
        case 'approval.response': {
            const result = await manager.handleApproval(conversationId, event.requestId, event.decision);
            if (!result.ok) {
                broadcast(conversationId, { type: 'error', message: result.message });
            }
            break;
        }
        case 'cancel':
            {
                const result = manager.cancelConversationRun(conversationId);
                if (!result.ok) {
                    broadcast(conversationId, { type: 'error', message: result.message });
                }
            }
            break;
    }
}
