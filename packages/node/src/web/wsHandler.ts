import type { WebSocket } from 'ws';
import type { ServerEvent, ClientEvent } from '@agent-collab/wire-types';
import type { ConversationManager } from './conversationManager.js';
import { WsSink } from './wsSink.js';
import { log } from '../logging.js';

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
