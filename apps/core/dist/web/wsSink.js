/**
 * OutboundSink that broadcasts ServerEvents to WebSocket clients.
 * The broadcast function is injected by wsHandler to fan out to all
 * connected clients for a given conversation.
 */
export class WsSink {
    broadcast;
    constructor(broadcast) {
        this.broadcast = broadcast;
    }
    async sendAgentText(text) {
        this.broadcast({ type: 'content.delta', text });
    }
    async sendText(text) {
        this.broadcast({ type: 'content.delta', text });
    }
    async sendThinkingText(text) {
        this.broadcast({ type: 'thinking.delta', text });
    }
    async requestPermission(req) {
        this.broadcast({
            type: 'approval.request',
            requestId: req.requestId,
            toolName: req.toolName ?? req.toolTitle,
            toolArgs: req.toolArgs ?? null,
            toolKind: req.toolKind,
        });
    }
    async sendUi(event) {
        if (event.kind === 'tool') {
            if (event.stage === 'complete') {
                const normalizedStatus = event.status === 'cancelled'
                    ? 'cancelled'
                    : event.status === 'error' || event.status === 'failed'
                        ? 'failed'
                        : 'completed';
                const isError = normalizedStatus === 'failed';
                // 工具执行完成 → 发送 tool.result
                this.broadcast({
                    type: 'tool.result',
                    toolCallId: event.toolCallId ?? '',
                    output: event.detail ?? event.status ?? 'done',
                    error: isError,
                    status: normalizedStatus,
                });
            }
            else {
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
    async breakTextStream() {
        // no-op for WebSocket
    }
    async flush() {
        // no-op for WebSocket
    }
}
