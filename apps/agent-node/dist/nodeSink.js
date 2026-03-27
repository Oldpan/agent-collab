/**
 * OutboundSink that forwards agent output to core as run.event / permission.request messages.
 */
export class NodeSink {
    runId;
    conversationId;
    send;
    hooks;
    constructor(runId, conversationId, send, hooks) {
        this.runId = runId;
        this.conversationId = conversationId;
        this.send = send;
        this.hooks = hooks;
    }
    async sendAgentText(text) {
        this.emitEvent({ type: 'content.delta', text });
    }
    async sendText(text) {
        this.emitEvent({ type: 'content.delta', text });
    }
    async sendThinkingText(text) {
        this.emitEvent({ type: 'thinking.delta', text });
    }
    async requestPermission(req) {
        this.hooks?.onPermissionRequest?.();
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
    async sendUi(event) {
        if (event.kind === 'tool') {
            const toolEvent = event;
            if (event.stage === 'complete') {
                const normalizedStatus = event.status === 'cancelled'
                    ? 'cancelled'
                    : event.status === 'error' || event.status === 'failed'
                        ? 'failed'
                        : 'completed';
                const isError = normalizedStatus === 'failed';
                this.emitEvent({
                    type: 'tool.result',
                    toolCallId: event.toolCallId ?? '',
                    output: toolEvent.output ?? event.detail ?? event.status ?? 'done',
                    error: isError,
                    status: normalizedStatus,
                });
            }
            else {
                this.emitEvent({
                    type: 'tool.call',
                    toolCallId: event.toolCallId ?? '',
                    name: event.title,
                    input: toolEvent.input ?? event.detail ?? null,
                });
            }
        }
        if (event.kind === 'plan' || event.kind === 'task') {
            const createdAt = Date.now();
            this.emitEvent({
                type: event.kind === 'plan' ? 'plan.update' : 'task.update',
                title: event.title,
                detail: event.detail,
                createdAt,
            });
            const text = event.detail
                ? `\n[${event.kind}] ${event.title}\n${event.detail}\n`
                : `\n[${event.kind}] ${event.title}\n`;
            this.emitEvent({ type: 'content.delta', text });
        }
    }
    async breakTextStream() { }
    async flush() { }
    emitEvent(event) {
        this.send({
            type: 'run.event',
            runId: this.runId,
            conversationId: this.conversationId,
            event,
        });
    }
}
