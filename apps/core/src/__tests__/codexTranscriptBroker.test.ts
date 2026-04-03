import { describe, expect, it } from 'vitest';

import type { NodeEntry } from '../services/nodeRegistry.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { CodexTranscriptBroker } from '../services/codexTranscriptBroker.js';

describe('CodexTranscriptBroker', () => {
  it('应向 node 发送 list 请求并在响应后 resolve', async () => {
    const registry = new NodeRegistry();
    const sent: string[] = [];

    registry.register({
      nodeId: 'node-1',
      hostname: 'host',
      agentTypes: ['codex_acp'],
      version: '0.1.0',
      ws: {
        readyState: 1,
        send(payload: string) {
          sent.push(payload);
        },
      } as unknown as NodeEntry['ws'],
      lastSeen: Date.now(),
    });

    const broker = new CodexTranscriptBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.listFiles('node-1', 50);

    const message = JSON.parse(sent[0] ?? '{}') as { requestId: string; type: string; maxFiles: number };
    expect(message.type).toBe('codex.transcript.list.request');
    expect(message.maxFiles).toBe(50);

    broker.handleListResponse({
      type: 'codex.transcript.list.response',
      requestId: message.requestId,
      rootPath: '/root/.codex/sessions',
      truncated: false,
      files: [
        {
          path: '2026/04/01/rollout-1.jsonl',
          size: 123,
          modifiedAt: 456,
        },
      ],
    });

    await expect(promise).resolves.toEqual({
      rootPath: '/root/.codex/sessions',
      truncated: false,
      files: [
        {
          path: '2026/04/01/rollout-1.jsonl',
          size: 123,
          modifiedAt: 456,
        },
      ],
    });
  });

  it('node 断开时应 reject 挂起的 transcript 请求', async () => {
    const registry = new NodeRegistry();
    registry.register({
      nodeId: 'node-1',
      hostname: 'host',
      agentTypes: ['codex_acp'],
      version: '0.1.0',
      ws: {
        readyState: 1,
        send() {},
      } as unknown as NodeEntry['ws'],
      lastSeen: Date.now(),
    });

    const broker = new CodexTranscriptBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.readFile('node-1', '2026/04/01/rollout-1.jsonl');

    broker.rejectPendingForNode('node-1');

    await expect(promise).rejects.toThrow('Agent node disconnected: node-1');
  });
});
