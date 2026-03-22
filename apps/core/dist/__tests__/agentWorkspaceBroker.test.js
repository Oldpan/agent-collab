import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../services/nodeRegistry.js';
import { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
describe('AgentWorkspaceBroker', () => {
    it('应向 node 发送 list 请求并在响应后 resolve', async () => {
        const registry = new NodeRegistry();
        const sent = [];
        registry.register({
            nodeId: 'node-1',
            hostname: 'host',
            agentTypes: ['codex_acp'],
            version: '0.1.0',
            ws: {
                readyState: 1,
                send(payload) {
                    sent.push(payload);
                },
            },
            lastSeen: Date.now(),
        });
        const broker = new AgentWorkspaceBroker({ nodeRegistry: registry, timeoutMs: 500 });
        const promise = broker.listDirectory('node-1', '/tmp/bob', 'notes');
        const message = JSON.parse(sent[0] ?? '{}');
        broker.handleWorkspaceListResponse({
            type: 'workspace.list.response',
            requestId: message.requestId,
            relativePath: 'notes',
            entries: [
                {
                    name: 'MEMORY.md',
                    path: 'notes/MEMORY.md',
                    kind: 'file',
                    size: 42,
                    modifiedAt: 123,
                },
            ],
        });
        await expect(promise).resolves.toEqual({
            path: 'notes',
            entries: [
                {
                    name: 'MEMORY.md',
                    path: 'notes/MEMORY.md',
                    kind: 'file',
                    size: 42,
                    modifiedAt: 123,
                },
            ],
        });
    });
    it('node 断开时应 reject 挂起的 workspace 请求', async () => {
        const registry = new NodeRegistry();
        registry.register({
            nodeId: 'node-1',
            hostname: 'host',
            agentTypes: ['codex_acp'],
            version: '0.1.0',
            ws: {
                readyState: 1,
                send() { },
            },
            lastSeen: Date.now(),
        });
        const broker = new AgentWorkspaceBroker({ nodeRegistry: registry, timeoutMs: 500 });
        const promise = broker.readFile('node-1', '/tmp/bob', 'MEMORY.md');
        broker.rejectPendingForNode('node-1');
        await expect(promise).rejects.toThrow('Agent node disconnected: node-1');
    });
});
