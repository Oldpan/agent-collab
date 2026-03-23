import type { OutboundSink, PermissionUiRequest, UiEvent } from '@agent-collab/runtime-acp';
import type { ServerEvent } from '@agent-collab/protocol';

/**
 * OutboundSink that broadcasts ServerEvents to WebSocket clients.
 * The broadcast function is injected by wsHandler to fan out to all
 * connected clients for a given conversation.
 */
export class WsSink implements OutboundSink {
  private readonly broadcast: (event: ServerEvent) => void;

  constructor(broadcast: (event: ServerEvent) => void) {
    this.broadcast = broadcast;
  }

  async sendAgentText(text: string): Promise<void> {
    this.broadcast({ type: 'content.delta', text });
  }

  async sendText(text: string): Promise<void> {
    this.broadcast({ type: 'content.delta', text });
  }

  async sendThinkingText(text: string): Promise<void> {
    this.broadcast({ type: 'thinking.delta', text });
  }

  async requestPermission(req: PermissionUiRequest): Promise<void> {
    this.broadcast({
      type: 'approval.request',
      requestId: req.requestId,
      toolName: req.toolName ?? req.toolTitle,
      toolArgs: req.toolArgs ?? null,
      toolKind: req.toolKind,
    });
  }

  async sendUi(event: UiEvent): Promise<void> {
    if (event.kind === 'tool') {
      if (event.stage === 'complete') {
        const isError = event.status === 'error' || event.status === 'failed';
        // 工具执行完成 → 发送 tool.result
        this.broadcast({
          type: 'tool.result',
          toolCallId: event.toolCallId ?? '',
          output: event.detail ?? event.status ?? 'done',
          error: isError,
        });
      } else {
        // 工具开始或更新 → 发送 tool.call
        this.broadcast({
          type: 'tool.call',
          toolCallId: event.toolCallId ?? '',
          name: event.title,
          input: event.detail ?? null,
        });
      }
    }
    // plan/task events → content delta for now
    if (event.kind === 'plan' || event.kind === 'task') {
      const text = event.detail
        ? `\n[${event.kind}] ${event.title}\n${event.detail}\n`
        : `\n[${event.kind}] ${event.title}\n`;
      this.broadcast({ type: 'content.delta', text });
    }
  }

  async breakTextStream(): Promise<void> {
    // no-op for WebSocket
  }

  async flush(): Promise<void> {
    // no-op for WebSocket
  }
}
