import { describe, expect, it } from 'vitest';

import type { AgentInfo } from '@agent-collab/protocol';
import {
  appendChannelResetMarkers,
  channelMemoryNotePath,
} from '../web/channelMemoryNotes.js';

describe('channelMemoryNotes', () => {
  it('应为每个 agent 写入 channel reset 标记并保留 legacy channels.md', async () => {
    const files = new Map<string, string>();
    files.set('/tmp/tab/notes/channels.md', '# Channel Summaries\n\n## #default\n- older summary');

    const broker = {
      async readFile(_nodeId: string, workspaceRoot: string, relativePath: string) {
        const key = `${workspaceRoot}/${relativePath}`;
        const content = files.get(key);
        if (content === undefined) throw new Error('not_found:Path not found.');
        return {
          path: relativePath,
          content,
          mimeType: relativePath.endsWith('.md') ? 'text/markdown' as const : 'text/plain' as const,
          size: content.length,
          modifiedAt: Date.now(),
        };
      },
      async writeFile(
        _nodeId: string,
        workspaceRoot: string,
        relativePath: string,
        content: string,
        mode: 'overwrite' | 'append',
      ) {
        const key = `${workspaceRoot}/${relativePath}`;
        if (mode === 'append') {
          files.set(key, `${files.get(key) ?? ''}${content}`);
        } else {
          files.set(key, content);
        }
      },
    };

    const agents: AgentInfo[] = [
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

  it('重复 clear-chat 时应只保留最新 reset 标记，并保留已有摘要内容', async () => {
    const files = new Map<string, string>();
    files.set(
      '/tmp/tab/notes/channels/default.md',
      [
        '# Channel: #default',
        '',
        'Durable notes and reset markers for this channel.',
        '',
        '## Summary',
        '- Alice owns deploys',
        '',
        '## History Reset',
        '- Live chat history for #default was cleared at 2026-04-03T15:37:58.634Z.',
        '- Treat older notes in this file as durable memory, not as the currently visible channel transcript.',
        '- If asked what is currently visible in the channel, rely on current chat history or read_history rather than older notes from before this reset.',
        '',
        '## History Reset',
        '- Live chat history for #default was cleared at 2026-04-03T15:58:44.537Z.',
        '- Treat older notes in this file as durable memory, not as the currently visible channel transcript.',
        '- If asked what is currently visible in the channel, rely on current chat history or read_history rather than older notes from before this reset.',
      ].join('\n'),
    );
    files.set(
      '/tmp/tab/notes/channels.md',
      [
        '# Channel Summaries',
        '',
        'Durable summaries and reset markers for joined channels.',
        '',
        '## #default',
        '- older summary',
        '',
        '## #default',
        '- Live chat history was cleared at 2026-04-03T15:37:58.634Z.',
        '- Earlier bullets in this file are durable summaries, not necessarily the currently visible transcript.',
        '',
        '## #default',
        '- Live chat history was cleared at 2026-04-03T15:58:44.537Z.',
        '- Earlier bullets in this file are durable summaries, not necessarily the currently visible transcript.',
      ].join('\n'),
    );

    const broker = {
      async readFile(_nodeId: string, workspaceRoot: string, relativePath: string) {
        const key = `${workspaceRoot}/${relativePath}`;
        const content = files.get(key);
        if (content === undefined) throw new Error('not_found:Path not found.');
        return {
          path: relativePath,
          content,
          mimeType: relativePath.endsWith('.md') ? 'text/markdown' as const : 'text/plain' as const,
          size: content.length,
          modifiedAt: Date.now(),
        };
      },
      async writeFile(
        _nodeId: string,
        workspaceRoot: string,
        relativePath: string,
        content: string,
        _mode: 'overwrite' | 'append',
      ) {
        const key = `${workspaceRoot}/${relativePath}`;
        files.set(key, content);
      },
    };

    const agents: AgentInfo[] = [
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
      clearedAt: Date.UTC(2026, 3, 4, 8, 1, 41, 176),
    });

    const channelNote = files.get('/tmp/tab/notes/channels/default.md') ?? '';
    const legacyNote = files.get('/tmp/tab/notes/channels.md') ?? '';

    expect(channelNote.match(/## History Reset/g)?.length ?? 0).toBe(1);
    expect(channelNote).toContain('2026-04-04T08:01:41.176Z');
    expect(channelNote).toContain('## Summary');
    expect(channelNote).toContain('Alice owns deploys');

    expect(legacyNote.match(/Live chat history was cleared/g)?.length ?? 0).toBe(1);
    expect(legacyNote).toContain('2026-04-04T08:01:41.176Z');
    expect(legacyNote).toContain('older summary');
  });
});
