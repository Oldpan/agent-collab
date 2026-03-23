import type { OutboundSink, PermissionUiRequest, UiEvent } from '@agent-collab/runtime-acp';
import type { NodeToCore, ServerEvent } from '@agent-collab/protocol';

type SendFn = (msg: NodeToCore) => void;

/**
 * OutboundSink that forwards agent output to core as run.event / permission.request messages.
 */
export class NodeSink implements OutboundSink {
  constructor(
    private readonly runId: string,
    private readonly conversationId: string,
    private readonly send: SendFn,
  ) {}

  async sendAgentText(text: string): Promise<void> {
    this.emitEvent({ type: 'content.delta', text });
  }

  async sendText(text: string): Promise<void> {
    this.emitEvent({ type: 'content.delta', text });
  }

  async sendThinkingText(text: string): Promise<void> {
    this.emitEvent({ type: 'thinking.delta', text });
  }

  async requestPermission(req: PermissionUiRequest): Promise<void> {
    this.send({
      type: 'permission.request',
      runId: this.runId,
      conversationId: this.conversationId,
      requestId: req.requestId,
      toolName: req.toolName ?? req.toolTitle,
      toolArgs: req.toolArgs ?? null,
      toolKind: req.toolKind,
    });
  }

  async sendUi(event: UiEvent): Promise<void> {
    if (event.kind === 'tool') {
      if (event.stage === 'complete') {
        this.emitEvent({
          type: 'tool.result',
          toolCallId: event.toolCallId ?? '',
          output: event.detail ?? event.status ?? 'done',
          error: event.status === 'error',
        });
      } else {
        this.emitEvent({
          type: 'tool.call',
          toolCallId: event.toolCallId ?? '',
          name: event.title,
          input: event.detail ?? null,
        });
      }
    }
    if (event.kind === 'plan' || event.kind === 'task') {
      const text = event.detail
        ? `\n[${event.kind}] ${event.title}\n${event.detail}\n`
        : `\n[${event.kind}] ${event.title}\n`;
      this.emitEvent({ type: 'content.delta', text });
    }
  }

  async breakTextStream(): Promise<void> {}
  async flush(): Promise<void> {}

  private emitEvent(event: ServerEvent): void {
    this.send({
      type: 'run.event',
      runId: this.runId,
      conversationId: this.conversationId,
      event,
    });
  }
}
