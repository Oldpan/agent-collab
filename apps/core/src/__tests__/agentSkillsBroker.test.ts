import { describe, expect, it } from 'vitest';

import type { NodeEntry } from '../services/nodeRegistry.js';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { AgentSkillsBroker } from '../services/agentSkillsBroker.js';

describe('AgentSkillsBroker', () => {
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

    const broker = new AgentSkillsBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.listSkills('node-1', ['/skills'], {
      agentType: 'codex_acp',
      workspaceRoot: '/workspace',
    }, null);

    const message = JSON.parse(sent[0] ?? '{}') as {
      requestId: string;
      type: string;
      skillRoots: string[];
      agentType?: string;
      workspaceRoot?: string | null;
    };
    expect(message.type).toBe('skills.list.request');
    expect(message.skillRoots).toEqual(['/skills']);
    expect(message.agentType).toBe('codex_acp');
    expect(message.workspaceRoot).toBe('/workspace');

    broker.handleSkillsListResponse({
      type: 'skills.list.response',
      requestId: message.requestId,
      path: null,
      roots: ['/skills'],
      skills: [
        { name: 'deploy', path: '/skills/deploy/SKILL.md', sourceRoot: '/skills', description: 'deploy flow' },
      ],
      entries: [],
    });

    await expect(promise).resolves.toEqual({
      path: null,
      roots: ['/skills'],
      skills: [
        { name: 'deploy', path: '/skills/deploy/SKILL.md', sourceRoot: '/skills', description: 'deploy flow' },
      ],
      entries: [],
    });
  });

  it('应向 node 发送 read 请求并在响应后 resolve', async () => {
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

    const broker = new AgentSkillsBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.readSkillFile('node-1', ['/skills'], {
      agentType: 'claude_acp',
      workspaceRoot: '/workspace-claude',
    }, '/skills/deploy/SKILL.md');

    const message = JSON.parse(sent[0] ?? '{}') as {
      requestId: string;
      type: string;
      path: string;
      agentType?: string;
      workspaceRoot?: string | null;
    };
    expect(message.type).toBe('skills.read.request');
    expect(message.path).toBe('/skills/deploy/SKILL.md');
    expect(message.agentType).toBe('claude_acp');
    expect(message.workspaceRoot).toBe('/workspace-claude');

    broker.handleSkillsReadResponse({
      type: 'skills.read.response',
      requestId: message.requestId,
      path: '/skills/deploy/SKILL.md',
      content: '# Deploy',
      mimeType: 'text/markdown',
      size: 8,
      modifiedAt: 123,
    });

    await expect(promise).resolves.toEqual({
      path: '/skills/deploy/SKILL.md',
      content: '# Deploy',
      mimeType: 'text/markdown',
      size: 8,
      modifiedAt: 123,
    });
  });

  it('node 断开时应 reject 挂起的 skill 请求', async () => {
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

    const broker = new AgentSkillsBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const promise = broker.listSkills('node-1', ['/skills'], {
      agentType: 'codex_acp',
      workspaceRoot: '/workspace',
    }, null);

    broker.rejectPendingForNode('node-1');

    await expect(promise).rejects.toThrow('Agent node disconnected: node-1');
  });
});
