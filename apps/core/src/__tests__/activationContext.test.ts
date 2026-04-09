import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers.js';
import { buildTargetActivationContext, ensureDmThreadContextSnapshot } from '../web/activationContext.js';
import { buildChannelActivationContextText } from '../web/channelActivationPrompt.js';
import { TARGET_PARTICIPANT_ACTIVE_WINDOW_MS, upsertTargetParticipant } from '../web/targetParticipants.js';

describe('activationContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('channel root prompt context 应按协同优先级展示 open task board，并忽略 done task', () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_name, created_at, updated_at)
       VALUES
       ('task-1', 'default', 1, 'Backlog follow-up', 'todo', NULL, ?, ?),
       ('task-2', 'default', 2, 'Hotfix rollout', 'in_progress', 'Bob', ?, ?),
       ('task-3', 'default', 3, 'Already done', 'done', 'Alice', ?, ?),
       ('task-4', 'default', 4, 'Need review', 'in_review', 'Alice', ?, ?),
       ('task-5', 'default', 5, 'Document edge cases', 'todo', NULL, ?, ?),
       ('task-6', 'default', 6, 'Refactor prompt builder', 'in_progress', NULL, ?, ?),
       ('task-7', 'default', 7, 'Overflow item', 'todo', NULL, ?, ?)`,
    ).run(now, now, now, now, now, now, now, now, now, now, now, now, now, now);

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-board-reader',
      channelId: 'default',
      replyTarget: '#default',
      triggerSeq: 999,
      threadRootId: null,
    });
    const text = buildChannelActivationContextText({
      target: '#default',
      recentMessages: context.recentMessages,
      unreadCount: context.unreadCount,
      oldestVisibleSeq: context.oldestVisibleSeq,
      participants: context.participants,
      boundTask: context.boundTask,
      openTasks: context.openTasks,
    });

    expect(text).toContain('[Task-message board summary]');
    expect(text).toContain('#2 [in_progress] @Bob — Hotfix rollout');
    expect(text).toContain('#6 [in_progress] unassigned — Refactor prompt builder');
    expect(text).toContain('#4 [in_review] @Alice — Need review');
    expect(text).toContain('#1 [todo] unassigned — Backlog follow-up');
    expect(text).toContain('#5 [todo] unassigned — Document edge cases');
    expect(text).not.toContain('#3 [done]');
    expect(text).not.toContain('Overflow item');

    const hotfixIndex = text.indexOf('#2 [in_progress] @Bob — Hotfix rollout');
    const refactorIndex = text.indexOf('#6 [in_progress] unassigned — Refactor prompt builder');
    const reviewIndex = text.indexOf('#4 [in_review] @Alice — Need review');
    const backlogIndex = text.indexOf('#1 [todo] unassigned — Backlog follow-up');
    const docsIndex = text.indexOf('#5 [todo] unassigned — Document edge cases');
    expect(hotfixIndex).toBeGreaterThanOrEqual(0);
    expect(refactorIndex).toBeGreaterThan(hotfixIndex);
    expect(reviewIndex).toBeGreaterThan(refactorIndex);
    expect(backlogIndex).toBeGreaterThan(reviewIndex);
    expect(docsIndex).toBeGreaterThan(backlogIndex);

    db.close();
  });

  it('task thread prompt context 应同时包含 root、recent history、participants 和 task brief，并抑制 task board summary', () => {
    const db = createTestDb();
    const now = Date.now();
    const threadRootId = 'feedbeef';
    const rootMessageId = 'feedbeef-0000-0000-0000-000000000000';

    db.prepare(
      `INSERT INTO agents(agent_id, name, agent_type, channel_id, created_at, updated_at)
       VALUES
       ('agent-owner', 'TaskOwner', 'claude_acp', 'default', ?, ?),
       ('agent-helper', 'TaskHelper', 'claude_acp', 'default', ?, ?)`,
    ).run(now, now, now, now);

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES
       (?, 'default', 'agent-owner', 'TaskOwner', 'agent', '#default', 'Root task kickoff', 1, ?, NULL),
       ('thread-msg-1', 'default', 'user', 'User', 'user', '#default:feedbeef', 'Can you both take a look?', 2, ?, 'feedbeef'),
       ('thread-msg-2', 'default', 'agent-helper', 'TaskHelper', 'agent', '#default:feedbeef', 'I checked the failing branch already.', 3, ?, 'feedbeef')`,
    ).run(rootMessageId, now, now + 1, now + 2);

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('task-feedbeef', 'default', 9, 'Investigate rollout failure', 'Goal: find the regression cause. Done when the failing path is explained and next steps are proposed.', 'in_progress', 'agent-owner', 'TaskOwner', ?, ?, ?)`,
    ).run(rootMessageId, now, now);

    upsertTargetParticipant(db, {
      agentId: 'agent-owner',
      channelId: 'default',
      threadRootId,
      role: 'owner',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: 'agent-helper',
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-owner',
      channelId: 'default',
      replyTarget: '#default:feedbeef',
      triggerSeq: 4,
      threadRootId,
    });
    const text = buildChannelActivationContextText({
      target: '#default:feedbeef',
      recentMessages: context.recentMessages,
      rootMessage: context.rootMessage,
      unreadCount: context.unreadCount,
      oldestVisibleSeq: context.oldestVisibleSeq,
      participants: context.participants,
      boundTask: context.boundTask,
      openTasks: context.openTasks,
    });

    expect(text).toContain('[Thread root message]');
    expect(text).toContain('Root task kickoff');
    expect(text).toContain('[Recent messages on this exact target]');
    expect(text).toContain('Can you both take a look?');
    expect(text).toContain('I checked the failing branch already.');
    expect(text).toContain('[Active participants on this target]');
    expect(text).toContain('@TaskOwner (owner)');
    expect(text).toContain('@TaskHelper (participant)');
    expect(text).toContain('[Bound task-message for this thread]');
    expect(text).toContain('#9 [in_progress] @TaskOwner — Investigate rollout failure');
    expect(text).toContain('Goal: find the regression cause.');
    expect(text).not.toContain('[Task-message board summary]');

    db.close();
  });

  it('task thread prompt context 在没有 recent agent owner 时应显示用户 owner 的 task brief，但不伪造 active owner participant', () => {
    const db = createTestDb();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('userbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'User task root', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_name, message_id, created_at, updated_at)
       VALUES('task-user-owned', 'default', 11, 'User owned task', 'Goal: keep the owner human, not agent-owned. Done when the prompt shows the human owner clearly.', 'in_progress', 'oldpan', 'userbeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-reader',
      channelId: 'default',
      replyTarget: '#default:userbeef',
      triggerSeq: 2,
      threadRootId: 'userbeef',
    });
    const text = buildChannelActivationContextText({
      target: '#default:userbeef',
      recentMessages: context.recentMessages,
      rootMessage: context.rootMessage,
      unreadCount: context.unreadCount,
      oldestVisibleSeq: context.oldestVisibleSeq,
      participants: context.participants,
      boundTask: context.boundTask,
      openTasks: context.openTasks,
    });

    expect(context.boundTask?.claimedByName).toBe('oldpan');
    expect(context.participants).toEqual([]);
    expect(text).toContain('[Bound task-message for this thread]');
    expect(text).toContain('#11 [in_progress] @oldpan — User owned task');
    expect(text).toContain('Goal: keep the owner human, not agent-owned.');
    expect(text).not.toContain('[Active participants on this target]');
    expect(text).not.toContain('@oldpan (owner)');

    db.close();
  });

  it('active participants prompt 应在 TTL 边界包含刚好命中的 participant，并排除越界 1ms 的 participant', () => {
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
      threadRootId: null,
      role: 'owner',
      lastActiveAt: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
    });
    upsertTargetParticipant(db, {
      agentId: 'agent-expired',
      channelId: 'default',
      threadRootId: null,
      role: 'participant',
      lastActiveAt: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS - 1,
    });

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-reader',
      channelId: 'default',
      replyTarget: '#default',
      triggerSeq: 2,
      threadRootId: null,
    });
    const text = buildChannelActivationContextText({
      target: '#default',
      recentMessages: context.recentMessages,
      unreadCount: context.unreadCount,
      oldestVisibleSeq: context.oldestVisibleSeq,
      participants: context.participants,
      boundTask: context.boundTask,
      openTasks: context.openTasks,
    });

    expect(context.participants).toEqual([
      expect.objectContaining({
        name: 'BoundaryBob',
        role: 'owner',
      }),
    ]);
    expect(text).toContain('[Active participants on this target]');
    expect(text).toContain('@BoundaryBob (owner)');
    expect(text).not.toContain('@ExpiredAlice');

    db.close();
  });

  it('done task thread 即使残留 owner participant，prompt participants 里也不应继续显示 owner', () => {
    const db = createTestDb();
    const now = Date.now();
    const rootMessageId = 'deadbeef-0000-0000-0000-000000000000';

    db.prepare(
      `INSERT INTO agents(agent_id, name, agent_type, channel_id, created_at, updated_at)
       VALUES('agent-owner', 'TaskOwner', 'claude_acp', 'default', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
       VALUES(?, 'default', 'agent-owner', 'TaskOwner', 'agent', '#default', 'Done task root', 1, ?, NULL)`,
    ).run(rootMessageId, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('task-done-thread', 'default', 18, 'Done thread task', 'done', 'agent-owner', 'TaskOwner', ?, ?, ?)`,
    ).run(rootMessageId, now, now);
    upsertTargetParticipant(db, {
      agentId: 'agent-owner',
      channelId: 'default',
      threadRootId: 'deadbeef',
      role: 'owner',
      lastActiveAt: now,
    });

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-owner',
      channelId: 'default',
      replyTarget: '#default:deadbeef',
      triggerSeq: 2,
      threadRootId: 'deadbeef',
    });
    const text = buildChannelActivationContextText({
      target: '#default:deadbeef',
      recentMessages: context.recentMessages,
      rootMessage: context.rootMessage,
      unreadCount: context.unreadCount,
      oldestVisibleSeq: context.oldestVisibleSeq,
      participants: context.participants,
      boundTask: context.boundTask,
      openTasks: context.openTasks,
    });

    expect(context.boundTask?.status).toBe('done');
    expect(context.participants).toEqual([
      expect.objectContaining({
        name: 'TaskOwner',
        role: 'participant',
      }),
    ]);
    expect(text).toContain('[Bound task-message for this thread]');
    expect(text).toContain('#18 [done] @TaskOwner — Done thread task');
    expect(text).toContain('@TaskOwner (participant)');
    expect(text).not.toContain('@TaskOwner (owner)');

    db.close();
  });

  it('DM task-thread context snapshot 应固定保留触发消息，并只截取主 DM 顶层历史', () => {
    const db = createTestDb();
    const now = Date.now();
    const agentId = 'agent-kimi';
    const channelId = `dm:${agentId}`;
    const directTarget = 'dm:@oldpan';
    const threadRootId = 'deadbead';
    const rootMessageId = `${threadRootId}-0000-0000-0000-000000000000`;

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id, message_kind)
       VALUES
       ('trigger-msg-0000-0000-0000-000000000000', ?, 'user-1', 'oldpan', 'user', ?, '请帮我检查一下当前系统显存占用。', 1, ?, NULL, NULL),
       ('agent-msg-2', ?, ?, 'Kimi', 'agent', ?, '我先看看。', 2, ?, NULL, NULL),
       ('agent-msg-3', ?, ?, 'Kimi', 'agent', ?, '正在确认 GPU 进程。', 3, ?, NULL, NULL),
       ('agent-msg-4', ?, ?, 'Kimi', 'agent', ?, '继续收集环境信息。', 4, ?, NULL, NULL),
       ('agent-msg-5', ?, ?, 'Kimi', 'agent', ?, '再看一下显存明细。', 5, ?, NULL, NULL),
       ('agent-msg-6', ?, ?, 'Kimi', 'agent', ?, '确认是否还有残留任务。', 6, ?, NULL, NULL),
       ('agent-msg-7', ?, ?, 'Kimi', 'agent', ?, '整理一下结果。', 7, ?, NULL, NULL),
       ('agent-msg-8', ?, ?, 'Kimi', 'agent', ?, '准备创建任务线程。', 8, ?, NULL, NULL),
       (?, ?, ?, 'Kimi', 'agent', ?, '查看系统显存使用情况', 9, ?, NULL, 'task'),
       ('thread-reply-1', ?, ?, 'Kimi', 'agent', ?, '这是 thread 内的执行更新。', 10, ?, ?, NULL)`,
    ).run(
      channelId, directTarget, now,
      channelId, agentId, directTarget, now + 1,
      channelId, agentId, directTarget, now + 2,
      channelId, agentId, directTarget, now + 3,
      channelId, agentId, directTarget, now + 4,
      channelId, agentId, directTarget, now + 5,
      channelId, agentId, directTarget, now + 6,
      channelId, agentId, directTarget, now + 7,
      rootMessageId, channelId, agentId, `#${channelId}`, now + 8,
      channelId, agentId, `${directTarget}:${threadRootId}`, now + 9, threadRootId,
    );

    const snapshot = ensureDmThreadContextSnapshot(db, {
      channelId,
      directTarget,
      threadRootId,
      rootMessageId,
    });
    const context = buildTargetActivationContext(db, {
      agentId,
      channelId,
      replyTarget: `${directTarget}:${threadRootId}`,
      triggerSeq: 11,
      threadRootId,
    });

    expect(snapshot?.triggerMessageId).toBe('trigger-msg-0000-0000-0000-000000000000');
    expect(snapshot?.messages.map((message) => message.messageId)).toEqual([
      'trigger-msg-0000-0000-0000-000000000000',
      'agent-msg-3',
      'agent-msg-4',
      'agent-msg-5',
      'agent-msg-6',
      'agent-msg-7',
      'agent-msg-8',
    ]);
    expect(context.dmContextSnapshot?.triggerMessageId).toBe('trigger-msg-0000-0000-0000-000000000000');
    expect(context.dmContextSnapshot?.messages.map((message) => message.messageId)).toEqual(
      snapshot?.messages.map((message) => message.messageId),
    );
    expect(context.dmContextSnapshot?.messages.some((message) => message.messageId === 'thread-reply-1')).toBe(false);

    db.close();
  });

  it('主 DM activation context 应包含活跃 DM task threads 摘要', () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id, message_kind)
       VALUES
       ('dm-task-root-11111111-0000-0000-000000000000', 'dm:agent-kimi', 'user-1', 'oldpan', 'user', 'dm:@oldpan', 'Check memory usage', 1, ?, NULL, 'task'),
       ('dm-task-root-22222222-0000-0000-000000000000', 'dm:agent-kimi', 'user-1', 'oldpan', 'user', 'dm:@oldpan', 'Inspect gpu status', 2, ?, NULL, 'task')`,
    ).run(now, now + 1);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_name, message_id, created_at, updated_at)
       VALUES
       ('task-1', 'dm:agent-kimi', 1, 'Check memory usage', 'in_progress', 'Kimi', 'dm-task-root-11111111-0000-0000-000000000000', ?, ?),
       ('task-2', 'dm:agent-kimi', 2, 'Inspect gpu status', 'in_review', 'Kimi', 'dm-task-root-22222222-0000-0000-000000000000', ?, ?)`,
    ).run(now, now + 10, now, now + 20);

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-kimi',
      channelId: 'dm:agent-kimi',
      replyTarget: 'dm:@oldpan',
      triggerSeq: 3,
      threadRootId: null,
    });

    expect(context.dmActiveTaskThreads).toEqual([
      {
        taskNumber: 2,
        title: 'Inspect gpu status',
        status: 'in_review',
        claimedByName: 'Kimi',
        threadTarget: 'dm:@oldpan:dm-task-',
      },
      {
        taskNumber: 1,
        title: 'Check memory usage',
        status: 'in_progress',
        claimedByName: 'Kimi',
        threadTarget: 'dm:@oldpan:dm-task-',
      },
    ]);

    db.close();
  });

  it('主 DM exact-target recent messages 和 unread 统计不应混入其他 target', () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES
       ('branch-msg-1', 'dm:agent-kimi', 'user-1', 'oldpan', 'user', '#default', 'branch hello', 1, ?),
       ('dm-msg-1', 'dm:agent-kimi', 'user-1', 'oldpan', 'user', 'dm:@oldpan', 'dm hello', 2, ?),
       ('dm-msg-2', 'dm:agent-kimi', 'agent-kimi', 'kimi', 'agent', 'dm:@oldpan', 'dm reply', 3, ?)`,
    ).run(now, now + 1, now + 2);

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-kimi',
      channelId: 'dm:agent-kimi',
      replyTarget: 'dm:@oldpan',
      triggerSeq: 4,
      threadRootId: null,
    });

    expect(context.recentMessages.map((message) => message.messageId)).toEqual(['dm-msg-1', 'dm-msg-2']);
    expect(context.recentMessages.every((message) => message.target === 'dm:@oldpan')).toBe(true);
    expect(context.oldestVisibleSeq).toBe(2);
    expect(context.unreadCount).toBe(0);

    db.close();
  });

  it('activation context 应过滤纯 [plan]/[task] updated 噪音消息', () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES
       ('dm-noise-user', 'dm:agent-kimi', 'user-1', 'oldpan', 'user', 'dm:@oldpan', '先看下当前服务状态', 1, ?),
       ('dm-noise-plan', 'dm:agent-kimi', 'agent-kimi', 'kimi', 'agent', 'dm:@oldpan', '[plan] Plan updated', 2, ?),
       ('dm-noise-task', 'dm:agent-kimi', 'agent-kimi', 'kimi', 'agent', 'dm:@oldpan', '[task] Task updated', 3, ?),
       ('dm-keep-agent', 'dm:agent-kimi', 'agent-kimi', 'kimi', 'agent', 'dm:@oldpan', '我先检查服务进程和健康状态。', 4, ?)`,
    ).run(now, now + 1, now + 2, now + 3);

    const context = buildTargetActivationContext(db, {
      agentId: 'agent-kimi',
      channelId: 'dm:agent-kimi',
      replyTarget: 'dm:@oldpan',
      triggerSeq: 5,
      threadRootId: null,
    });
    const text = buildChannelActivationContextText({
      target: 'dm:@oldpan',
      recentMessages: context.recentMessages,
      unreadCount: context.unreadCount,
      oldestVisibleSeq: context.oldestVisibleSeq,
    });

    expect(context.recentMessages.map((message) => message.messageId)).toEqual([
      'dm-noise-user',
      'dm-keep-agent',
    ]);
    expect(text).toContain('先看下当前服务状态');
    expect(text).toContain('我先检查服务进程和健康状态。');
    expect(text).not.toContain('Plan updated');
    expect(text).not.toContain('Task updated');

    db.close();
  });
});
