import { describe, it, expect } from 'vitest';
import { WsSink } from '../web/wsSink.js';
describe('WsSink', () => {
    it('sendAgentText 应广播 content.delta 事件', async () => {
        const events = [];
        const sink = new WsSink((e) => events.push(e));
        await sink.sendAgentText('hello');
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ type: 'content.delta', text: 'hello' });
    });
    it('sendText 应广播 content.delta 事件', async () => {
        const events = [];
        const sink = new WsSink((e) => events.push(e));
        await sink.sendText('world');
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ type: 'content.delta', text: 'world' });
    });
    it('requestPermission 应广播 approval.request 事件', async () => {
        const events = [];
        const sink = new WsSink((e) => events.push(e));
        await sink.requestPermission({
            requestId: 'req-1',
            toolName: 'Bash',
            toolTitle: 'Bash Command',
            toolArgs: { command: 'ls' },
            toolKind: 'bash',
            uiMode: 'verbose',
            sessionKey: 'test-session',
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            type: 'approval.request',
            requestId: 'req-1',
            toolName: 'Bash',
            toolArgs: { command: 'ls' },
            toolKind: 'bash',
        });
    });
    it('sendUi tool 事件应广播 tool.call', async () => {
        const events = [];
        const sink = new WsSink((e) => events.push(e));
        await sink.sendUi({
            kind: 'tool',
            mode: 'verbose',
            toolCallId: 'tc-1',
            title: 'Read',
            detail: '/tmp/file.txt',
            stage: 'start',
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            type: 'tool.call',
            toolCallId: 'tc-1',
            name: 'Read',
            input: '/tmp/file.txt',
        });
    });
    it('sendUi failed tool 结果应广播 error=true 的 tool.result', async () => {
        const events = [];
        const sink = new WsSink((e) => events.push(e));
        await sink.sendUi({
            kind: 'tool',
            mode: 'verbose',
            toolCallId: 'tc-2',
            title: 'Read MEMORY.md',
            detail: 'error: resource not found',
            stage: 'complete',
            status: 'failed',
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            type: 'tool.result',
            toolCallId: 'tc-2',
            output: 'error: resource not found',
            error: true,
            status: 'failed',
        });
    });
    it('sendUi cancelled tool 结果应广播 cancelled 状态的 tool.result', async () => {
        const events = [];
        const sink = new WsSink((e) => events.push(e));
        await sink.sendUi({
            kind: 'tool',
            mode: 'verbose',
            toolCallId: 'tc-3',
            title: 'Write MEMORY.md',
            detail: 'cancelled',
            stage: 'complete',
            status: 'cancelled',
        });
        expect(events[0]).toEqual({
            type: 'tool.result',
            toolCallId: 'tc-3',
            output: 'cancelled',
            error: false,
            status: 'cancelled',
        });
    });
    it('sendUi plan 事件应双写广播 plan.update 和 legacy content.delta', async () => {
        const events = [];
        const sink = new WsSink((e) => events.push(e));
        await sink.sendUi({ kind: 'plan', mode: 'verbose', title: 'My Plan', detail: 'step 1' });
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            type: 'plan.update',
            title: 'My Plan',
            detail: 'step 1',
        });
        expect(events[1].type).toBe('content.delta');
        expect(events[1].text).toContain('[plan]');
        expect(events[1].text).toContain('My Plan');
    });
    it('breakTextStream 和 flush 不应报错', async () => {
        const sink = new WsSink(() => { });
        await expect(sink.breakTextStream()).resolves.toBeUndefined();
        await expect(sink.flush()).resolves.toBeUndefined();
    });
});
