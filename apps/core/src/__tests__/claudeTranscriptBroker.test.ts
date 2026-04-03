import { describe, expect, it } from 'vitest';

import type { NodeEntry } from '../services/nodeRegistry.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { ClaudeTranscriptBroker } from '../services/claudeTranscriptBroker.js';

describe('ClaudeTranscriptBroker', () => {
  it('应向 node 发送 list 请求并在响应后 resolve', async () => {
    const registry = new NodeRegistry();
    const sent: string[] = [];

    registry.register({
      nodeId: 'node-1',
      hostname: 'host',
      agentTypes: ['claude_acp'],
      version: '0.1.0',
      ws: {
        readyState: 1,
        send(payload: string) {
          sent.push(payload);
        },
      } as unknown as NodeEntry['ws'],
      lastSeen: Date.now(),
    });

    const broker = new ClaudeTranscriptBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.listFiles('node-1', '/root/.agent-collab/agents/kimi', 50);

    const message = JSON.parse(sent[0] ?? '{}') as { requestId: string; type: string; maxFiles: number; workspaceRoot: string };
    expect(message.type).toBe('claude.transcript.list.request');
    expect(message.maxFiles).toBe(50);
    expect(message.workspaceRoot).toBe('/root/.agent-collab/agents/kimi');

    broker.handleListResponse({
      type: 'claude.transcript.list.response',
      requestId: message.requestId,
      rootPath: '/root/.agent-collab/agents/kimi/.claude-runtime/projects',
      truncated: false,
      files: [
        {
          path: 'project/session.jsonl',
          size: 123,
          modifiedAt: 456,
        },
      ],
    });

    await expect(promise).resolves.toEqual({
      rootPath: '/root/.agent-collab/agents/kimi/.claude-runtime/projects',
      truncated: false,
      files: [
        {
          path: 'project/session.jsonl',
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
      agentTypes: ['claude_acp'],
      version: '0.1.0',
      ws: {
        readyState: 1,
        send() {},
      } as unknown as NodeEntry['ws'],
      lastSeen: Date.now(),
    });

    const broker = new ClaudeTranscriptBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.readFile('node-1', '/root/.agent-collab/agents/kimi', 'project/session.jsonl');

    broker.rejectPendingForNode('node-1');

    await expect(promise).rejects.toThrow('Agent node disconnected: node-1');
  });
});
