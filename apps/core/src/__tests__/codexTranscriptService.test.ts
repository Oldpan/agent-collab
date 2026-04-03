import { describe, expect, it, vi } from 'vitest';

import type { AgentInfo, ConversationInfo } from '@agent-collab/protocol';
import { createTestDb } from './helpers.js';
import { CodexTranscriptService } from '../services/codexTranscriptService.js';
import type { Db } from '@agent-collab/runtime-acp';

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
     VALUES(?, 'codex-acp', '[]', ?, 1, ?, ?, ?, ?)`,
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

describe('CodexTranscriptService', () => {
  it('应按 workspacePath 和 exact replyTarget 过滤 Codex transcript turns', async () => {
    const db = createTestDb();
    const conversation: ConversationInfo = {
      id: 'conv-1',
      channelId: 'dm:agent-1',
      replyTarget: 'dm:@alice',
      title: 'Alice DM',
      agentType: 'codex_acp',
      threadKind: 'direct',
      isPrimaryThread: true,
      workspacePath: '/root/.agent-collab/agents/bob',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      nodeId: 'node-1',
      agentId: 'agent-1',
      userId: 'user-1',
    };
    const agent: AgentInfo = {
      agentId: 'agent-1',
      name: 'Bob',
      agentType: 'codex_acp',
      channelId: 'dm:agent-1',
      channelIds: ['dm:agent-1'],
      workspacePath: '/root/.agent-collab/agents/bob',
      createdAt: 1,
      updatedAt: 1,
      description: 'Helpful agent',
      systemPrompt: 'Stay sharp.',
    };

    insertConversationFixtures(db, {
      conversation,
      sessionKey: 'session-1',
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
      'session-1',
      'SYSTEM PROMPT',
      'CONTEXT TEXT',
      'PROMPT TEXT',
      'DISPATCHED PROMPT',
      1000,
      1000,
    );

    const transcript = [
      JSON.stringify({
        timestamp: '2026-04-01T10:47:12.721Z',
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/root/.agent-collab/agents/bob',
          base_instructions: { text: 'You are Codex.' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: '<permissions instructions>' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.054Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[Local Memory]\n# Memory',
            },
            {
              type: 'input_text',
              text: '[Current conversation target]\nreply_target: dm:@alice\n\n[Triggered message metadata]\ntarget: dm:@alice\nsender: @alice',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.055Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '[Current conversation target]\nreply_target: dm:@alice',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.200Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'mcp__chat__send_message',
          arguments: '{"content":"hello","kind":"final"}',
          call_id: 'call-1',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.300Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '[{"type":"text","text":"Message sent"}]',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.400Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 10,
              reasoning_output_tokens: 5,
              total_tokens: 110,
            },
            last_token_usage: {
              input_tokens: 70,
              cached_input_tokens: 12,
              output_tokens: 3,
              reasoning_output_tokens: 1,
              total_tokens: 73,
            },
            model_context_window: 258400,
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:19.054Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-2',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:19.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[Current conversation target]\nreply_target: dm:@other',
            },
          ],
        },
      }),
    ].join('\n');

    const service = new CodexTranscriptService({
      db,
      broker: {
        listFiles: async () => ({
          rootPath: '/root/.codex/sessions',
          truncated: false,
          files: [
            {
              path: '2026/04/01/rollout-1.jsonl',
              size: transcript.length,
              modifiedAt: Date.parse('2026-04-01T10:47:20.000Z'),
            },
          ],
        }),
        readFile: async () => ({
          rootPath: '/root/.codex/sessions',
          path: '2026/04/01/rollout-1.jsonl',
          content: transcript,
          size: transcript.length,
          modifiedAt: Date.parse('2026-04-01T10:47:20.000Z'),
        }),
      } as any,
      getConversationById: (conversationId) => conversationId === conversation.id ? conversation : null,
      getAgentById: (agentId) => agentId === agent.agentId ? agent : null,
      getAcpSessionIdByConversationId: () => null,
    });

    const result = await service.getConversationDebug(conversation.id);
    expect(result.rollouts).toHaveLength(1);
    expect(result.rollouts[0]?.turns).toHaveLength(1);
    expect(result.rollouts[0]?.baseInstructions).toBe('You are Codex.');
    expect(result.rollouts[0]?.preludeDeveloperMessages).toEqual(['<permissions instructions>']);
    expect(result.rollouts[0]?.turns[0]?.replyTarget).toBe('dm:@alice');
    expect(result.rollouts[0]?.turns[0]?.triggerTarget).toBe('dm:@alice');
    expect(result.rollouts[0]?.turns[0]?.inputBlocks).toHaveLength(2);
    expect(result.rollouts[0]?.turns[0]?.functionCalls[0]).toMatchObject({
      name: 'mcp__chat__send_message',
      output: '[{"type":"text","text":"Message sent"}]',
    });
    expect(result.rollouts[0]?.turns[0]?.tokenUsage?.totalTokens).toBe(110);
    expect(result.rollouts[0]?.turns[0]?.tokenUsage?.currentInputTokens).toBe(70);
    expect(result.rollouts[0]?.turns[0]?.tokenUsage?.currentCachedInputTokens).toBe(12);
    expect(result.rollouts[0]?.turns[0]?.platformInput).toMatchObject({
      runId: 'run-1',
      source: 'exact_snapshot',
      systemPromptText: 'SYSTEM PROMPT',
      contextText: 'CONTEXT TEXT',
      promptText: 'PROMPT TEXT',
      dispatchedPromptText: 'DISPATCHED PROMPT',
    });
    expect(result.matchMode).toBe('heuristic');
    expect(result.sessionMatchMissed).toBe(false);
    expect(result.unmatchedPlatformInputs).toEqual([]);
    db.close();
  });

  it('应在 transcript 缺少 model_context_window 时按模型回填 Codex context window', async () => {
    const db = createTestDb();
    const conversation: ConversationInfo = {
      id: 'conv-1',
      channelId: 'dm:agent-1',
      replyTarget: 'dm:@alice',
      title: 'Alice DM',
      agentType: 'codex_acp',
      threadKind: 'direct',
      isPrimaryThread: true,
      workspacePath: '/root/.agent-collab/agents/bob',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      nodeId: 'node-1',
      agentId: 'agent-1',
      userId: 'user-1',
    };
    const agent: AgentInfo = {
      agentId: 'agent-1',
      name: 'Bob',
      agentType: 'codex_acp',
      channelId: 'dm:agent-1',
      channelIds: ['dm:agent-1'],
      workspacePath: '/root/.agent-collab/agents/bob',
      createdAt: 1,
      updatedAt: 1,
      systemPrompt: '',
    };

    insertConversationFixtures(db, {
      conversation,
      sessionKey: 'session-1',
      agent,
    });

    const transcript = [
      JSON.stringify({
        timestamp: '2026-04-01T10:47:12.721Z',
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.054Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          cwd: '/root/.agent-collab/agents/bob',
          model: 'gpt-5.4',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[Current conversation target]\nreply_target: dm:@alice',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.400Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 10,
              reasoning_output_tokens: 5,
              total_tokens: 110,
            },
            last_token_usage: {
              input_tokens: 88,
              cached_input_tokens: 14,
              output_tokens: 2,
              reasoning_output_tokens: 1,
              total_tokens: 90,
            },
          },
        },
      }),
    ].join('\n');

    const service = new CodexTranscriptService({
      db,
      broker: {
        listFiles: async () => ({
          rootPath: '/root/.codex/sessions',
          truncated: false,
          files: [
            {
              path: '2026/04/01/rollout-1.jsonl',
              size: transcript.length,
              modifiedAt: Date.parse('2026-04-01T10:47:20.000Z'),
            },
          ],
        }),
        readFile: async () => ({
          rootPath: '/root/.codex/sessions',
          path: '2026/04/01/rollout-1.jsonl',
          content: transcript,
          size: transcript.length,
          modifiedAt: Date.parse('2026-04-01T10:47:20.000Z'),
        }),
      } as any,
      getConversationById: (conversationId) => conversationId === conversation.id ? conversation : null,
      getAgentById: (agentId) => agentId === agent.agentId ? agent : null,
      getAcpSessionIdByConversationId: () => null,
      getCodexContextWindowByModel: (model) => model === 'gpt-5.4' ? 258400 : undefined,
    });

    const result = await service.getConversationDebug(conversation.id);
    expect(result.rollouts[0]?.model).toBe('gpt-5.4');
    expect(result.rollouts[0]?.turns[0]?.tokenUsage?.modelContextWindow).toBe(258400);
    expect(result.rollouts[0]?.turns[0]?.tokenUsage?.currentInputTokens).toBe(88);
    db.close();
  });

  it('应优先按 acp_session_id 精确过滤 transcript session', async () => {
    const db = createTestDb();
    const conversation: ConversationInfo = {
      id: 'conv-1',
      channelId: 'dm:agent-1',
      replyTarget: 'dm:@alice',
      title: 'Alice DM',
      agentType: 'codex_acp',
      threadKind: 'direct',
      isPrimaryThread: true,
      workspacePath: '/root/.agent-collab/agents/bob',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      nodeId: 'node-1',
      agentId: 'agent-1',
      userId: 'user-1',
    };
    const agent: AgentInfo = {
      agentId: 'agent-1',
      name: 'Bob',
      agentType: 'codex_acp',
      channelId: 'dm:agent-1',
      channelIds: ['dm:agent-1'],
      workspacePath: '/root/.agent-collab/agents/bob',
      createdAt: 1,
      updatedAt: 1,
      systemPrompt: '',
    };

    insertConversationFixtures(db, {
      conversation,
      sessionKey: 'session-1',
      acpSessionId: 'session-current',
      systemPromptText: 'SYSTEM PROMPT',
      agent,
    });

    const transcriptCurrent = [
      JSON.stringify({
        timestamp: '2026-04-01T10:47:12.721Z',
        type: 'session_meta',
        payload: {
          id: 'session-current',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.054Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-current',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T10:47:18.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[Current conversation target]\nreply_target: dm:@alice',
            },
          ],
        },
      }),
    ].join('\n');

    const transcriptOld = [
      JSON.stringify({
        timestamp: '2026-03-31T10:47:12.721Z',
        type: 'session_meta',
        payload: {
          id: 'session-old',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-31T10:47:18.054Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-old',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-31T10:47:18.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[Current conversation target]\nreply_target: dm:@alice',
            },
          ],
        },
      }),
    ].join('\n');

    const service = new CodexTranscriptService({
      db,
      broker: {
        listFiles: async () => ({
          rootPath: '/root/.codex/sessions',
          truncated: false,
          files: [
            {
              path: '2026/04/01/rollout-current.jsonl',
              size: transcriptCurrent.length,
              modifiedAt: Date.parse('2026-04-01T10:47:20.000Z'),
            },
            {
              path: '2026/03/31/rollout-old.jsonl',
              size: transcriptOld.length,
              modifiedAt: Date.parse('2026-03-31T10:47:20.000Z'),
            },
          ],
        }),
        readFile: async (_nodeId: string, transcriptPath: string) => ({
          rootPath: '/root/.codex/sessions',
          path: transcriptPath,
          content: transcriptPath.includes('current') ? transcriptCurrent : transcriptOld,
          size: transcriptPath.includes('current') ? transcriptCurrent.length : transcriptOld.length,
          modifiedAt: transcriptPath.includes('current')
            ? Date.parse('2026-04-01T10:47:20.000Z')
            : Date.parse('2026-03-31T10:47:20.000Z'),
        }),
      } as any,
      getConversationById: (conversationId) => conversationId === conversation.id ? conversation : null,
      getAgentById: (agentId) => agentId === agent.agentId ? agent : null,
      getAcpSessionIdByConversationId: () => 'session-current',
    });

    const result = await service.getConversationDebug(conversation.id);
    expect(result.matchMode).toBe('acp_session_id');
    expect(result.acpSessionId).toBe('session-current');
    expect(result.sessionMatchMissed).toBe(false);
    expect(result.rollouts).toHaveLength(1);
    expect(result.rollouts[0]?.sessionId).toBe('session-current');
    expect(result.rollouts[0]?.path).toContain('rollout-current.jsonl');
    db.close();
  });

  it('在 acp_session_id 未命中时应回退到启发式并按最近日期优先排序', async () => {
    const db = createTestDb();
    const conversation: ConversationInfo = {
      id: 'conv-1',
      channelId: 'dm:agent-1',
      replyTarget: 'dm:@alice',
      title: 'Alice DM',
      agentType: 'codex_acp',
      threadKind: 'direct',
      isPrimaryThread: true,
      workspacePath: '/root/.agent-collab/agents/bob',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      nodeId: 'node-1',
      agentId: 'agent-1',
      userId: 'user-1',
    };
    const agent: AgentInfo = {
      agentId: 'agent-1',
      name: 'Bob',
      agentType: 'codex_acp',
      channelId: 'dm:agent-1',
      channelIds: ['dm:agent-1'],
      workspacePath: '/root/.agent-collab/agents/bob',
      createdAt: 1,
      updatedAt: 1,
      description: 'Helpful agent',
      systemPrompt: 'Stay sharp.',
    };

    insertConversationFixtures(db, {
      conversation,
      sessionKey: 'session-1',
      agent,
    });
    db.prepare(
      `INSERT INTO runs(run_id, session_key, prompt_text, started_at, ended_at, stop_reason, error)
       VALUES
       ('run-recent', 'session-1', 'recent prompt', 2000, 2100, 'end_turn', NULL),
       ('run-older', 'session-1', 'older prompt', 1000, 1100, 'end_turn', NULL)`,
    ).run();

    const transcriptRecent = [
      JSON.stringify({
        timestamp: '2026-04-02T10:47:12.721Z',
        type: 'session_meta',
        payload: {
          id: 'session-recent',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-02T10:47:18.054Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-recent',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-02T10:47:18.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[Current conversation target]\nreply_target: dm:@alice',
            },
          ],
        },
      }),
    ].join('\n');

    const transcriptOlder = [
      JSON.stringify({
        timestamp: '2026-03-31T10:47:12.721Z',
        type: 'session_meta',
        payload: {
          id: 'session-older',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-31T10:47:18.054Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-older',
          cwd: '/root/.agent-collab/agents/bob',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-31T10:47:18.054Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[Current conversation target]\nreply_target: dm:@alice',
            },
          ],
        },
      }),
    ].join('\n');

    const service = new CodexTranscriptService({
      db,
      broker: {
        listFiles: async () => ({
          rootPath: '/root/.codex/sessions',
          truncated: false,
          files: [
            {
              path: '2026/04/02/rollout-recent.jsonl',
              size: transcriptRecent.length,
              modifiedAt: Date.parse('2026-04-02T10:47:20.000Z'),
            },
            {
              path: '2026/03/31/rollout-older.jsonl',
              size: transcriptOlder.length,
              modifiedAt: Date.parse('2026-03-31T10:47:20.000Z'),
            },
          ],
        }),
        readFile: async (_nodeId: string, transcriptPath: string) => ({
          rootPath: '/root/.codex/sessions',
          path: transcriptPath,
          content: transcriptPath.includes('recent') ? transcriptRecent : transcriptOlder,
          size: transcriptPath.includes('recent') ? transcriptRecent.length : transcriptOlder.length,
          modifiedAt: transcriptPath.includes('recent')
            ? Date.parse('2026-04-02T10:47:20.000Z')
            : Date.parse('2026-03-31T10:47:20.000Z'),
        }),
      } as any,
      getConversationById: (conversationId) => conversationId === conversation.id ? conversation : null,
      getAgentById: (agentId) => agentId === agent.agentId ? agent : null,
      getAcpSessionIdByConversationId: () => 'session-missing',
    });

    const result = await service.getConversationDebug(conversation.id);
    expect(result.matchMode).toBe('heuristic');
    expect(result.sessionMatchMissed).toBe(true);
    expect(result.rollouts).toHaveLength(2);
    expect(result.rollouts[0]?.sessionId).toBe('session-recent');
    expect(result.rollouts[1]?.sessionId).toBe('session-older');
    expect(result.rollouts[0]?.turns[0]?.platformInput).toMatchObject({
      runId: 'run-recent',
      source: 'reconstructed',
      promptText: 'recent prompt',
    });
    expect(result.rollouts[1]?.turns[0]?.platformInput).toMatchObject({
      runId: 'run-older',
      source: 'reconstructed',
      promptText: 'older prompt',
    });
    expect(result.rollouts[0]?.turns[0]?.platformInput?.systemPromptText).toContain('"Bob"');
    expect(result.unmatchedPlatformInputs).toEqual([]);
    db.close();
  });

  it('应跳过超过内联大小上限的 transcript 文件，不触发 readFile', async () => {
    const db = createTestDb();
    const conversation: ConversationInfo = {
      id: 'conv-1',
      channelId: 'dm:agent-1',
      replyTarget: 'dm:@alice',
      title: 'Alice DM',
      agentType: 'codex_acp',
      threadKind: 'direct',
      isPrimaryThread: true,
      workspacePath: '/root/.agent-collab/agents/bob',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      nodeId: 'node-1',
      agentId: 'agent-1',
      userId: 'user-1',
    };
    const agent: AgentInfo = {
      agentId: 'agent-1',
      name: 'Bob',
      agentType: 'codex_acp',
      channelId: 'dm:agent-1',
      channelIds: ['dm:agent-1'],
      workspacePath: '/root/.agent-collab/agents/bob',
      createdAt: 1,
      updatedAt: 1,
      systemPrompt: '',
    };

    insertConversationFixtures(db, {
      conversation,
      sessionKey: 'session-1',
      agent,
    });

    const readFile = vi.fn(async () => {
      throw new Error('readFile should not be called for oversized transcripts');
    });

    const service = new CodexTranscriptService({
      db,
      broker: {
        listFiles: async () => ({
          rootPath: '/root/.codex/sessions',
          truncated: false,
          files: [
            {
              path: '2026/04/01/rollout-huge.jsonl',
              size: 2 * 1024 * 1024 + 1,
              modifiedAt: Date.parse('2026-04-01T10:47:20.000Z'),
            },
          ],
        }),
        readFile,
      } as any,
      getConversationById: (conversationId) => conversationId === conversation.id ? conversation : null,
      getAgentById: (agentId) => agentId === agent.agentId ? agent : null,
      getAcpSessionIdByConversationId: () => null,
    });

    const result = await service.getConversationDebug(conversation.id);
    expect(readFile).not.toHaveBeenCalled();
    expect(result.rollouts).toEqual([]);
    db.close();
  });
});
