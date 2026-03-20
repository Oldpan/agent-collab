import { describe, it, expect } from 'vitest';
import { WsSink } from '../web/wsSink.js';
import type { ServerEvent } from '@agent-collab/wire-types';

describe('WsSink', () => {
  it('sendAgentText 应广播 content.delta 事件', async () => {
    const events: ServerEvent[] = [];
    const sink = new WsSink((e) => events.push(e));

    await sink.sendAgentText('hello');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'content.delta', text: 'hello' });
  });

  it('sendText 应广播 content.delta 事件', async () => {
    const events: ServerEvent[] = [];
    const sink = new WsSink((e) => events.push(e));

    await sink.sendText('world');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'content.delta', text: 'world' });
  });

  it('requestPermission 应广播 approval.request 事件', async () => {
    const events: ServerEvent[] = [];
    const sink = new WsSink((e) => events.push(e));

    await sink.requestPermission({
      requestId: 'req-1',
      toolName: 'Bash',
      toolTitle: 'Bash Command',
      toolArgs: { command: 'ls' },
      toolKind: 'bash',
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
    const events: ServerEvent[] = [];
    const sink = new WsSink((e) => events.push(e));

    await sink.sendUi({
      kind: 'tool',
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

  it('sendUi plan 事件应广播 content.delta', async () => {
    const events: ServerEvent[] = [];
    const sink = new WsSink((e) => events.push(e));

    await sink.sendUi({ kind: 'plan', title: 'My Plan', detail: 'step 1', stage: 'start' });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('content.delta');
    expect((events[0] as any).text).toContain('[plan]');
    expect((events[0] as any).text).toContain('My Plan');
  });

  it('breakTextStream 和 flush 不应报错', async () => {
    const sink = new WsSink(() => {});
    await expect(sink.breakTextStream()).resolves.toBeUndefined();
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
