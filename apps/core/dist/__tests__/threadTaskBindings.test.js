import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';
import { bindTaskToThread, getThreadCollaborationSummary } from '../web/threadTaskBindings.js';
import { upsertTargetParticipant } from '../web/targetParticipants.js';
describe('threadTaskBindings', () => {
    it('同一个 thread 只能绑定一个 task', () => {
        const db = createTestDb();
        const now = Date.now();
        db.prepare(`INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES(?, 'default', 1, 'Task A', 'todo', ?, ?)`).run('task-a', now, now);
        db.prepare(`INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES(?, 'default', 2, 'Task B', 'todo', ?, ?)`).run('task-b', now, now);
        expect(bindTaskToThread(db, {
            channelId: 'default',
            threadRootId: 'abcd1234',
            taskId: 'task-a',
            boundAt: now,
        })).toEqual({ ok: true });
        expect(bindTaskToThread(db, {
            channelId: 'default',
            threadRootId: 'abcd1234',
            taskId: 'task-b',
            boundAt: now,
        })).toEqual({ ok: false, reason: 'Thread is already bound to #t1' });
        db.close();
    });
    it('summary 应优先返回绑定 task 的 assignee 作为 owner', () => {
        const db = createTestDb();
        const now = Date.now();
        db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
            .run('agent-1', 'Bob', now, now);
        db.prepare(`INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id) VALUES(?, ?, 'claude_acp', ?, ?, 'default')`)
            .run('agent-2', 'Alice', now, now);
        db.prepare(`INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, created_at, updated_at)
       VALUES(?, 'default', 3, 'Bound task', 'in_progress', 'agent-1', 'Bob', ?, ?)`).run('task-bound', now, now);
        bindTaskToThread(db, { channelId: 'default', threadRootId: 'thread000', taskId: 'task-bound', boundAt: now });
        upsertTargetParticipant(db, { agentId: 'agent-1', channelId: 'default', threadRootId: 'thread000', role: 'owner', lastActiveAt: now });
        upsertTargetParticipant(db, { agentId: 'agent-2', channelId: 'default', threadRootId: 'thread000', role: 'participant', lastActiveAt: now });
        const summary = getThreadCollaborationSummary(db, { channelId: 'default', threadRootId: 'thread000' });
        expect(summary.boundTask?.taskNumber).toBe(3);
        expect(summary.ownerName).toBe('Bob');
        expect(summary.participants).toEqual(['Bob', 'Alice']);
        db.close();
    });
});
