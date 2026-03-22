import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishRun } from '@agent-collab/runtime-acp';
import type { CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';

describe('ExecutionDispatcher', () => {
  let db: Db;
  const sent: Array<{ nodeId: string; msg: CoreToNode }> = [];
  const fakeRegistry = {
    getNode(nodeId: string) {
      return {
        nodeId,
        hostname: 'test-host',
        agentTypes: ['claude_acp', 'codex_acp'],
        version: 'test',
      };
    },
    send(nodeId: string, msg: CoreToNode) {
      sent.push({ nodeId, msg });
      return true;
    },
  };

  let manager: ConversationManager;

  beforeEach(() => {
    db = createTestDb();
    sent.length = 0;
    manager = new ConversationManager({
      db,
      config: createTestConfig(),
      nodeRegistry: fakeRegistry as any,
    });
    manager.start();
  });

  afterEach(() => {
    manager.close();
    db.close();
  });

  it('dispatchToNode 第一次应发送 cold_start + hostKey', async () => {
    const conv = manager.createConversation({
      title: 'Dispatch Test',
      agentType: 'codex_acp',
      nodeId: 'node-1',
    });

    await manager.dispatchToNode(conv.id, 'hello');

    expect(sent).toHaveLength(1);
    expect(sent[0].nodeId).toBe('node-1');
    expect(sent[0].msg.type).toBe('run.dispatch');
    if (sent[0].msg.type !== 'run.dispatch') throw new Error('unexpected message');
    expect(sent[0].msg.dispatchMode).toBe('cold_start');
    expect(sent[0].msg.hostKey).toBe(`conversation:${conv.id}:codex_acp`);
    expect(sent[0].msg.agentType).toBe('codex_acp');
  });

  it('dispatchToNode 后续应发送 resume', async () => {
    const conv = manager.createConversation({
      title: 'Resume Test',
      agentType: 'claude_acp',
      nodeId: 'node-1',
    });

    await manager.dispatchToNode(conv.id, 'first');
    const first = sent[0]?.msg;
    if (!first || first.type !== 'run.dispatch') throw new Error('missing first dispatch');
    finishRun(db, { runId: first.runId, stopReason: 'end_turn' });

    await manager.dispatchToNode(conv.id, 'second');

    const second = sent[1]?.msg;
    if (!second || second.type !== 'run.dispatch') throw new Error('missing second dispatch');
    expect(second.dispatchMode).toBe('resume');
  });

  it('cancelConversationRun 应发送 run.cancel 到节点', () => {
    const conv = manager.createConversation({
      title: 'Cancel Test',
      nodeId: 'node-1',
    });

    const row = db.prepare(
      'SELECT session_key as sessionKey FROM conversations WHERE id = ?'
    ).get(conv.id) as { sessionKey: string };
    db.prepare(
      'INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)'
    ).run('run-1', row.sessionKey, 'hello', Date.now());

    const result = manager.cancelConversationRun(conv.id);

    expect(result.ok).toBe(true);
    expect(result.runId).toBe('run-1');
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toEqual({ type: 'run.cancel', runId: 'run-1' });
  });
});
