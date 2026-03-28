import { listTargetParticipants } from './targetParticipants.js';
function normalizeThreadRootId(threadRootId) {
    return threadRootId ?? '';
}
export function getBoundTaskForThread(db, params) {
    const threadRootId = normalizeThreadRootId(params.threadRootId);
    if (!threadRootId)
        return undefined;
    return db.prepare(`SELECT t.task_id as taskId,
            t.channel_id as channelId,
            b.thread_root_id as threadRootId,
            t.task_number as taskNumber,
            t.title as title,
            t.description as description,
            t.status as status,
            t.claimed_by_agent_id as assigneeId,
            t.claimed_by_name as assigneeName,
            b.bound_at as boundAt
     FROM thread_task_bindings b
     JOIN tasks t ON t.task_id = b.task_id
     WHERE b.channel_id = ? AND b.thread_root_id = ?
     LIMIT 1`).get(params.channelId, threadRootId);
}
export function getThreadBindingForTask(db, taskId) {
    return db.prepare(`SELECT channel_id as channelId, thread_root_id as threadRootId
     FROM thread_task_bindings
     WHERE task_id = ?
     LIMIT 1`).get(taskId);
}
export function bindTaskToThread(db, params) {
    const threadRootId = normalizeThreadRootId(params.threadRootId);
    if (!threadRootId) {
        return { ok: false, reason: 'Tasks can only be bound inside a thread' };
    }
    const existingThreadBinding = getBoundTaskForThread(db, {
        channelId: params.channelId,
        threadRootId,
    });
    if (existingThreadBinding && existingThreadBinding.taskId !== params.taskId) {
        return {
            ok: false,
            reason: `Thread is already bound to #t${existingThreadBinding.taskNumber}`,
        };
    }
    const existingTaskBinding = getThreadBindingForTask(db, params.taskId);
    if (existingTaskBinding &&
        (existingTaskBinding.channelId !== params.channelId || existingTaskBinding.threadRootId !== threadRootId)) {
        return {
            ok: false,
            reason: `Task is already bound to thread ${existingTaskBinding.threadRootId}`,
        };
    }
    db.prepare(`INSERT OR IGNORE INTO thread_task_bindings(channel_id, thread_root_id, task_id, bound_at)
     VALUES(?, ?, ?, ?)`).run(params.channelId, threadRootId, params.taskId, params.boundAt ?? Date.now());
    return { ok: true };
}
export function getThreadCollaborationSummary(db, params) {
    const boundTask = getBoundTaskForThread(db, params);
    const participants = listTargetParticipants(db, params);
    const ownerParticipant = participants.find((participant) => participant.role === 'owner');
    return {
        ...(boundTask ? { boundTask } : {}),
        ownerAgentId: boundTask?.assigneeId ?? ownerParticipant?.agentId ?? null,
        ownerName: boundTask?.assigneeName ?? ownerParticipant?.name ?? null,
        participants: participants.map((participant) => participant.name),
    };
}
