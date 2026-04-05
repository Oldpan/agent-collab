import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';
import {
  getBoundTaskForThread,
  getTaskThreadRootId,
  getThreadBindingForTask,
  getThreadCollaborationSummary,
  syncTaskThreadOwner,
} from '../web/threadTaskBindings.js';
import { upsertTargetParticipant } from '../web/targetParticipants.js';

describe('threadTaskBindings', () => {
  it('只应把 task root thread 识别为 task thread', () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, 'default', 'system', 'system', 'system', '#default', 'Root task', 1, ?)`,
    ).run('abc12345-0000-0000-0000-000000000000', now);

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES(?, 'default', 4, 'Implicit task', 'todo', ?, ?, ?)`,
    ).run('task-implicit', 'abc12345-0000-0000-0000-000000000000', now, now);

    expect(getTaskThreadRootId('abc12345-0000-0000-0000-000000000000')).toBe('abc12345');
    expect(getBoundTaskForThread(db, { channelId: 'default', threadRootId: 'abc12345' })?.taskId).toBe('task-implicit');
    expect(getBoundTaskForThread(db, { channelId: 'default', threadRootId: 'other1234' })).toBeUndefined();
    expect(getThreadBindingForTask(db, 'task-implicit')).toEqual({ channelId: 'default', threadRootId: 'abc12345' });

    db.close();
  });

  it('summary 应优先返回 task root assignee 作为 owner', () => {
    const db = createTestDb();
    const now = Date.now();
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-1', 'Bob', now, now);
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-2', 'Alice', now, now);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('feedbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Bound task', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES(?, 'default', 3, 'Bound task', 'in_progress', 'agent-1', 'Bob', 'feedbeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run('task-bound', now, now);
    upsertTargetParticipant(db, { agentId: 'agent-1', channelId: 'default', threadRootId: 'feedbeef', role: 'owner', lastActiveAt: now });
    upsertTargetParticipant(db, { agentId: 'agent-2', channelId: 'default', threadRootId: 'feedbeef', role: 'participant', lastActiveAt: now });

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId: 'feedbeef' });
    expect(summary.boundTask?.taskNumber).toBe(3);
    expect(summary.ownerName).toBe('Bob');
    expect(summary.participants).toEqual(['Bob', 'Alice']);

    db.close();
  });

  it('summary 应支持用户认领的 task root owner 回退到 assigneeName', () => {
    const db = createTestDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('userbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'User task', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_name, message_id, created_at, updated_at)
       VALUES(?, 'default', 8, 'User task', 'in_progress', 'oldpan', 'userbeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run('task-user-claimed', now, now);

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId: 'userbeef' });
    expect(summary.boundTask?.taskNumber).toBe(8);
    expect(summary.ownerAgentId).toBeNull();
    expect(summary.ownerName).toBe('oldpan');
    expect(summary.participants).toEqual([]);

    db.close();
  });

  it('summary 应只显示 recent participants，过期 owner 不应残留', () => {
    const db = createTestDb();
    const now = Date.now();
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-stale', 'StaleBob', now, now);
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-fresh', 'FreshAlice', now, now);

    upsertTargetParticipant(db, {
      agentId: 'agent-stale',
      channelId: 'default',
      threadRootId: 'plain1234',
      role: 'owner',
      lastActiveAt: now - (16 * 60 * 1000),
    });
    upsertTargetParticipant(db, {
      agentId: 'agent-fresh',
      channelId: 'default',
      threadRootId: 'plain1234',
      role: 'participant',
      lastActiveAt: now,
    });

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId: 'plain1234' });
    expect(summary.boundTask).toBeUndefined();
    expect(summary.ownerName).toBeNull();
    expect(summary.participants).toEqual(['FreshAlice']);

    db.close();
  });

  it('syncTaskThreadOwner 应只同步 task root thread', () => {
    const db = createTestDb();
    const now = Date.now();
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-1', 'Bob', now, now);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('abc12345-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Task root', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES('task-owner', 'default', 1, 'Task root', 'todo', 'abc12345-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);

    syncTaskThreadOwner(db, { taskId: 'task-owner', agentId: 'agent-1', lastActiveAt: now });

    const owner = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = 'agent-1' AND channel_id = 'default' AND thread_root_id = 'abc12345'`,
    ).get() as { role: string } | undefined;
    expect(owner?.role).toBe('owner');

    db.close();
  });
});
