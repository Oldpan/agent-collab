import { describe, expect, it } from 'vitest';

import type { AgentInfo, ConversationInfo } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createTestDb } from './helpers.js';
import { ClaudeTranscriptService } from '../services/claudeTranscriptService.js';

function insertConversationFixtures(
  db: Db,
  params: {
    conversation: ConversationInfo;
    sessionKey: string;
    acpSessionId?: string | null;
    systemPromptText?: string | null;
    agent: AgentInfo;
  },
): void {
  const { conversation, sessionKey, acpSessionId = null, systemPromptText = null, agent } = params;
  db.prepare(
    `INSERT INTO channels(channel_id, name, workspace_path, description, collaboration_mode, created_at, updated_at)
     VALUES(?, ?, ?, NULL, 'mention_only', ?, ?)`,
  ).run(conversation.channelId, conversation.channelId, conversation.workspacePath, conversation.createdAt, conversation.updatedAt);
  db.prepare(
    `INSERT INTO agents(
       agent_id, name, agent_type, model, reasoning_effort, channel_id, system_prompt, description,
       memory, env_vars, disabled_tool_kinds, node_id, workspace_path, skill_roots, created_at, updated_at
     )
     VALUES(?, ?, ?, NULL, NULL, ?, ?, ?, '', NULL, NULL, ?, ?, NULL, ?, ?)`,
  ).run(
    agent.agentId,
    agent.name,
    agent.agentType,
    agent.channelId,
    agent.systemPrompt ?? '',
    agent.description ?? null,
    conversation.nodeId,
    agent.workspacePath,
    agent.createdAt,
    agent.updatedAt,
  );
  if (conversation.userId) {
    db.prepare(
      `INSERT INTO users(id, username, password_hash, is_admin, created_at, updated_at)
       VALUES(?, ?, 'hash', 0, ?, ?)`,
    ).run(conversation.userId, conversation.userId, conversation.createdAt, conversation.updatedAt);
  }
  db.prepare(
    `INSERT INTO sessions(session_key, agent_command, agent_args_json, acp_session_id, load_supported, cwd, system_prompt_text, created_at, updated_at)
     VALUES(?, 'claude-acp', '[]', ?, 1, ?, ?, ?, ?)`,
  ).run(sessionKey, acpSessionId, conversation.workspacePath, systemPromptText, conversation.createdAt, conversation.updatedAt);
  db.prepare(
    `INSERT INTO conversations(
       id, channel_id, reply_target, title, agent_type, workspace_path, session_key, status,
       thread_kind, is_primary_thread, thread_root_id, env_vars, node_id, agent_id, user_id, created_at, updated_at
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    conversation.id,
    conversation.channelId,
    conversation.replyTarget,
    conversation.title,
    conversation.agentType,
    conversation.workspacePath,
    sessionKey,
    conversation.status,
    conversation.threadKind,
    1,
    conversation.nodeId,
    conversation.agentId,
    conversation.userId ?? null,
    conversation.createdAt,
    conversation.updatedAt,
  );
}

describe('ClaudeTranscriptService', () => {
  it('应解析 claude transcript 并挂接 platform inputs', async () => {
    const db = createTestDb();
    const conversation: ConversationInfo = {
      id: 'conv-1',
      channelId: 'dm:agent-1',
      replyTarget: 'dm:@yanzong',
      title: 'Yanzong DM',
      agentType: 'claude_acp',
      threadKind: 'direct',
      isPrimaryThread: true,
      workspacePath: '/root/.agent-collab/agents/kimi',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      nodeId: 'node-1',
      agentId: 'agent-1',
      userId: 'user-1',
    };
    const agent: AgentInfo = {
      agentId: 'agent-1',
      name: 'Kimi',
      agentType: 'claude_acp',
      channelId: 'dm:agent-1',
      channelIds: ['dm:agent-1'],
      workspacePath: '/root/.agent-collab/agents/kimi',
      createdAt: 1,
      updatedAt: 1,
      description: 'Helpful agent',
      systemPrompt: 'Stay sharp.',
    };

    insertConversationFixtures(db, {
      conversation,
      sessionKey: 'session-1',
      acpSessionId: 'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
      systemPromptText: 'SYSTEM PROMPT',
      agent,
    });
    db.prepare(
      `INSERT INTO runs(run_id, session_key, prompt_text, started_at, ended_at, stop_reason, error)
       VALUES(?, ?, ?, ?, ?, ?, NULL)`,
    ).run('run-1', 'session-1', 'hello original', 1000, 1100, 'end_turn');
    db.prepare(
      `INSERT INTO run_debug_inputs(
         run_id, conversation_id, session_key, dispatch_mode, reply_target,
         acp_session_id, is_fresh_session, is_exact, system_prompt_text, context_text,
         prompt_text, dispatched_prompt_text, created_at, updated_at
       )
       VALUES(?, ?, ?, 'cold_start', ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-1',
      conversation.id,
      'session-1',
      conversation.replyTarget,
      'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
      'SYSTEM PROMPT',
      'CONTEXT TEXT',
      'PROMPT TEXT',
      'DISPATCHED PROMPT',
      1000,
      1000,
    );

    const transcript = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-04-03T10:29:11.982Z',
        sessionId: 'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'turn-1',
        timestamp: '2026-04-03T10:29:12.003Z',
        sessionId: 'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
        cwd: '/root/.agent-collab/agents/kimi',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[Local Memory Guide]\nWorkspace root: `/root/.agent-collab/agents/kimi`' },
            { type: 'text', text: '[Current conversation target]\nreply_target: dm:@yanzong\n\n[Triggered message metadata]\ntarget: dm:@yanzong\nsender: @yanzong' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-04-03T10:29:17.110Z',
        sessionId: 'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
        cwd: '/root/.agent-collab/agents/kimi',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'mcp__chat__send_message',
              input: { content: '你好', kind: 'final' },
            },
          ],
          usage: {
            input_tokens: 16033,
            output_tokens: 5,
          },
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-1',
        timestamp: '2026-04-03T10:29:17.172Z',
        sessionId: 'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
        cwd: '/root/.agent-collab/agents/kimi',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'Message sent to dm:@yanzong.' }],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-2',
        timestamp: '2026-04-03T10:29:19.304Z',
        sessionId: 'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
        cwd: '/root/.agent-collab/agents/kimi',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: '(Empty response)' },
          ],
        },
      }),
    ].join('\n');

    const service = new ClaudeTranscriptService({
      db,
      broker: {
        listFiles: async () => ({
          rootPath: '/root/.agent-collab/agents/kimi/.claude-runtime/projects',
          truncated: false,
          files: [
            {
              path: 'project/session.jsonl',
              size: transcript.length,
              modifiedAt: 2000,
            },
          ],
        }),
        readFile: async () => ({
          rootPath: '/root/.agent-collab/agents/kimi/.claude-runtime/projects',
          path: 'project/session.jsonl',
          content: transcript,
          size: transcript.length,
          modifiedAt: 2000,
        }),
      } as any,
      getConversationById: () => conversation,
      getAgentById: () => agent,
      getAcpSessionIdByConversationId: () => 'dc034127-94cb-4bbe-bb86-c9a1463fb15f',
    });

    const result = await service.getConversationDebug(conversation.id);

    expect(result.provider).toBe('claude');
    expect(result.rollouts).toHaveLength(1);
    expect(result.rollouts[0]?.sessionId).toBe('dc034127-94cb-4bbe-bb86-c9a1463fb15f');
    expect(result.rollouts[0]?.turns).toHaveLength(1);
    expect(result.rollouts[0]?.turns[0]?.replyTarget).toBe('dm:@yanzong');
    expect(result.rollouts[0]?.turns[0]?.inputBlocks).toHaveLength(2);
    expect(result.rollouts[0]?.turns[0]?.functionCalls[0]?.name).toBe('mcp__chat__send_message');
    expect(result.rollouts[0]?.turns[0]?.functionCalls[0]?.output).toContain('Message sent');
    expect(result.rollouts[0]?.turns[0]?.platformInput?.systemPromptText).toBe('SYSTEM PROMPT');
  });
});
