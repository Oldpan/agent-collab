import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildThreadShortId } from '@agent-collab/protocol';
import { createTestDb } from './helpers.js';
import {
  getBoundTaskForThread,
  getTaskThreadRootId,
  getThreadBindingForTask,
  getThreadCollaborationSummary,
  syncTaskThreadOwner,
} from '../web/threadTaskBindings.js';
import { TARGET_PARTICIPANT_ACTIVE_WINDOW_MS, upsertTargetParticipant } from '../web/targetParticipants.js';

describe('threadTaskBindings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('只应把 task root thread 识别为 task thread', () => {
    const db = createTestDb();
    const now = Date.now();
    const rootMessageId = 'abc12345-0000-0000-0000-000000000000';
    const threadRootId = buildThreadShortId(rootMessageId);

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, 'default', 'system', 'system', 'system', '#default', 'Root task', 1, ?)`,
    ).run(rootMessageId, now);

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES(?, 'default', 4, 'Implicit task', 'todo', ?, ?, ?)`,
    ).run('task-implicit', rootMessageId, now, now);

    expect(getTaskThreadRootId(rootMessageId)).toBe(threadRootId);
    expect(getBoundTaskForThread(db, { channelId: 'default', threadRootId })?.taskId).toBe('task-implicit');
    expect(getBoundTaskForThread(db, { channelId: 'default', threadRootId: 'other123456789012' })).toBeUndefined();
    expect(getThreadBindingForTask(db, 'task-implicit')).toEqual({ channelId: 'default', threadRootId, threadRootIds: [threadRootId] });

    db.close();
  });

  it('summary 应优先返回 task root assignee 作为 owner', () => {
    const db = createTestDb();
    const now = Date.now();
    const rootMessageId = 'feedbeef-0000-0000-0000-000000000000';
    const threadRootId = buildThreadShortId(rootMessageId);
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
    upsertTargetParticipant(db, { agentId: 'agent-1', channelId: 'default', threadRootId, role: 'owner', lastActiveAt: now });
    upsertTargetParticipant(db, { agentId: 'agent-2', channelId: 'default', threadRootId, role: 'participant', lastActiveAt: now });

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId });
    expect(summary.boundTask?.taskNumber).toBe(3);
    expect(summary.ownerName).toBe('Bob');
    expect(summary.participants).toEqual(['Bob', 'Alice']);

    db.close();
  });

  it('summary 应支持用户认领的 task root owner 回退到 assigneeName', () => {
    const db = createTestDb();
    const now = Date.now();
    const rootMessageId = 'userbeef-0000-0000-0000-000000000000';
    const threadRootId = buildThreadShortId(rootMessageId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('userbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'User task', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_name, message_id, created_at, updated_at)
       VALUES(?, 'default', 8, 'User task', 'in_progress', 'oldpan', 'userbeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run('task-user-claimed', now, now);

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId });
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
      threadRootId: 'plain1234plain567',
      role: 'owner',
      lastActiveAt: now - (16 * 60 * 1000),
    });
    upsertTargetParticipant(db, {
      agentId: 'agent-fresh',
      channelId: 'default',
      threadRootId: 'plain1234plain567',
      role: 'participant',
      lastActiveAt: now,
    });

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId: 'plain1234plain567' });
    expect(summary.boundTask).toBeUndefined();
    expect(summary.ownerAgentId).toBeNull();
    expect(summary.ownerName).toBeNull();
    expect(summary.participants).toEqual(['FreshAlice']);

    db.close();
  });

  it('summary 应在 TTL 边界包含刚好命中的 participant，并排除越界 1ms 的 participant', () => {
    const db = createTestDb();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-boundary', 'BoundaryBob', now, now);
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-expired', 'ExpiredAlice', now, now);

    upsertTargetParticipant(db, {
      agentId: 'agent-boundary',
      channelId: 'default',
      threadRootId: 'plain1234plain567',
      role: 'owner',
      lastActiveAt: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
    });
    upsertTargetParticipant(db, {
      agentId: 'agent-expired',
      channelId: 'default',
      threadRootId: 'plain1234plain567',
      role: 'participant',
      lastActiveAt: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS - 1,
    });

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId: 'plain1234plain567' });
    expect(summary.ownerAgentId).toBe('agent-boundary');
    expect(summary.ownerName).toBe('BoundaryBob');
    expect(summary.participants).toEqual(['BoundaryBob']);

    db.close();
  });

  it('done task thread 即使残留 owner participant 也不应继续暴露 owner', () => {
    const db = createTestDb();
    const now = Date.now();
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-1', 'Bob', now, now);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('donebeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Done task', 1, ?)`,
    ).run(now);
    const threadRootId = buildThreadShortId('donebeef-0000-0000-0000-000000000000');
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES(?, 'default', 9, 'Done task', 'done', 'agent-1', 'Bob', 'donebeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run('task-done', now, now);
    upsertTargetParticipant(db, {
      agentId: 'agent-1',
      channelId: 'default',
      threadRootId,
      role: 'owner',
      lastActiveAt: now,
    });

    const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId });
    expect(summary.boundTask?.taskNumber).toBe(9);
    expect(summary.ownerAgentId).toBeNull();
    expect(summary.ownerName).toBeNull();
    expect(summary.participants).toEqual(['Bob']);

    db.close();
  });

  it('syncTaskThreadOwner 应只同步 task root thread', () => {
    const db = createTestDb();
    const now = Date.now();
    const rootMessageId = 'abc12345-0000-0000-0000-000000000000';
    const threadRootId = buildThreadShortId(rootMessageId);
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
       WHERE agent_id = 'agent-1' AND channel_id = 'default' AND thread_root_id = ?`,
    ).get(threadRootId) as { role: string } | undefined;
    expect(owner?.role).toBe('owner');

    db.close();
  });

  it('syncTaskThreadOwner 在 agentId 为空时应清空 owner 角色', () => {
    const db = createTestDb();
    const now = Date.now();
    const rootMessageId = 'deadbeef-0000-0000-0000-000000000000';
    const threadRootId = buildThreadShortId(rootMessageId);
    db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
      .run('agent-1', 'Bob', now, now);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('deadbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Task root', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES('task-clear-owner', 'default', 11, 'Task root', 'in_progress', 'deadbeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);

    syncTaskThreadOwner(db, { taskId: 'task-clear-owner', agentId: 'agent-1', lastActiveAt: now });
    syncTaskThreadOwner(db, { taskId: 'task-clear-owner', agentId: null, lastActiveAt: now + 1 });

    const participant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = 'agent-1' AND channel_id = 'default' AND thread_root_id = ?`,
    ).get(threadRootId) as { role: string } | undefined;
    expect(participant?.role).toBe('participant');

    db.close();
  });
});
