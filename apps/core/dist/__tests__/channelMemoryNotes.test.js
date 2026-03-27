import { describe, expect, it } from 'vitest';
import { appendChannelResetMarkers, channelMemoryNotePath, } from '../web/channelMemoryNotes.js';
describe('channelMemoryNotes', () => {
    it('应为每个 agent 追加 channel reset 标记并保留 legacy channels.md', async () => {
        const files = new Map();
        files.set('/tmp/tab/notes/channels.md', '# Channel Summaries\n\n## #default\n- older summary');
        const broker = {
            async readFile(_nodeId, workspaceRoot, relativePath) {
                const key = `${workspaceRoot}/${relativePath}`;
                const content = files.get(key);
                if (content === undefined)
                    throw new Error('not_found:Path not found.');
                return {
                    path: relativePath,
                    content,
                    mimeType: relativePath.endsWith('.md') ? 'text/markdown' : 'text/plain',
                    size: content.length,
                    modifiedAt: Date.now(),
                };
            },
            async writeFile(_nodeId, workspaceRoot, relativePath, content, mode) {
                const key = `${workspaceRoot}/${relativePath}`;
                if (mode === 'append') {
                    files.set(key, `${files.get(key) ?? ''}${content}`);
                }
                else {
                    files.set(key, content);
                }
            },
        };
        const agents = [
            {
                agentId: 'tab',
                name: 'Tab',
                agentType: 'codex_acp',
                channelId: 'default',
                channelIds: ['default'],
                systemPrompt: '',
                nodeId: 'node-1',
                workspacePath: '/tmp/tab',
                createdAt: 0,
                updatedAt: 0,
            },
        ];
        await appendChannelResetMarkers({
            broker,
            agents,
            channelName: 'default',
            clearedAt: Date.UTC(2026, 2, 27, 5, 30, 0),
        });
        const channelNote = files.get(`/tmp/tab/${channelMemoryNotePath('default')}`) ?? '';
        const legacyNote = files.get('/tmp/tab/notes/channels.md') ?? '';
        expect(channelNote).toContain('# Channel: #default');
        expect(channelNote).toContain('Live chat history for #default was cleared');
        expect(legacyNote).toContain('older summary');
        expect(legacyNote).toContain('Live chat history was cleared');
    });
});
