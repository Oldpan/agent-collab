import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/index.js';
import {
  buildReplayContextFromRecentRuns,
  createSession,
  migrate,
  openDb,
  updateSessionRuntimeState,
} from '../src/index.js';

describe('buildReplayContextFromRecentRuns', () => {
  const openDbs: Db[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  it('应剥离旧 activation envelope，并使用真实 agent 名而不是 Assistant', () => {
    const db = openDb(join(tmpdir(), `runtime-acp-history-${randomUUID()}.db`));
    migrate(db);
    openDbs.push(db);

    createSession(db, {
      sessionKey: 'session-history-kimi',
      agentCommand: 'codex',
      agentArgs: ['exec'],
      cwd: '/tmp',
      loadSupported: true,
    });
    updateSessionRuntimeState(db, {
      sessionKey: 'session-history-kimi',
      acpSessionId: 'acp-kimi',
      systemPromptText: 'You are "kimi", an AI agent in Agent Collab.',
    });

    db.prepare(
      `INSERT INTO runs(run_id, session_key, prompt_text, started_at, ended_at, stop_reason)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-history-1',
      'session-history-kimi',
      [
        '[Reply contract]',
        'Reply only via mcp__chat__send_message(...).',
        '',
        '[System: Your collaborative thread in #pure-cal-related received a reply from yanzong.]',
        '',
        '[Current conversation target]',
        'reply_target: #pure-cal-related:f550d695',
        '',
        '[Triggered message metadata]',
        'target: #pure-cal-related:f550d695',
        'sender: @yanzong',
        '',
        '[Triggered message body]',
        '再看下机器的内存状态',
      ].join('\n'),
      1000,
      1100,
      'end_turn',
    );
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'session/update', ?, ?)`,
    ).run(
      'run-history-1',
      1,
      JSON.stringify({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text: '当前机器内存状态如下：可用内存很充裕。' },
        },
      }),
      1001,
    );

    const replay = buildReplayContextFromRecentRuns(db, {
      sessionKey: 'session-history-kimi',
      excludeRunId: 'run-current',
      maxRuns: 8,
      maxChars: 4000,
    });

    expect(replay).toContain('Context (previous messages, for continuity after restart/GC):');
    expect(replay).toContain('User: 再看下机器的内存状态');
    expect(replay).toContain('kimi: 当前机器内存状态如下：可用内存很充裕。');
    expect(replay).not.toContain('Assistant:');
    expect(replay).not.toContain('[Current conversation target]');
    expect(replay).not.toContain('[Triggered message metadata]');
    expect(replay).not.toContain('[Triggered message body]');
  });

  it('缺少 system prompt 名称时应回退为 Assistant', () => {
    const db = openDb(join(tmpdir(), `runtime-acp-history-${randomUUID()}.db`));
    migrate(db);
    openDbs.push(db);

    createSession(db, {
      sessionKey: 'session-history-fallback',
      agentCommand: 'codex',
      agentArgs: ['exec'],
      cwd: '/tmp',
      loadSupported: true,
    });

    db.prepare(
      `INSERT INTO runs(run_id, session_key, prompt_text, started_at, ended_at, stop_reason)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run('run-history-2', 'session-history-fallback', 'hello', 2000, 2100, 'end_turn');
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'session/update', ?, ?)`,
    ).run(
      'run-history-2',
      1,
      JSON.stringify({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'hi there' },
        },
      }),
      2001,
    );

    const replay = buildReplayContextFromRecentRuns(db, {
      sessionKey: 'session-history-fallback',
      excludeRunId: 'run-current',
      maxRuns: 4,
      maxChars: 4000,
    });

    expect(replay).toContain('User: hello');
    expect(replay).toContain('Assistant: hi there');
  });
});
