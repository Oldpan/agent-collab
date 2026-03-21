import type { WebSocket } from 'ws';
import type { ServerEvent, ClientEvent } from '@agent-collab/protocol';
import { log } from '@agent-collab/runtime-acp';
import type { ConversationManager } from './conversationManager.js';
import { WsSink } from './wsSink.js';

// Active WebSocket connections per conversation
const connectionsByConversation = new Map<string, Set<WebSocket>>();

/** Broadcast a ServerEvent to all connected clients for a conversation */
function broadcast(conversationId: string, event: ServerEvent): void {
  const sockets = connectionsByConversation.get(conversationId);
  if (!sockets) return;

  const data = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

/** Create a WsSink bound to a specific conversation */
export function createSinkForConversation(conversationId: string): WsSink {
  return new WsSink((event) => broadcast(conversationId, event));
}

/** Handle a new WebSocket connection for a conversation */
export function handleWebSocket(
  socket: WebSocket,
  conversationId: string,
  manager: ConversationManager,
): void {
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
    const errEvent: ServerEvent = { type: 'error', message: 'Conversation not found' };
    socket.send(JSON.stringify(errEvent));
    socket.close();
    return;
  }

  // Send current status
  const statusEvent: ServerEvent = {
    type: 'conversation.status',
    conversationId,
    status: conv.status,
  };
  socket.send(JSON.stringify(statusEvent));

  // 回放历史消息
  replayHistory(socket, conversationId, manager);

  // Signal history replay complete (client can now expect live events)
  const historyDone: ServerEvent = { type: 'history.complete' };
  socket.send(JSON.stringify(historyDone));

  // Handle incoming messages
  socket.on('message', (raw: unknown) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(raw));
    } catch {
      const errEvent: ServerEvent = { type: 'error', message: 'Invalid JSON' };
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
    sockets!.delete(socket);
    if (sockets!.size === 0) {
      connectionsByConversation.delete(conversationId);
    }
  });
}

/** 从 DB 读取历史 runs/events，回放为 ServerEvent 发送给客户端 */
function replayHistory(
  socket: WebSocket,
  conversationId: string,
  manager: ConversationManager,
): void {
  const db = manager.getDb();
  const row = db
    .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
    .get(conversationId) as { sessionKey: string } | undefined;
  if (!row) return;

  // 获取所有 runs，按时间正序
  const runs = db
    .prepare(
      `SELECT run_id as runId, prompt_text as promptText, stop_reason as stopReason
       FROM runs WHERE session_key = ? ORDER BY started_at ASC`,
    )
    .all(row.sessionKey) as Array<{
    runId: string;
    promptText: string;
    stopReason: string | null;
  }>;

  const send = (event: ServerEvent) => {
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

    // 读取该 run 的所有 session/update 事件
    const events = db
      .prepare(
        `SELECT payload_json as payloadJson FROM events
         WHERE run_id = ? AND method = 'session/update'
         ORDER BY seq ASC`,
      )
      .all(run.runId) as Array<{ payloadJson: string }>;

    // 合并 agent text、提取 tool calls
    let agentText = '';
    const toolCalls = new Map<string, { name: string; output?: string; error?: boolean }>();

    for (const evt of events) {
      try {
        const payload = JSON.parse(evt.payloadJson);
        const update = payload?.update;
        if (!update) continue;

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
          // 检查是否完成
          const status = `${update.status ?? update.state ?? update.outcome ?? ''}`.toLowerCase();
          if (status.includes('done') || status.includes('complete') || status.includes('success') || status.includes('error') || status.includes('fail')) {
            if (existing) {
              existing.output = update.output ?? status;
              existing.error = status.includes('error') || status.includes('fail');
            }
          }
        }
      } catch {
        // 跳过解析失败的事件
      }
    }

    // 发送合并后的 content
    if (agentText) {
      send({ type: 'content.delta', text: agentText });
    }

    // 发送 tool calls
    for (const [toolCallId, tc] of toolCalls) {
      send({ type: 'tool.call', toolCallId, name: tc.name, input: null });
      if (tc.output !== undefined) {
        send({ type: 'tool.result', toolCallId, output: tc.output, error: tc.error });
      }
    }

    send({ type: 'turn.end', turnId, stopReason: run.stopReason ?? 'end_turn' });
  }
}

/** 从 update 中提取 toolCallId */
function extractToolCallIdFromUpdate(update: any): string | null {
  return update?.toolCallId ?? update?.tool_call_id ?? update?.callId ?? update?.call_id ?? null;
}

async function handleClientEvent(
  conversationId: string,
  event: ClientEvent,
  manager: ConversationManager,
): Promise<void> {
  switch (event.type) {
    case 'prompt': {
      const sink = createSinkForConversation(conversationId);

      // Signal turn begin
      const turnId = `turn-${Date.now()}`;
      broadcast(conversationId, { type: 'turn.begin', turnId });
      broadcast(conversationId, {
        type: 'conversation.status',
        conversationId,
        status: 'busy',
      });

      try {
        await manager.sendPrompt(conversationId, event.text, sink, event.attachments);
        broadcast(conversationId, { type: 'turn.end', turnId, stopReason: 'end_turn' });
      } catch (error: any) {
        broadcast(conversationId, {
          type: 'error',
          message: String(error?.message ?? error),
        });
        broadcast(conversationId, { type: 'turn.end', turnId, stopReason: 'error' });
      } finally {
        broadcast(conversationId, {
          type: 'conversation.status',
          conversationId,
          status: 'idle',
        });
      }
      break;
    }

    case 'approval.response': {
      const result = await manager.handleApproval(
        conversationId,
        event.requestId,
        event.decision,
      );
      if (!result.ok) {
        broadcast(conversationId, { type: 'error', message: result.message });
      }
      break;
    }

    case 'cancel':
      // TODO: implement cancellation when BindingRuntime supports it
      break;
  }
}
