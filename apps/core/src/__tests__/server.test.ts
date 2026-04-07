import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, createTestConfig } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { startServer } from '../web/server.js';
import type { Db } from '@agent-collab/runtime-acp';
import { createRun } from '@agent-collab/runtime-acp';
import WebSocket from 'ws';
import { findMentionedAgents } from '../web/channelMentions.js';
import { buildChannelActivationPrompt, buildChannelActivationContextText } from '../web/channelActivationPrompt.js';
import { buildTargetActivationContext } from '../web/activationContext.js';
import { bumpAgentMessageCheckpoint } from '../web/messageCheckpoints.js';
import { listChannelSubscriptions } from '../web/channelSubscriptions.js';
import {
  listRecentTargetParticipants,
  TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  upsertTargetParticipant,
} from '../web/targetParticipants.js';
import { allocateNextChannelMessageSeq } from '../web/channelMessageSequences.js';
import { allocateNextTaskNumber } from '../web/taskNumbers.js';
import {
  getThreadCollaborationSummary,
  listChannelTasks,
  getChannelTaskByNumber,
  clearTaskThreadState,
  syncTaskThreadOwner,
} from '../web/threadTaskBindings.js';
import { isValidTransition } from '../web/taskStatusTransitions.js';
import type { TaskInfo } from '@agent-collab/protocol';

type TestTaskClaimRow = {
  taskId: string;
  currentStatus: TaskInfo['status'];
  claimedByAgentId: string | null;
  claimedByName: string | null;
};

type TestTaskAssignmentRow = TestTaskClaimRow & {
  title: string;
  description: string | null;
  messageId: string | null;
};

function normalizeRequiredText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function deriveTaskTitle(title: unknown, fallbackContent: string): string | null {
  const explicit = normalizeRequiredText(title);
  if (explicit) return explicit;
  const fallback = fallbackContent.trim();
  return fallback ? fallback.slice(0, 120) : null;
}

function shouldSyncTaskRootMessageContent(taskCreatedAt: number, messageId: string | null, messageCreatedAt: number | null): boolean {
  return !!messageId && messageCreatedAt != null && taskCreatedAt === messageCreatedAt;
}

function buildAgentTaskKickoffPrompt(params: {
  agentName: string;
  taskNumber: number;
  title: string;
  description: string;
}): string {
  return [
    `@${params.agentName} you have been assigned task #${params.taskNumber}: ${params.title}`,
    "",
    "Task brief / goal / done criteria:",
    params.description,
    "",
    "Please start working from this thread, post progress updates here, and move the task to in_review when the implementation is ready.",
  ].join("\n");
}

function getTaskUserName(req: { headers: Record<string, unknown> }): string {
  const header = req.headers['x-user-name'];
  return typeof header === 'string' && header.trim() ? header.trim() : 'User';
}

function isTaskClaimedByUserName(task: TestTaskClaimRow, userName: string): boolean {
  return !task.claimedByAgentId && task.claimedByName === userName;
}

function isTaskClaimedByOtherUserName(task: TestTaskClaimRow, userName: string): boolean {
  return !!task.claimedByAgentId || (!!task.claimedByName && task.claimedByName !== userName);
}

let db: Db;
let manager: ConversationManager;
let baseUrl: string;
let serverClose: () => Promise<void>;

beforeAll(async () => {
  db = createTestDb();
  const config = createTestConfig();
  manager = new ConversationManager({ db, config });
  manager.start();

  // startServer 返回 void，但我们需要拿到 app 实例来获取端口和关闭
  // 直接构造 server
  const { default: Fastify } = await import('fastify');
  const { default: fastifyCors } = await import('@fastify/cors');
  const { default: fastifyWebSocket } = await import('@fastify/websocket');
  const { handleWebSocket } = await import('../web/wsHandler.js');

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebSocket);

  // REST routes
  app.get('/api/conversations', async () => manager.listConversations());
  app.get('/api/channels', async () => manager.listChannels());
  app.get<{ Params: { id: string } }>('/api/conversations/:id/history', async (req, reply) => {
    const conv = manager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }

    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(req.params.id) as { sessionKey: string } | undefined;

    if (!sessionRow) return [];

    const runs = db
      .prepare(
        `SELECT run_id as runId, prompt_text as promptText, started_at as startedAt,
                ended_at as endedAt, stop_reason as stopReason, error
         FROM runs WHERE session_key = ? ORDER BY started_at ASC`,
      )
      .all(sessionRow.sessionKey) as Array<{
      runId: string;
      promptText: string;
      startedAt: number;
      endedAt: number | null;
      stopReason: string | null;
      error: string | null;
    }>;

    return runs.map((run) => {
      const nodeEvents = db
        .prepare(
          `SELECT payload_json as payloadJson
           FROM events
           WHERE run_id = ? AND method = 'node/event'
           ORDER BY seq ASC`,
        )
        .all(run.runId) as Array<{ payloadJson: string }>;

      let assistantText = '';
      let thinkingText = '';
      for (const evt of nodeEvents) {
        try {
          const parsed = JSON.parse(evt.payloadJson) as { type?: string; text?: string };
          if (parsed?.type === 'content.delta' && typeof parsed.text === 'string') assistantText += parsed.text;
          if (parsed?.type === 'thinking.delta' && typeof parsed.text === 'string') thinkingText += parsed.text;
        } catch {
          // ignore malformed rows
        }
      }

      return {
        ...run,
        assistantText: assistantText || undefined,
        thinkingText: thinkingText || undefined,
      };
    });
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/cancel', async (req, reply) => {
    const conv = manager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }
    const result = manager.cancelConversationRun(req.params.id);
    if (!result.ok) {
      reply.code(409);
      return { error: result.message };
    }
    return { ok: true, ...(result.runId ? { runId: result.runId } : {}) };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/conversations/:id/channel-messages',
    async (req, reply) => {
      const conv = manager.getConversation(req.params.id);
      if (!conv) {
        reply.code(404);
        return { error: 'Not found' };
      }
      if (!conv.agentId) return { messages: [] };

      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const rows = db.prepare(
        `SELECT message_id as id, sender_name as senderName, sender_type as senderType,
                content, created_at as createdAt, seq
         FROM channel_messages
         WHERE channel_id = ?
         ORDER BY seq DESC LIMIT ?`,
      ).all(`dm:${conv.agentId}`, limit) as Array<{
        id: string;
        senderName: string;
        senderType: string;
        content: string;
        createdAt: number;
        seq: number;
      }>;

      return {
        messages: rows.reverse().map((row) => ({
          id: row.id,
          senderName: row.senderName,
          senderType: row.senderType as 'user' | 'agent' | 'system',
          content: row.content,
          createdAt: new Date(row.createdAt).toISOString(),
          seq: row.seq,
        })),
      };
    },
  );

  app.post<{ Body: any }>('/api/unread-summary', async (req) => {
    const body = (req.body ?? {}) as {
      agentIds?: unknown;
      channelIds?: unknown;
      agentDmReadSeqs?: unknown;
      channelReadSeqs?: unknown;
    };
    const agentIds = Array.isArray(body.agentIds) ? body.agentIds.filter((value: unknown): value is string => typeof value === 'string') : [];
    const channelIds = Array.isArray(body.channelIds) ? body.channelIds.filter((value: unknown): value is string => typeof value === 'string') : [];
    const agentDmReadSeqs: Record<string, unknown> =
      body.agentDmReadSeqs && typeof body.agentDmReadSeqs === 'object'
        ? (body.agentDmReadSeqs as Record<string, unknown>)
        : {};
    const channelReadSeqs: Record<string, unknown> =
      body.channelReadSeqs && typeof body.channelReadSeqs === 'object'
        ? (body.channelReadSeqs as Record<string, unknown>)
        : {};

    const summarizeChannel = (channelId: string, lastReadSeq: number) => {
      const row = db.prepare(
        `SELECT
           COALESCE(MAX(seq), 0) as latestSeq,
           COALESCE(SUM(CASE WHEN seq > ? AND sender_type != 'user' THEN 1 ELSE 0 END), 0) as unreadCount
         FROM channel_messages
         WHERE channel_id = ?`,
      ).get(lastReadSeq, channelId) as { latestSeq: number | null; unreadCount: number | null };
      return {
        unreadCount: Number(row?.unreadCount ?? 0),
        latestSeq: Number(row?.latestSeq ?? 0),
      };
    };

    return {
      agentDms: Object.fromEntries(
        agentIds.map((agentId: string) => [
          agentId,
          summarizeChannel(`dm:${agentId}`, Math.max(0, Number(agentDmReadSeqs[agentId] ?? 0))),
        ]),
      ),
      channels: Object.fromEntries(
        channelIds.map((channelId: string) => [
          channelId,
          summarizeChannel(channelId, Math.max(0, Number(channelReadSeqs[channelId] ?? 0))),
        ]),
      ),
    };
  });

  app.post<{ Body: any }>('/api/channels', async (req, reply) => {
    const body = (req.body ?? {}) as any;
    if (!body.name) {
      reply.code(400);
      return { error: 'name is required' };
    }
    try {
      const channel = manager.createChannel({
        name: body.name,
        workspacePath: body.workspacePath,
        description: body.description,
        collaborationMode: body.collaborationMode,
      });
      for (const agentId of body.agentIds ?? []) {
        if (manager.getAgent(agentId)) manager.joinChannel(agentId, channel.channelId);
      }
      reply.code(201);
      return manager.getChannel(channel.channelId) ?? channel;
    } catch {
      reply.code(409);
      return { error: 'Channel name already exists' };
    }
  });

  app.post<{ Params: { id: string; agentId: string } }>(
    '/api/channels/:id/agents/:agentId',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) {
        reply.code(404);
        return { error: 'Channel not found' };
      }
      const agent = manager.getAgent(req.params.agentId);
      if (!agent) {
        reply.code(404);
        return { error: 'Agent not found' };
      }
      manager.joinChannel(req.params.agentId, req.params.id);
      return manager.getChannel(req.params.id);
    },
  );

  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/channels/:id/agents/:agentId',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) {
        reply.code(404);
        return { error: 'Channel not found' };
      }
      manager.leaveChannel(req.params.agentId, req.params.id);
      return manager.getChannel(req.params.id);
    },
  );

  app.post<{ Params: { id: string } }>('/api/channels/:id/clear-chat', async (req, reply) => {
    const channel = manager.getChannel(req.params.id);
    if (!channel) {
      reply.code(404);
      return { error: 'Channel not found' };
    }
    const cleared = manager.clearChannelChat(req.params.id);
    return {
      ok: true,
      clearedConversationIds: cleared.map((item) => item.id),
    };
  });

  app.post<{ Params: { id: string }; Body: { content: string; senderName?: string; replyTo?: string } }>(
    '/api/channels/:id/messages',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) {
        reply.code(404);
        return { error: 'Channel not found' };
      }
      const { content, senderName = 'User', replyTo } = req.body ?? {};
      if (!content) {
        reply.code(400);
        return { error: 'content is required' };
      }

    const now = Date.now();
    const messageId = `msg-${randomUUID()}`;
    const seq = allocateNextChannelMessageSeq(db, req.params.id);
      const threadRootId = replyTo ?? null;
      const target = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
      db.prepare(
        `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
         VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?, NULL, ?)`,
      ).run(messageId, req.params.id, senderName, target, content, seq, now, threadRootId);

      const mentionedAgents = findMentionedAgents(content, manager.listAgents(req.params.id));
      const pendingNotifications = new Map<string, { reason: 'mention' | 'thread_reply' | 'channel_activity'; role: 'owner' | 'participant' }>();
      const reasonPriority = (reason: 'mention' | 'thread_reply' | 'channel_activity'): number => (
        reason === 'mention' ? 3 : reason === 'thread_reply' ? 2 : 1
      );
      const rolePriority = (role: 'owner' | 'participant'): number => (
        role === 'owner' ? 2 : 1
      );
      const queueAgentNotification = (
        agentId: string,
        reason: 'mention' | 'thread_reply' | 'channel_activity',
        role: 'owner' | 'participant',
      ) => {
        const existing = pendingNotifications.get(agentId);
        if (!existing) {
          pendingNotifications.set(agentId, { reason, role });
          return;
        }
        pendingNotifications.set(agentId, {
          reason: reasonPriority(reason) > reasonPriority(existing.reason) ? reason : existing.reason,
          role: rolePriority(role) > rolePriority(existing.role) ? role : existing.role,
        });
      };
      const historyTarget = threadRootId ? `#${channel.name}:${threadRootId}` : `#${channel.name}`;
      const flushAgentNotifications = () => {
        for (const [agentId, { role }] of pendingNotifications.entries()) {
          upsertTargetParticipant(db, {
            agentId,
            channelId: req.params.id,
            threadRootId: threadRootId ?? null,
            role,
            lastActiveAt: now,
          });
        }

        for (const [agentId, { reason }] of pendingNotifications.entries()) {
          const conv = manager.openAgentChannelThread(agentId, req.params.id, threadRootId ?? null);
          if (!conv) continue;
          const activationContext = buildTargetActivationContext(db, {
            agentId,
            channelId: req.params.id,
            replyTarget: conv.replyTarget ?? historyTarget,
            triggerSeq: seq,
            threadRootId: threadRootId ?? null,
          });
          bumpAgentMessageCheckpoint(db, agentId, req.params.id, seq, threadRootId ?? null);
          void manager.submitPrompt(
            conv.id,
            buildChannelActivationPrompt({
              channelName: channel.name,
              target: historyTarget,
              replyTarget: activationContext.replyTarget,
              senderName,
              content,
              reason,
            }),
            {
              recordAsUserMessage: false,
              activationContextText: buildChannelActivationContextText({
                target: historyTarget,
                recentMessages: activationContext.recentMessages,
                rootMessage: activationContext.rootMessage,
                unreadCount: activationContext.unreadCount,
                oldestVisibleSeq: activationContext.oldestVisibleSeq,
                participants: activationContext.participants,
                boundTask: activationContext.boundTask,
                openTasks: activationContext.openTasks,
              }) || undefined,
              replayOverlapRecentMessages: activationContext.recentMessages,
            },
          ).catch(() => {});
        }
      };

      if (threadRootId) {
        const summary = getThreadCollaborationSummary(db, {
          channelId: req.params.id,
          threadRootId,
        });
        const participants = listRecentTargetParticipants(db, {
          channelId: req.params.id,
          threadRootId,
          activeSince: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
        });
        const rootMsg = db.prepare(
          `SELECT sender_id, sender_type FROM channel_messages
           WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
           LIMIT 1`,
        ).get(req.params.id, threadRootId) as { sender_id: string; sender_type: string } | undefined;

        if (summary.ownerAgentId) {
          queueAgentNotification(summary.ownerAgentId, 'thread_reply', 'owner');
        }

        if (participants.length === 0 && !summary.ownerAgentId && rootMsg?.sender_type === 'agent') {
          queueAgentNotification(rootMsg.sender_id, 'thread_reply', 'owner');
        } else {
          for (const participant of participants) {
            queueAgentNotification(participant.agentId, 'thread_reply', participant.role);
          }
        }
      }

      for (const agent of mentionedAgents) {
        queueAgentNotification(agent.agentId, 'mention', threadRootId ? 'participant' : 'owner');
      }

      if (!threadRootId && mentionedAgents.length === 0 && channel.collaborationMode === 'subscribed_agents') {
        const rootParticipants = listRecentTargetParticipants(db, {
          channelId: req.params.id,
          threadRootId: null,
          activeSince: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
        });
        const subscribedAgents = listChannelSubscriptions(db, req.params.id);
        const agentsToWake = rootParticipants.length > 0
          ? rootParticipants.map((participant) => ({
              agentId: participant.agentId,
              role: participant.role,
            }))
          : subscribedAgents.map((agent) => ({
              agentId: agent.agentId,
              role: 'participant' as const,
            }));

        for (const agent of agentsToWake) {
          queueAgentNotification(agent.agentId, 'channel_activity', agent.role);
        }
      }

      flushAgentNotifications();

      reply.code(201);
      return { messageId, seq };
    },
  );

  app.post<{ Body: any }>('/api/conversations', async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const conv = manager.createConversation({
      agentType: body.agentType,
      workspacePath: body.workspacePath,
      title: body.title,
      channelId: body.channelId,
      threadKind: body.threadKind,
      isPrimaryThread: body.isPrimaryThread,
      envVars: body.envVars,
      nodeId: body.nodeId,
      agentId: body.agentId,
    });
    reply.code(201);
    return conv;
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/open-thread', async (req, reply) => {
    const thread = manager.openAgentThread(req.params.id);
    if (!thread) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return thread;
  });

  type AgentTaskListRow = {
    taskId: string;
    channelId: string;
    taskNumber: number;
    title: string;
    description: string | null;
    status: 'todo' | 'in_progress' | 'in_review' | 'done';
    assigneeId: string | null;
    assigneeName: string | null;
    messageId: string | null;
    createdAt: number;
    updatedAt: number;
    channelName: string | null;
  };

  const mapAgentTaskRow = (row: AgentTaskListRow, dmChannelId: string) => {
    const linkedThreadShortId = row.messageId ? row.messageId.slice(0, 8) : null;
    const sourceType = row.channelId === dmChannelId ? 'dm' : 'channel';
    return {
      taskId: row.taskId,
      channelId: row.channelId,
      taskNumber: row.taskNumber,
      title: row.title,
      ...(row.description != null ? { description: row.description } : {}),
      status: row.status,
      assigneeId: row.assigneeId,
      assigneeName: row.assigneeName,
      messageId: row.messageId,
      ...(linkedThreadShortId ? { linkedThreadId: linkedThreadShortId, linkedThreadShortId } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sourceType,
      sourceLabel: sourceType === 'dm' ? 'DM' : `#${row.channelName ?? row.channelId}`,
      ...(row.channelName ? { channelName: row.channelName } : {}),
    };
  };

  const getAgentTaskRowById = (taskId: string) => db.prepare(
    `SELECT t.task_id as taskId,
            t.channel_id as channelId,
            t.task_number as taskNumber,
            t.title as title,
            t.description as description,
            t.status as status,
            t.claimed_by_agent_id as assigneeId,
            t.claimed_by_name as assigneeName,
            t.message_id as messageId,
            t.created_at as createdAt,
            t.updated_at as updatedAt,
            c.name as channelName
     FROM tasks t
     LEFT JOIN channels c ON c.channel_id = t.channel_id
     WHERE t.task_id = ?
     LIMIT 1`,
  ).get(taskId) as AgentTaskListRow | undefined;

  app.get<{ Params: { id: string }; Querystring: { status?: string; scope?: string } }>(
    '/api/agents/:id/tasks',
    async (req, reply) => {
      const agent = manager.getAgent(req.params.id);
      if (!agent) {
        reply.code(404);
        return { error: 'Not found' };
      }
      const status = (req.query.status as 'todo' | 'in_progress' | 'in_review' | 'done' | 'all' | undefined) ?? 'all';
      const scope = (req.query.scope as 'all' | 'channel' | 'dm' | undefined) ?? 'all';
      const dmChannelId = `dm:${req.params.id}`;
      const whereParts = ['claimed_by_agent_id = ?'];
      const params: Array<string> = [req.params.id];
      if (status !== 'all') {
        whereParts.push('status = ?');
        params.push(status);
      }
      if (scope === 'channel') {
        whereParts.push('channel_id != ?');
        params.push(dmChannelId);
      } else if (scope === 'dm') {
        whereParts.push('channel_id = ?');
        params.push(dmChannelId);
      }
      const rows = db.prepare(
        `SELECT t.task_id as taskId,
                t.channel_id as channelId,
                t.task_number as taskNumber,
                t.title as title,
                t.description as description,
                t.status as status,
                t.claimed_by_agent_id as assigneeId,
                t.claimed_by_name as assigneeName,
                t.message_id as messageId,
                t.created_at as createdAt,
                t.updated_at as updatedAt,
                c.name as channelName
         FROM tasks t
         LEFT JOIN channels c ON c.channel_id = t.channel_id
         WHERE ${whereParts.join(' AND ')}
         ORDER BY t.updated_at DESC`,
      ).all(...params) as AgentTaskListRow[];
      return { tasks: rows.map((row) => mapAgentTaskRow(row, dmChannelId)) };
    },
  );

  app.patch<{ Params: { id: string; taskId: string }; Body: { title?: string; description?: string } }>(
    '/api/agents/:id/tasks/:taskId',
    async (req, reply) => {
      const dmChannelId = `dm:${req.params.id}`;
      const title = normalizeRequiredText(req.body?.title);
      const description = normalizeRequiredText(req.body?.description);
      if (!title) { reply.code(400); return { error: 'title is required' }; }
      if (!description) { reply.code(400); return { error: 'description is required' }; }

      const current = db.prepare(
        `SELECT t.task_id as taskId,
                t.channel_id as channelId,
                t.message_id as messageId,
                t.created_at as taskCreatedAt,
                cm.created_at as messageCreatedAt
         FROM tasks t
         LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
         WHERE t.task_id = ?
         LIMIT 1`,
      ).get(req.params.taskId) as {
        taskId: string;
        channelId: string;
        messageId: string | null;
        taskCreatedAt: number;
        messageCreatedAt: number | null;
      } | undefined;
      if (!current || current.channelId !== dmChannelId) {
        reply.code(404);
        return { error: 'DM task not found' };
      }

      db.prepare(
        `UPDATE tasks
         SET title = ?, description = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(title, description, Date.now(), req.params.taskId);
      if (current.messageId && current.taskCreatedAt === current.messageCreatedAt) {
        db.prepare(`UPDATE channel_messages SET content = ? WHERE message_id = ?`).run(title, current.messageId);
      }

      const updated = getAgentTaskRowById(req.params.taskId);
      if (!updated) { reply.code(404); return { error: 'DM task not found' }; }
      return mapAgentTaskRow(updated, dmChannelId);
    },
  );

  app.patch<{ Params: { id: string; taskId: string }; Body: { status?: string } }>(
    '/api/agents/:id/tasks/:taskId/status',
    async (req, reply) => {
      const dmChannelId = `dm:${req.params.id}`;
      const nextStatus = req.body?.status;
      if (nextStatus !== 'todo' && nextStatus !== 'in_progress' && nextStatus !== 'in_review' && nextStatus !== 'done') {
        reply.code(400);
        return { error: 'Invalid status' };
      }
      const current = db.prepare(
        `SELECT task_id as taskId,
                channel_id as channelId,
                status,
                claimed_by_agent_id as assigneeId
         FROM tasks
         WHERE task_id = ?
         LIMIT 1`,
      ).get(req.params.taskId) as {
        taskId: string;
        channelId: string;
        status: 'todo' | 'in_progress' | 'in_review' | 'done';
        assigneeId: string | null;
      } | undefined;
      if (!current || current.channelId !== dmChannelId) {
        reply.code(404);
        return { error: 'DM task not found' };
      }
      if (!isValidTransition(current.status, nextStatus)) {
        reply.code(409);
        return { error: 'Invalid status transition' };
      }

      const now = Date.now();
      db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?`).run(nextStatus, now, req.params.taskId);
      syncTaskThreadOwner(db, {
        taskId: req.params.taskId,
        agentId: nextStatus === 'done' ? null : current.assigneeId,
        lastActiveAt: now,
      });

      const updated = getAgentTaskRowById(req.params.taskId);
      if (!updated) { reply.code(404); return { error: 'DM task not found' }; }
      return mapAgentTaskRow(updated, dmChannelId);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/agents/:id/tasks/:taskId/unclaim',
    async (req, reply) => {
      const dmChannelId = `dm:${req.params.id}`;
      const current = db.prepare(
        `SELECT task_id as taskId, channel_id as channelId
         FROM tasks
         WHERE task_id = ?
         LIMIT 1`,
      ).get(req.params.taskId) as { taskId: string; channelId: string } | undefined;
      if (!current || current.channelId !== dmChannelId) {
        reply.code(404);
        return { error: 'DM task not found' };
      }

      const now = Date.now();
      db.prepare(
        `UPDATE tasks
         SET claimed_by_agent_id = NULL,
             claimed_by_name = NULL,
             status = 'todo',
             updated_at = ?
         WHERE task_id = ?`,
      ).run(now, req.params.taskId);
      syncTaskThreadOwner(db, {
        taskId: req.params.taskId,
        agentId: null,
        lastActiveAt: now,
      });

      const updated = getAgentTaskRowById(req.params.taskId);
      if (!updated) { reply.code(404); return { error: 'DM task not found' }; }
      return mapAgentTaskRow(updated, dmChannelId);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const conv = manager.getConversation(req.params.id);
    if (!conv) {
      reply.code(404);
      return { error: 'Not found' };
    }
    manager.deleteConversation(req.params.id);
    reply.code(204);
    return;
  });

  // Task routes
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/channels/:id/tasks',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const statusFilter = req.query.status as TaskInfo['status'] | 'all' | undefined;
      return { tasks: listChannelTasks(db, { channelId: req.params.id, status: statusFilter }) };
    },
  );

  app.post<{ Params: { id: string }; Body: { title?: string; description?: string } }>(
    '/api/channels/:id/tasks',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }

      const title = normalizeRequiredText(req.body?.title);
      const description = normalizeRequiredText(req.body?.description);
      if (!title) { reply.code(400); return { error: 'title is required' }; }
      if (!description) { reply.code(400); return { error: 'description is required' }; }

      const now = Date.now();
      const taskId = randomUUID();
      const taskNumber = allocateNextTaskNumber(db, req.params.id);
      const messageId = randomUUID();
      const seq = allocateNextChannelMessageSeq(db, req.params.id);

      db.transaction(() => {
        db.prepare(
          `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
           VALUES(?, ?, 'system', 'system', 'system', ?, ?, ?, ?, 'task')`,
        ).run(messageId, req.params.id, `#${channel.name}`, title, seq, now);
        db.prepare(
          `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
        ).run(taskId, req.params.id, taskNumber, title, description, messageId, now, now);
      })();

      reply.code(201);
      return getChannelTaskByNumber(db, { channelId: req.params.id, taskNumber });
    },
  );

  app.post<{ Params: { id: string }; Body: { messageId: string; title?: string; description?: string } }>(
    '/api/channels/:id/tasks/claim-message',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const { messageId, title, description: rawDescription } = req.body ?? {};
      if (!messageId) { reply.code(400); return { error: 'messageId is required' }; }
      const description = normalizeRequiredText(rawDescription);
      if (!description) { reply.code(400); return { error: 'description is required' }; }

      const message = db.prepare(
        `SELECT message_id as messageId, content, thread_root_id as threadRootId
         FROM channel_messages
         WHERE message_id LIKE ? AND channel_id = ?`,
      ).get(`${messageId}%`, req.params.id) as {
        messageId: string;
        content: string;
        threadRootId: string | null;
      } | undefined;
      if (!message) { reply.code(404); return { error: 'Message not found' }; }
      if (message.threadRootId) { reply.code(400); return { error: 'Cannot promote a thread reply to task' }; }

      const existing = db.prepare(
        `SELECT task_id as taskId FROM tasks WHERE message_id = ?`,
      ).get(message.messageId) as { taskId: string } | undefined;
      if (existing) { reply.code(409); return { error: 'Message is already a task' }; }

      const now = Date.now();
      const taskId = randomUUID();
      const taskNumber = allocateNextTaskNumber(db, req.params.id);
      const taskTitle = deriveTaskTitle(title, message.content);
      if (!taskTitle) { reply.code(400); return { error: 'title is required' }; }
      const userName = getTaskUserName(req);

      db.transaction(() => {
        db.prepare(
          `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id,
                             claimed_by_agent_id, claimed_by_name, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, 'in_progress', ?, NULL, ?, ?, ?)`,
        ).run(taskId, req.params.id, taskNumber, taskTitle, description, message.messageId, userName, now, now);
        db.prepare(`UPDATE channel_messages SET message_kind = 'task' WHERE message_id = ?`).run(message.messageId);
        syncTaskThreadOwner(db, { taskId, agentId: null, lastActiveAt: now });
      })();

      reply.code(201);
      return getChannelTaskByNumber(db, { channelId: req.params.id, taskNumber });
    },
  );

  app.patch<{ Params: { id: string; num: string }; Body: { title?: string; description?: string } }>(
    '/api/channels/:id/tasks/:num',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      if (!Number.isFinite(taskNumber)) { reply.code(400); return { error: 'Invalid task number' }; }
      const title = normalizeRequiredText(req.body?.title);
      const description = normalizeRequiredText(req.body?.description);
      if (!title) { reply.code(400); return { error: 'title is required' }; }
      if (!description) { reply.code(400); return { error: 'description is required' }; }

      const current = db.prepare(
        `SELECT t.task_id as taskId,
                t.message_id as messageId,
                t.created_at as taskCreatedAt,
                m.created_at as messageCreatedAt
         FROM tasks t
         LEFT JOIN channel_messages m ON m.message_id = t.message_id
         WHERE t.channel_id = ? AND t.task_number = ?`,
      ).get(req.params.id, taskNumber) as {
        taskId: string;
        messageId: string | null;
        taskCreatedAt: number;
        messageCreatedAt: number | null;
      } | undefined;
      if (!current) { reply.code(404); return { error: 'Task not found' }; }

      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          `UPDATE tasks SET title = ?, description = ?, updated_at = ? WHERE task_id = ?`,
        ).run(title, description, now, current.taskId);
        if (shouldSyncTaskRootMessageContent(current.taskCreatedAt, current.messageId, current.messageCreatedAt)) {
          db.prepare(`UPDATE channel_messages SET content = ? WHERE message_id = ?`).run(title, current.messageId);
        }
      })();

      return getChannelTaskByNumber(db, { channelId: req.params.id, taskNumber });
    },
  );

  app.post<{ Params: { id: string; num: string }; Body: { agentId?: string } }>(
    '/api/channels/:id/tasks/:num/claim',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      if (!Number.isFinite(taskNumber)) { reply.code(400); return { error: 'Invalid task number' }; }

      const current = db.prepare(
        `SELECT task_id as taskId,
                title,
                description,
                message_id as messageId,
                status as currentStatus,
                claimed_by_agent_id as claimedByAgentId,
                claimed_by_name as claimedByName
         FROM tasks
         WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber) as TestTaskAssignmentRow | undefined;
      if (!current) { reply.code(404); return { error: 'Task not found' }; }
      if (current.currentStatus === 'done') { reply.code(409); return { error: 'Task is already done' }; }
      const requestedAgentId = typeof req.body?.agentId === 'string' && req.body.agentId.trim()
        ? req.body.agentId.trim()
        : null;
      const userName = getTaskUserName(req);

      const now = Date.now();
      const nextStatus = current.currentStatus === 'todo' ? 'in_progress' : current.currentStatus;
      if (requestedAgentId) {
        const agent = manager.getAgent(requestedAgentId);
        if (!agent) { reply.code(404); return { error: 'Agent not found' }; }
        if (!(agent.channelIds ?? []).includes(req.params.id)) {
          reply.code(400);
          return { error: 'Agent is not a member of this channel' };
        }
        if (!current.messageId) {
          reply.code(409);
          return { error: 'Task has no task thread to notify' };
        }
        const description = normalizeRequiredText(current.description);
        if (!description) {
          reply.code(409);
          return { error: 'Task brief is required before assigning to an agent' };
        }
        if (!current.claimedByAgentId && current.claimedByName && current.claimedByName !== userName) {
          reply.code(409);
          return { error: 'Task is already claimed by another user' };
        }

        const threadRootId = current.messageId.slice(0, 8);
        const kickoffSeq = allocateNextChannelMessageSeq(db, req.params.id);
        db.transaction(() => {
          db.prepare(
            `UPDATE tasks
             SET claimed_by_agent_id = ?, claimed_by_name = ?, status = ?, updated_at = ?
             WHERE task_id = ?`,
          ).run(agent.agentId, agent.name, nextStatus, now, current.taskId);
          syncTaskThreadOwner(db, { taskId: current.taskId, agentId: agent.agentId, lastActiveAt: now });
          db.prepare(
            `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
             VALUES(?, ?, 'user', ?, 'user', ?, ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            req.params.id,
            userName,
            `#${channel.name}:${threadRootId}`,
            buildAgentTaskKickoffPrompt({
              agentName: agent.name,
              taskNumber,
              title: current.title,
              description,
            }),
            kickoffSeq,
            now,
            threadRootId,
          );
        })();
        manager.openAgentChannelThread(agent.agentId, req.params.id, threadRootId);
      } else {
        if (isTaskClaimedByOtherUserName(current, userName)) {
          reply.code(409);
          return { error: 'Task is already claimed' };
        }

        db.transaction(() => {
          db.prepare(
            `UPDATE tasks
             SET claimed_by_agent_id = NULL, claimed_by_name = ?, status = ?, updated_at = ?
             WHERE task_id = ?`,
          ).run(userName, nextStatus, now, current.taskId);
          syncTaskThreadOwner(db, { taskId: current.taskId, agentId: null, lastActiveAt: now });
        })();
      }

      return getChannelTaskByNumber(db, { channelId: req.params.id, taskNumber });
    },
  );

  app.post<{ Params: { id: string; num: string } }>(
    '/api/channels/:id/tasks/:num/unclaim',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      if (!Number.isFinite(taskNumber)) { reply.code(400); return { error: 'Invalid task number' }; }

      const current = db.prepare(
        `SELECT task_id as taskId,
                status as currentStatus,
                claimed_by_agent_id as claimedByAgentId,
                claimed_by_name as claimedByName
         FROM tasks
         WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber) as TestTaskClaimRow | undefined;
      if (!current) { reply.code(404); return { error: 'Task not found' }; }

      const userName = getTaskUserName(req);
      const canUnclaimAgentTask = !!current.claimedByAgentId;
      if (!canUnclaimAgentTask && !isTaskClaimedByUserName(current, userName)) {
        reply.code(403);
        return { error: 'You must be the task assignee to unclaim it' };
      }

      const now = Date.now();
      const nextStatus = current.currentStatus === 'in_progress' ? 'todo' : current.currentStatus;
      db.transaction(() => {
        db.prepare(
          `UPDATE tasks
           SET claimed_by_agent_id = NULL, claimed_by_name = NULL, status = ?, updated_at = ?
           WHERE task_id = ?`,
        ).run(nextStatus, now, current.taskId);
        syncTaskThreadOwner(db, { taskId: current.taskId, agentId: null, lastActiveAt: now });
      })();

      return getChannelTaskByNumber(db, { channelId: req.params.id, taskNumber });
    },
  );

  app.patch<{ Params: { id: string; num: string }; Body: { status: string } }>(
    '/api/channels/:id/tasks/:num/status',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      const { status } = req.body ?? {};
      const validStatuses = ['todo', 'in_progress', 'in_review', 'done'];
      if (!validStatuses.includes(status)) { reply.code(400); return { error: `Invalid status: ${status}` }; }
      const nextStatus = status as TaskInfo['status'];
      const current = db.prepare(
        `SELECT task_id as taskId,
                status as currentStatus,
                claimed_by_agent_id as claimedByAgentId,
                claimed_by_name as claimedByName
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber) as TestTaskClaimRow | undefined;
      if (!current) { reply.code(404); return { error: 'Task not found' }; }
      if (!isValidTransition(current.currentStatus, nextStatus)) {
        reply.code(400); return { error: `Invalid transition: ${current.currentStatus} → ${nextStatus}` };
      }
      const isReviewDecision = current.currentStatus === 'in_review'
        && (nextStatus === 'done' || nextStatus === 'in_progress');
      if (!isReviewDecision && !isTaskClaimedByUserName(current, getTaskUserName(req))) {
        reply.code(403);
        return { error: 'You must be the task assignee to update its status' };
      }
      const now = Date.now();
      db.transaction(() => {
        db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE channel_id = ? AND task_number = ?`).run(nextStatus, now, req.params.id, taskNumber);
        syncTaskThreadOwner(db, { taskId: current.taskId, agentId: nextStatus === 'done' ? null : current.claimedByAgentId, lastActiveAt: now });
      })();
      return getChannelTaskByNumber(db, { channelId: req.params.id, taskNumber });
    },
  );

  app.delete<{ Params: { id: string; num: string } }>(
    '/api/channels/:id/tasks/:num',
    async (req, reply) => {
      const channel = manager.getChannel(req.params.id);
      if (!channel) { reply.code(404); return { error: 'Channel not found' }; }
      const taskNumber = Number(req.params.num);
      const task = db.prepare(
        `SELECT task_id as taskId, message_id as messageId FROM tasks WHERE channel_id = ? AND task_number = ?`,
      ).get(req.params.id, taskNumber) as { taskId: string; messageId: string | null } | undefined;
      if (!task) { reply.code(404); return { error: 'Task not found' }; }
      db.transaction(() => {
        clearTaskThreadState(db, { channelId: req.params.id, taskId: task.taskId });
        db.prepare(`DELETE FROM tasks WHERE task_id = ?`).run(task.taskId);
        if (task.messageId) db.prepare(`UPDATE channel_messages SET message_kind = NULL WHERE message_id = ?`).run(task.messageId);
      })();
      return { ok: true, taskNumber };
    },
  );

  // WebSocket route — 使用 @fastify/websocket 的正确写法
  app.register(async function (fastify) {
    fastify.get<{ Params: { id: string } }>(
      '/api/conversations/:id/stream',
      { websocket: true },
      (socket, req) => {
        handleWebSocket(socket, req.params.id, manager);
      },
    );
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  serverClose = () => app.close();
});

afterAll(async () => {
  manager.close();
  await serverClose();
  db.close();
});

// ─── Helpers ───

async function fetchJson(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/**
 * 创建 WS 连接，同时立即开始收集消息（避免 open 和 message 之间的竞态）。
 * 返回 { ws, events } — events 是一个持续增长的数组。
 */
function createWsConnection(convId: string): Promise<{ ws: WebSocket; events: any[] }> {
  const wsUrl = baseUrl.replace('http', 'ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/api/conversations/${convId}/stream`);
    const events: any[] = [];

    // 注册 message handler 在 open 之前，确保不漏消息
    ws.on('message', (data) => {
      events.push(JSON.parse(data.toString()));
    });

    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}

/** 等待事件数量达到 count */
function waitForEvents(events: any[], count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (events.length >= count) return resolve(events.slice(0, count));

    const timer = setTimeout(
      () => reject(new Error(`Timeout: got ${events.length}/${count} events: ${JSON.stringify(events)}`)),
      timeoutMs,
    );

    // 轮询（简单可靠）
    const interval = setInterval(() => {
      if (events.length >= count) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(events.slice(0, count));
      }
    }, 50);
  });
}

// ─── Tests ───

describe('REST API', () => {
  it('GET /api/conversations 初始为空', async () => {
    const { status, body } = await fetchJson('/api/conversations');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/conversations 创建会话', async () => {
    const { status, body } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude_acp', title: 'API Test' }),
    });

    expect(status).toBe(201);
    expect(body.id).toBeTruthy();
    expect(body.title).toBe('API Test');
    expect(body.agentType).toBe('claude_acp');
    expect(body.status).toBe('idle');
  });

  it('POST /api/conversations 支持 envVars', async () => {
    const envVars = { ANTHROPIC_API_KEY: 'sk-xxx', CUSTOM: 'val' };
    const { status, body } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude_acp', title: 'Env Test', envVars }),
    });

    expect(status).toBe(201);

    // 验证 DB 中存储了 envVars
    const row = db
      .prepare('SELECT env_vars FROM conversations WHERE id = ?')
      .get(body.id) as { env_vars: string | null };
    expect(JSON.parse(row.env_vars!)).toEqual(envVars);
  });

  it('GET /api/conversations/:id/channel-messages 应返回稳定 seq，用于私聊 unread 锚点', async () => {
    const agent = manager.createAgent({
      name: 'SeqBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/seq-bob',
    });
    const conversation = manager.openAgentThread(agent.agentId);
    expect(conversation).not.toBeNull();
    if (!conversation) throw new Error('missing conversation');

    const dmChannelId = `dm:${agent.agentId}`;
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', 'dm:@SeqBob', 'hello', ?, ?, NULL, NULL)`,
    ).run(randomUUID(), dmChannelId, allocateNextChannelMessageSeq(db, dmChannelId), Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, ?, ?, 'agent', 'dm:@User', 'hi', ?, ?, NULL, NULL)`,
    ).run(
      randomUUID(),
      dmChannelId,
      agent.agentId,
      agent.name,
      allocateNextChannelMessageSeq(db, dmChannelId),
      Date.now(),
    );

    const { status, body } = await fetchJson(`/api/conversations/${conversation.id}/channel-messages?limit=10`);
    expect(status).toBe(200);
    expect(body.messages.map((message: { seq: number }) => message.seq)).toEqual([1, 2]);
  });

  it('POST /api/unread-summary 应分别统计 agent DM 和 channel 的未读数字', async () => {
    const agent = manager.createAgent({
      name: 'UnreadBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/unread-bob',
    });
    manager.joinChannel(agent.agentId, 'default');

    const dmChannelId = `dm:${agent.agentId}`;
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, 'user', 'User', 'user', 'dm:@UnreadBob', 'hello', ?, ?, NULL, NULL)`,
    ).run(randomUUID(), dmChannelId, allocateNextChannelMessageSeq(db, dmChannelId), Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, ?, ?, ?, 'agent', 'dm:@User', 'reply', ?, ?, NULL, NULL)`,
    ).run(
      randomUUID(),
      dmChannelId,
      agent.agentId,
      agent.name,
      allocateNextChannelMessageSeq(db, dmChannelId),
      Date.now(),
    );
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', 'user', 'User', 'user', '#default', 'channel hello', ?, ?, NULL, NULL)`,
    ).run(randomUUID(), allocateNextChannelMessageSeq(db, 'default'), Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', ?, ?, 'agent', '#default', 'channel reply', ?, ?, NULL, NULL)`,
    ).run(randomUUID(), agent.agentId, agent.name, allocateNextChannelMessageSeq(db, 'default'), Date.now());
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', ?, ?, 'agent', '#default:abcd1234', 'thread reply', ?, ?, NULL, 'abcd1234')`,
    ).run(randomUUID(), agent.agentId, agent.name, allocateNextChannelMessageSeq(db, 'default'), Date.now());

    const { status, body } = await fetchJson('/api/unread-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentIds: [agent.agentId],
        channelIds: ['default'],
        agentDmReadSeqs: { [agent.agentId]: 0 },
        channelReadSeqs: { default: 1 },
      }),
    });

    expect(status).toBe(200);
    expect(body.agentDms[agent.agentId]).toEqual({ unreadCount: 1, latestSeq: 2 });
    expect(body.channels.default).toEqual({ unreadCount: 2, latestSeq: 3 });
  });

  it('POST /api/conversations 应保留 agentId 并出现在 agent 会话列表里', async () => {
    const agent = manager.createAgent({
      name: 'Bob',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob',
    });

    const { status, body } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.agentId,
        agentType: agent.agentType,
        nodeId: agent.nodeId,
        workspacePath: agent.workspacePath,
      }),
    });

    expect(status).toBe(201);
    expect(body.agentId).toBe(agent.agentId);

    const row = db
      .prepare('SELECT agent_id as agentId FROM conversations WHERE id = ?')
      .get(body.id) as { agentId: string | null };
    expect(row.agentId).toBe(agent.agentId);

    const agentConversations = manager.listConversations({ agentId: agent.agentId });
    expect(agentConversations.map((conv) => conv.id)).toContain(body.id);
  });

  it('POST /api/agents/:id/open-thread 应复用同一个主 thread', async () => {
    const agent = manager.createAgent({
      name: 'Alice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/alice',
    });

    const first = await fetchJson(`/api/agents/${agent.agentId}/open-thread`, { method: 'POST' });
    const second = await fetchJson(`/api/agents/${agent.agentId}/open-thread`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.id).toBe(second.body.id);
    expect(first.body.threadKind).toBe('direct');
    expect(first.body.isPrimaryThread).toBe(true);

    const rows = manager.listConversations({ agentId: agent.agentId });
    expect(rows).toHaveLength(1);
  });

  it('GET /api/agents/:id/tasks 应同时返回 assigned channel task 和 DM task', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'TaskPanelAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/task-panel-alice',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');

    const channelSeq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('agtask01-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Channel task root', ?, ?, 'task')`,
    ).run(channelSeq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('agent-channel-task', 'default', 301, 'Channel task root', 'Channel task brief', 'in_progress', ?, ?, 'agtask01-0000-0000-0000-000000000000', ?, ?)`,
    ).run(agent.agentId, agent.name, now, now);

    const dmChannelId = `dm:${agent.agentId}`;
    const dmSeq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('dmtask01-0000-0000-0000-000000000000', ?, 'system', 'system', 'system', 'dm:@User', 'DM task root', ?, ?, 'task')`,
    ).run(dmChannelId, dmSeq, now + 1);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('agent-dm-task', ?, 401, 'DM task root', 'DM task brief', 'todo', ?, ?, 'dmtask01-0000-0000-0000-000000000000', ?, ?)`,
    ).run(dmChannelId, agent.agentId, agent.name, now + 1, now + 1);

    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES('agent-unassigned-task', 'default', 999, 'Ignore me', 'todo', ?, ?)`,
    ).run(now, now);

    const result = await fetchJson(`/api/agents/${agent.agentId}/tasks`);

    expect(result.status).toBe(200);
    expect(result.body.tasks).toHaveLength(2);
    expect(result.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'agent-channel-task',
        sourceType: 'channel',
        sourceLabel: '#default',
        linkedThreadShortId: 'agtask01',
      }),
      expect.objectContaining({
        taskId: 'agent-dm-task',
        sourceType: 'dm',
        sourceLabel: 'DM',
        linkedThreadShortId: 'dmtask01',
      }),
    ]));
  });

  it('PATCH /api/agents/:id/tasks/:taskId 应更新 DM task，并同步 dedicated root 标题', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'DmEditAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-edit-alice',
      channelId: 'default',
    });
    const dmChannelId = `dm:${agent.agentId}`;
    const seq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('dmedit01-0000-0000-0000-000000000000', ?, 'system', 'system', 'system', 'dm:@User', 'Old DM task title', ?, ?, 'task')`,
    ).run(dmChannelId, seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('agent-dm-edit-task', ?, 11, 'Old DM task title', 'Old DM brief', 'in_progress', ?, ?, 'dmedit01-0000-0000-0000-000000000000', ?, ?)`,
    ).run(dmChannelId, agent.agentId, agent.name, now, now);

    const result = await fetchJson(`/api/agents/${agent.agentId}/tasks/agent-dm-edit-task`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Updated DM task title',
        description: 'Updated DM task brief',
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body.title).toBe('Updated DM task title');
    expect(result.body.description).toBe('Updated DM task brief');

    const messageRow = db.prepare(
      `SELECT content FROM channel_messages WHERE message_id = 'dmedit01-0000-0000-0000-000000000000'`,
    ).get() as { content: string };
    expect(messageRow.content).toBe('Updated DM task title');
  });

  it('PATCH /api/agents/:id/tasks/:taskId/status 应更新 DM task 状态', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'DmStatusAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-status-alice',
      channelId: 'default',
    });
    const dmChannelId = `dm:${agent.agentId}`;
    const seq = allocateNextChannelMessageSeq(db, dmChannelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('dmstatus01-0000-0000-0000-000000000000', ?, 'system', 'system', 'system', 'dm:@User', 'DM task root', ?, ?, 'task')`,
    ).run(dmChannelId, seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('agent-dm-status-task', ?, 13, 'DM task root', 'DM brief', 'in_review', ?, ?, 'dmstatus01-0000-0000-0000-000000000000', ?, ?)`,
    ).run(dmChannelId, agent.agentId, agent.name, now, now);

    const result = await fetchJson(`/api/agents/${agent.agentId}/tasks/agent-dm-status-task/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });

    expect(result.status).toBe(200);
    expect(result.body.status).toBe('done');
    const taskRow = db.prepare(
      `SELECT status
       FROM tasks
       WHERE task_id = 'agent-dm-status-task'`,
    ).get() as { status: string };
    expect(taskRow.status).toBe('done');
  });

  it('POST /api/agents/:id/tasks/:taskId/unclaim 应释放 DM task claim 并回到 todo', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'DmReleaseAlice',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/dm-release-alice',
      channelId: 'default',
    });
    const dmChannelId = `dm:${agent.agentId}`;
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, created_at, updated_at)
       VALUES('agent-dm-release-task', ?, 12, 'Release DM task', 'DM brief', 'in_progress', ?, ?, ?, ?)`,
    ).run(dmChannelId, agent.agentId, agent.name, now, now);

    const result = await fetchJson(`/api/agents/${agent.agentId}/tasks/agent-dm-release-task/unclaim`, {
      method: 'POST',
    });

    expect(result.status).toBe(200);
    expect(result.body.status).toBe('todo');
    expect(result.body.assigneeId).toBeNull();
    expect(result.body.assigneeName).toBeNull();
  });

  it('POST /api/channels/:id/messages 在主频道 @agent 时应创建/复用 channel root branch，而不是 thread reply 或私聊主 thread', async () => {
    const agent = manager.createAgent({
      name: 'BobMention',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob-mention-thread',
    });
    manager.joinChannel(agent.agentId, 'default');

    const dmThread = manager.openAgentThread(agent.agentId);
    expect(dmThread).not.toBeNull();
    if (!dmThread) throw new Error('missing dm thread');

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@BobMention 请看下这个问题', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const conversations = manager.listConversations({ agentId: agent.agentId });
    const branch = conversations.find((item) => item.threadKind === 'branch');
    expect(branch).toBeTruthy();
    expect(branch?.channelId).toBe('default');
    expect(branch?.threadRootId).toBeNull();
    expect(branch?.id).not.toBe(dmThread.id);
  });

  it('POST /api/channels/:id/messages 在 subscribed_agents 模式下，无 root participants 时应唤醒订阅者', async () => {
    const channel = manager.createChannel({
      name: 'subscribed-broadcast',
      collaborationMode: 'subscribed_agents',
    });
    const alice = manager.createAgent({
      name: 'SubscribedAlice',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/subscribed-alice',
    });
    const bob = manager.createAgent({
      name: 'SubscribedBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/subscribed-bob',
    });
    manager.joinChannel(alice.agentId, channel.channelId);
    manager.joinChannel(bob.agentId, channel.channelId);

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '大家看下这个新问题', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const aliceConv = manager.openAgentChannelThread(alice.agentId, channel.channelId, null);
    const bobConv = manager.openAgentChannelThread(bob.agentId, channel.channelId, null);
    expect(aliceConv).not.toBeNull();
    expect(bobConv).not.toBeNull();

    const alicePrompt = db.prepare(
      `SELECT r.prompt_text as promptText
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`,
    ).get(aliceConv?.id) as { promptText: string } | undefined;
    const bobPrompt = db.prepare(
      `SELECT r.prompt_text as promptText
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`,
    ).get(bobConv?.id) as { promptText: string } | undefined;

    expect(alicePrompt?.promptText).toContain('There is new channel activity');
    expect(bobPrompt?.promptText).toContain('There is new channel activity');
  });

  it('POST /api/channels/:id/messages 在 subscribed_agents 模式下，同批订阅者应看到一致的 active participants', async () => {
    const channel = manager.createChannel({
      name: 'subscribed-participants',
      collaborationMode: 'subscribed_agents',
    });
    const kimi = manager.createAgent({
      name: 'kimi',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/subscribed-kimi',
    });
    const bob = manager.createAgent({
      name: 'Bob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/subscribed-bob-participants',
    });
    manager.joinChannel(kimi.agentId, channel.channelId);
    manager.joinChannel(bob.agentId, channel.channelId);

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '你们好啊', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const kimiConv = manager.openAgentChannelThread(kimi.agentId, channel.channelId, null);
    const bobConv = manager.openAgentChannelThread(bob.agentId, channel.channelId, null);
    expect(kimiConv).not.toBeNull();
    expect(bobConv).not.toBeNull();

    const triggerSeq = response.body.seq as number;
    const kimiContext = buildTargetActivationContext(db, {
      agentId: kimi.agentId,
      channelId: channel.channelId,
      replyTarget: kimiConv?.replyTarget ?? `#${channel.name}`,
      triggerSeq,
      threadRootId: null,
    });
    const bobContext = buildTargetActivationContext(db, {
      agentId: bob.agentId,
      channelId: channel.channelId,
      replyTarget: bobConv?.replyTarget ?? `#${channel.name}`,
      triggerSeq,
      threadRootId: null,
    });

    const kimiParticipants = kimiContext.participants.map((participant) => participant.name);
    const bobParticipants = bobContext.participants.map((participant) => participant.name);
    expect(kimiParticipants).toEqual(bobParticipants);
    expect(new Set(kimiParticipants)).toEqual(new Set(['kimi', 'Bob']));
  });

  it('POST /api/channels/:id/messages 在 subscribed_agents 模式下，有 root participants 时应优先唤醒参与者', async () => {
    const channel = manager.createChannel({
      name: 'subscribed-priority',
      collaborationMode: 'subscribed_agents',
    });
    const owner = manager.createAgent({
      name: 'RootOwner',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/root-owner',
    });
    const watcher = manager.createAgent({
      name: 'PassiveWatcher',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/passive-watcher',
    });
    manager.joinChannel(owner.agentId, channel.channelId);
    manager.joinChannel(watcher.agentId, channel.channelId);
    upsertTargetParticipant(db, {
      agentId: owner.agentId,
      channelId: channel.channelId,
      threadRootId: null,
      role: 'owner',
      lastActiveAt: Date.now(),
    });

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '这里有个后续更新', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const ownerConv = manager.openAgentChannelThread(owner.agentId, channel.channelId, null);
    expect(ownerConv).not.toBeNull();
    const ownerPrompt = db.prepare(
      `SELECT r.prompt_text as promptText
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?
       ORDER BY r.started_at DESC
       LIMIT 1`,
    ).get(ownerConv?.id) as { promptText: string } | undefined;
    expect(ownerPrompt?.promptText).toContain('There is new channel activity');

    const watcherRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.agent_id = ? AND c.channel_id = ?`,
    ).get(watcher.agentId, channel.channelId) as { count: number };
    expect(watcherRunCount.count).toBe(0);
  });

  it('POST /api/channels/:id/messages 在 subscribed_agents 模式下，过期 root participants 不应继续拦截订阅兜底', async () => {
    const channel = manager.createChannel({
      name: 'subscribed-stale-root',
      collaborationMode: 'subscribed_agents',
    });
    const staleOwner = manager.createAgent({
      name: 'StaleOwner',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/stale-owner',
    });
    const freshSubscriber = manager.createAgent({
      name: 'FreshSubscriber',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/fresh-subscriber',
    });
    manager.joinChannel(staleOwner.agentId, channel.channelId);
    manager.joinChannel(freshSubscriber.agentId, channel.channelId);
    upsertTargetParticipant(db, {
      agentId: staleOwner.agentId,
      channelId: channel.channelId,
      threadRootId: null,
      role: 'owner',
      lastActiveAt: Date.now() - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS - 1_000,
    });

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '这是一个新的频道更新', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const freshRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.agent_id = ? AND c.channel_id = ?`,
    ).get(freshSubscriber.agentId, channel.channelId) as { count: number };

    expect(freshRunCount.count).toBe(1);
  });

  it('POST /api/channels/:id/messages 在 subscribed_agents 模式下，多轮 root activity 应先唤醒订阅者，再优先最近参与者', async () => {
    const channel = manager.createChannel({
      name: 'subscribed-multi-round',
      collaborationMode: 'subscribed_agents',
    });
    const alpha = manager.createAgent({
      name: 'RoundAlpha',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/round-alpha',
    });
    const beta = manager.createAgent({
      name: 'RoundBeta',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/round-beta',
    });
    const gamma = manager.createAgent({
      name: 'RoundGamma',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/round-gamma',
    });
    manager.joinChannel(alpha.agentId, channel.channelId);
    manager.joinChannel(beta.agentId, channel.channelId);
    manager.joinChannel(gamma.agentId, channel.channelId);

    const firstResponse = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第一轮：请大家看一下这个新频道消息', senderName: 'User' }),
    });
    expect(firstResponse.status).toBe(201);

    const alphaConv = manager.openAgentChannelThread(alpha.agentId, channel.channelId, null);
    const betaConv = manager.openAgentChannelThread(beta.agentId, channel.channelId, null);
    const gammaConv = manager.openAgentChannelThread(gamma.agentId, channel.channelId, null);
    expect(alphaConv).not.toBeNull();
    expect(betaConv).not.toBeNull();
    expect(gammaConv).not.toBeNull();

    const firstRunCounts = [alphaConv, betaConv, gammaConv].map((conv) => {
      const row = db.prepare(
        `SELECT COUNT(*) as count
         FROM runs r
         JOIN conversations c ON c.session_key = r.session_key
         WHERE c.id = ?`,
      ).get(conv?.id) as { count: number };
      return row.count;
    });
    expect(firstRunCounts).toEqual([1, 1, 1]);

    const firstDebugRows = [alphaConv, betaConv, gammaConv].map((conv) => db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(conv?.id) as { promptText: string; contextText: string | null } | undefined);
    for (const debugRow of firstDebugRows) {
      expect(debugRow?.promptText).toContain('There is new channel activity');
    }

    db.prepare(
      `UPDATE target_participants
       SET last_active_at = ?
       WHERE channel_id = ? AND thread_root_id = '' AND agent_id IN (?, ?)`,
    ).run(
      Date.now() - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS - 1_000,
      channel.channelId,
      beta.agentId,
      gamma.agentId,
    );
    db.prepare(
      `UPDATE target_participants
       SET last_active_at = ?
       WHERE channel_id = ? AND thread_root_id = '' AND agent_id = ?`,
    ).run(Date.now(), channel.channelId, alpha.agentId);

    const secondResponse = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第二轮：请优先找最近还在看的 agent', senderName: 'User' }),
    });
    expect(secondResponse.status).toBe(201);

    const secondRunCounts = [alphaConv, betaConv, gammaConv].map((conv) => {
      const row = db.prepare(
        `SELECT COUNT(*) as count
         FROM runs r
         JOIN conversations c ON c.session_key = r.session_key
         WHERE c.id = ?`,
      ).get(conv?.id) as { count: number };
      return row.count;
    });
    expect(secondRunCounts).toEqual([2, 1, 1]);

    const alphaDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(alphaConv?.id) as { promptText: string; contextText: string | null } | undefined;
    expect(alphaDebug?.promptText).toContain('There is new channel activity');
    expect(alphaDebug?.contextText).toContain('[Active participants on this target]');
    expect(alphaDebug?.contextText).toContain('@RoundAlpha (participant)');
    expect(alphaDebug?.contextText).not.toContain('@RoundBeta (participant)');
    expect(alphaDebug?.contextText).not.toContain('@RoundGamma (participant)');
  });

  it('POST /api/channels/:id/messages 在主频道一次 @ 多个 agent 且其中一人已 active 时，active agent 应进入 queue，而其他 agent 应正常 dispatch', async () => {
    const channel = manager.createChannel({ name: 'mention-queue-room' });
    const bob = manager.createAgent({
      name: 'MentionQueueBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/mention-queue-bob',
    });
    const carol = manager.createAgent({
      name: 'MentionQueueCarol',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/mention-queue-carol',
    });
    manager.joinChannel(bob.agentId, channel.channelId);
    manager.joinChannel(carol.agentId, channel.channelId);

    const bobConv = manager.openAgentChannelThread(bob.agentId, channel.channelId, null);
    const carolConv = manager.openAgentChannelThread(carol.agentId, channel.channelId, null);
    if (!bobConv || !carolConv) throw new Error('missing mention queue conversations');

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-server-mention-queue-bob',
      sessionKey: bobSession.sessionKey,
      promptText: 'already active on the channel root',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', carolConv.id);

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@MentionQueueBob @MentionQueueCarol 一起看下这个主频道问题',
        senderName: 'User',
      }),
    });

    expect(response.status).toBe(201);

    const bobQueueRows = db.prepare(
      `SELECT prompt_text as promptText, activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id ASC`,
    ).all(bobConv.id) as Array<{ promptText: string; activationContextText: string | null }>;
    expect(bobQueueRows).toHaveLength(1);
    expect(bobQueueRows[0]?.promptText).toContain('You were @mentioned in #mention-queue-room by User.');

    const carolRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?`,
    ).get(carolConv.id) as { count: number };
    expect(carolRunCount.count).toBe(1);

    const carolDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(carolConv.id) as { promptText: string; contextText: string | null } | undefined;
    expect(carolDebug?.promptText).toContain('[System: You were @mentioned in #mention-queue-room by User.]');

    const participantsBlock = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );
    expect(participantsBlock(bobQueueRows[0]?.activationContextText)).toBe(participantsBlock(carolDebug?.contextText));
  });

  it('POST /api/channels/:id/messages 在 mention_only 主频道普通消息中，不应无故唤醒未被 @ 的 agent', async () => {
    const channel = manager.createChannel({ name: 'plain-root-no-wake', collaborationMode: 'mention_only' });
    const alpha = manager.createAgent({
      name: 'PlainRootAlpha',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/plain-root-alpha',
    });
    const beta = manager.createAgent({
      name: 'PlainRootBeta',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/plain-root-beta',
    });
    const gamma = manager.createAgent({
      name: 'PlainRootGamma',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/plain-root-gamma',
    });
    manager.joinChannel(alpha.agentId, channel.channelId);
    manager.joinChannel(beta.agentId, channel.channelId);
    manager.joinChannel(gamma.agentId, channel.channelId);

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '这是一条普通主频道消息，没有显式点名任何 agent。',
        senderName: 'User',
      }),
    });

    expect(response.status).toBe(201);

    for (const agentId of [alpha.agentId, beta.agentId, gamma.agentId]) {
      const runCount = db.prepare(
        `SELECT COUNT(*) as count
         FROM runs r
         JOIN conversations c ON c.session_key = r.session_key
         WHERE c.agent_id = ? AND c.channel_id = ? AND c.thread_root_id IS NULL`,
      ).get(agentId, channel.channelId) as { count: number };
      expect(runCount.count).toBe(0);
    }

    const participantCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM target_participants
       WHERE channel_id = ? AND thread_root_id = ''`,
    ).get(channel.channelId) as { count: number };
    expect(participantCount.count).toBe(0);
  });

  it('POST /api/channels/:id/messages 在主频道一次 @ 多个 agent 时，每个 agent 都应看到一致的 active participants', async () => {
    const channel = manager.createChannel({ name: 'mention-batch-room' });
    const bob = manager.createAgent({
      name: 'PromptBatchBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/prompt-batch-bob',
    });
    const carol = manager.createAgent({
      name: 'PromptBatchCarol',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/prompt-batch-carol',
    });
    manager.joinChannel(bob.agentId, channel.channelId);
    manager.joinChannel(carol.agentId, channel.channelId);

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@PromptBatchBob @PromptBatchCarol 一起看下这个问题',
        senderName: 'User',
      }),
    });

    expect(response.status).toBe(201);

    const bobConv = manager.openAgentChannelThread(bob.agentId, channel.channelId, null);
    const carolConv = manager.openAgentChannelThread(carol.agentId, channel.channelId, null);
    expect(bobConv).not.toBeNull();
    expect(carolConv).not.toBeNull();

    const bobDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(bobConv?.id) as { promptText: string; contextText: string | null } | undefined;
    const carolDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(carolConv?.id) as { promptText: string; contextText: string | null } | undefined;

    expect(bobDebug?.promptText).toContain('[System: You were @mentioned in #mention-batch-room by User.]');
    expect(carolDebug?.promptText).toContain('[System: You were @mentioned in #mention-batch-room by User.]');

    const extractParticipants = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );
    const bobParticipants = extractParticipants(bobDebug?.contextText);
    const carolParticipants = extractParticipants(carolDebug?.contextText);

    expect(bobParticipants).toBe(carolParticipants);
    expect(bobParticipants).toContain('@PromptBatchBob');
    expect(bobParticipants).toContain('@PromptBatchCarol');
  });

  it('POST /api/channels/:id/messages 在 subscribed_agents 模式下，第二轮 root activity 遇到 active recent participant 时应进入 queue，而其他 root participants 正常 dispatch', async () => {
    const channel = manager.createChannel({
      name: 'subscribed-active-queue',
      collaborationMode: 'subscribed_agents',
    });
    const alpha = manager.createAgent({
      name: 'SubscribedAlpha',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/subscribed-alpha',
    });
    const beta = manager.createAgent({
      name: 'SubscribedBeta',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/subscribed-beta',
    });
    const gamma = manager.createAgent({
      name: 'SubscribedGamma',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/subscribed-gamma',
    });
    manager.joinChannel(alpha.agentId, channel.channelId);
    manager.joinChannel(beta.agentId, channel.channelId);
    manager.joinChannel(gamma.agentId, channel.channelId);

    const firstResponse = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第一轮：请大家看一下这个新频道消息', senderName: 'User' }),
    });
    expect(firstResponse.status).toBe(201);

    const alphaConv = manager.openAgentChannelThread(alpha.agentId, channel.channelId, null);
    const betaConv = manager.openAgentChannelThread(beta.agentId, channel.channelId, null);
    const gammaConv = manager.openAgentChannelThread(gamma.agentId, channel.channelId, null);
    if (!alphaConv || !betaConv || !gammaConv) throw new Error('missing subscribed conversations');

    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', alphaConv.id);
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', betaConv.id);
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', gammaConv.id);

    const secondResponse = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '第二轮：请优先找最近还在看的 agent', senderName: 'User' }),
    });
    expect(secondResponse.status).toBe(201);

    const alphaRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?`,
    ).get(alphaConv.id) as { count: number };
    const betaRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?`,
    ).get(betaConv.id) as { count: number };
    const gammaRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?`,
    ).get(gammaConv.id) as { count: number };

    expect(alphaRunCount.count).toBe(2);
    expect(betaRunCount.count).toBe(1);
    expect(gammaRunCount.count).toBe(2);

    const betaQueueRows = db.prepare(
      `SELECT prompt_text as promptText, activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id ASC`,
    ).all(betaConv.id) as Array<{ promptText: string; activationContextText: string | null }>;
    expect(betaQueueRows).toHaveLength(1);
    expect(betaQueueRows[0]?.promptText).toContain('There is new channel activity');

    const alphaDebug = db.prepare(
      `SELECT context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(alphaConv.id) as { contextText: string | null } | undefined;
    const gammaDebug = db.prepare(
      `SELECT context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(gammaConv.id) as { contextText: string | null } | undefined;
    const participantsBlock = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );

    expect(participantsBlock(betaQueueRows[0]?.activationContextText)).toBe(participantsBlock(alphaDebug?.contextText));
    expect(participantsBlock(betaQueueRows[0]?.activationContextText)).toBe(participantsBlock(gammaDebug?.contextText));
  });

  it('POST /api/channels/:id/messages 在线程普通回复中，active recent participant 应进入 queue，而其他 recent participants 正常 dispatch', async () => {
    const channel = manager.createChannel({ name: 'thread-queue-room' });
    const alice = manager.createAgent({
      name: 'ThreadQueueAlice',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/thread-queue-alice',
    });
    const bob = manager.createAgent({
      name: 'ThreadQueueBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/thread-queue-bob',
    });
    const carol = manager.createAgent({
      name: 'ThreadQueueCarol',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/thread-queue-carol',
    });
    manager.joinChannel(alice.agentId, channel.channelId);
    manager.joinChannel(bob.agentId, channel.channelId);
    manager.joinChannel(carol.agentId, channel.channelId);

    const threadRootId = 'thrq1234';
    const rootMessageId = `${threadRootId}-0000-0000-0000-000000000000`;
    const now = Date.now();
    const rootSeq = allocateNextChannelMessageSeq(db, channel.channelId);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?)`,
    ).run(rootMessageId, channel.channelId, alice.agentId, alice.name, `#${channel.name}`, 'Thread root kickoff', rootSeq, now);

    const bobConv = manager.openAgentChannelThread(bob.agentId, channel.channelId, threadRootId);
    const carolConv = manager.openAgentChannelThread(carol.agentId, channel.channelId, threadRootId);
    if (!bobConv || !carolConv) throw new Error('missing thread queue conversations');

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-server-thread-queue-bob',
      sessionKey: bobSession.sessionKey,
      promptText: 'already active on the thread',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', carolConv.id);

    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: channel.channelId,
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: carol.agentId,
      channelId: channel.channelId,
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '这个线程里还有几个点要继续推进',
        senderName: 'User',
        replyTo: threadRootId,
      }),
    });

    expect(response.status).toBe(201);

    const bobQueueRows = db.prepare(
      `SELECT prompt_text as promptText, activation_context_text as activationContextText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id ASC`,
    ).all(bobConv.id) as Array<{ promptText: string; activationContextText: string | null }>;
    expect(bobQueueRows).toHaveLength(1);
    expect(bobQueueRows[0]?.promptText).toContain('received a reply from User');

    const carolRunCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?`,
    ).get(carolConv.id) as { count: number };
    expect(carolRunCount.count).toBe(1);

    const carolDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(carolConv.id) as { promptText: string; contextText: string | null } | undefined;
    expect(carolDebug?.promptText).toContain(`[System: Your collaborative thread in #${channel.name} received a reply from User.]`);

    const participantsBlock = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );
    expect(participantsBlock(bobQueueRows[0]?.activationContextText)).toBe(participantsBlock(carolDebug?.contextText));
  });

  it('POST /api/channels/:id/messages 在线程中显式 @agent 时应优先保留 mention reason', async () => {
    const channel = manager.createChannel({ name: 'thread-mention-priority' });
    const bob = manager.createAgent({
      name: 'PriorityBobUser',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/priority-bob-user',
    });
    manager.joinChannel(bob.agentId, channel.channelId);

    const threadRootId = 'prior123';
    const bobConv = manager.openAgentChannelThread(bob.agentId, channel.channelId, threadRootId);
    if (!bobConv) throw new Error('missing bob thread conversation');

    const bobSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(bobConv.id) as { sessionKey: string };
    createRun(db, {
      runId: 'run-server-thread-priority',
      sessionKey: bobSession.sessionKey,
      promptText: 'already active on thread',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: channel.channelId,
      threadRootId,
      role: 'participant',
      lastActiveAt: Date.now(),
    });

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '请跟进这个线程，@PriorityBobUser',
        senderName: 'User',
        replyTo: threadRootId,
      }),
    });

    expect(response.status).toBe(201);

    const queueRows = db.prepare(
      `SELECT prompt_text as promptText
       FROM conversation_prompt_queue
       WHERE conversation_id = ?
       ORDER BY queue_id ASC`,
    ).all(bobConv.id) as Array<{ promptText: string }>;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]?.promptText).toContain('You were @mentioned in #thread-mention-priority by User.');
    expect(queueRows[0]?.promptText).not.toContain('received a reply');
  });

  it('POST /api/channels/:id/messages 在主频道 @agent 时应直接把触发消息写进激活 prompt', async () => {
    const agent = manager.createAgent({
      name: 'PromptBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/prompt-bob',
    });
    manager.joinChannel(agent.agentId, 'default');

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@PromptBob 帮我看看这个问题', senderName: 'User' }),
    });

    expect(response.status).toBe(201);

    const conv = manager.openAgentChannelThread(agent.agentId, 'default', null);
    expect(conv).not.toBeNull();
    if (!conv) throw new Error('missing mention conversation');

    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    const runRow = db.prepare(
      `SELECT prompt_text as promptText
       FROM runs
       WHERE session_key = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(sessionRow.sessionKey) as { promptText: string } | undefined;

    expect(runRow?.promptText).toContain('[Triggered message metadata]');
    expect(runRow?.promptText).toContain('target: #default');
    expect(runRow?.promptText).toContain('[Triggered message body]');
    expect(runRow?.promptText).toContain('@PromptBob 帮我看看这个问题');
    expect(runRow?.promptText).not.toContain('Call check_messages to read unread messages');
  });

  it('POST /api/channels/:id/messages 在 thread reply 时应直接把 reply 内容写进激活 prompt', async () => {
    const agent = manager.createAgent({
      name: 'ReplyBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/reply-bob',
    });
    manager.joinChannel(agent.agentId, 'default');

    const rootMessageId = randomUUID();
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', ?, ?, 'agent', '#default', ?, ?, ?, NULL, NULL)`,
    ).run(rootMessageId, agent.agentId, agent.name, 'root message', seq, Date.now());

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '我在 thread 里回复你',
        senderName: 'User',
        replyTo: rootMessageId.slice(0, 8),
      }),
    });

    expect(response.status).toBe(201);

    const conv = manager.openAgentChannelThread(agent.agentId, 'default', rootMessageId.slice(0, 8));
    expect(conv).not.toBeNull();
    if (!conv) throw new Error('missing thread reply conversation');

    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };
    const runRow = db.prepare(
      `SELECT prompt_text as promptText
       FROM runs
       WHERE session_key = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(sessionRow.sessionKey) as { promptText: string } | undefined;

    expect(runRow?.promptText).toContain(`[System: Your collaborative thread in #default received a reply from User.]`);
    expect(runRow?.promptText).toContain(`target: #default:${rootMessageId.slice(0, 8)}`);
    expect(runRow?.promptText).toContain('我在 thread 里回复你');
    expect(runRow?.promptText).not.toContain('Call check_messages to read unread messages');
  });

  it('POST /api/channels/:id/messages 在 done task thread 新回复时不应优先过期 owner，而应回退到 root sender', async () => {
    const channel = manager.createChannel({ name: 'done-task-fallback' });
    const rootAuthor = manager.createAgent({
      name: 'RootAuthor',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/done-task-root-author',
      channelId: channel.channelId,
    });
    const staleOwner = manager.createAgent({
      name: 'StaleOwner',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/done-task-stale-owner',
      channelId: channel.channelId,
    });
    manager.joinChannel(rootAuthor.agentId, channel.channelId);
    manager.joinChannel(staleOwner.agentId, channel.channelId);

    const rootMessageId = 'donefeed-0000-0000-0000-000000000000';
    const rootSeq = allocateNextChannelMessageSeq(db, channel.channelId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?)`,
    ).run(rootMessageId, channel.channelId, rootAuthor.agentId, rootAuthor.name, `#${channel.name}`, 'Done task root', rootSeq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES(?, ?, 31, 'Done task root', 'Goal: verify stale owners do not keep receiving task-thread replies after completion.', 'done', ?, ?, ?, ?, ?)`,
    ).run(
      'task-done-fallback',
      channel.channelId,
      rootAuthor.agentId,
      rootAuthor.name,
      rootMessageId,
      now,
      now,
    );
    upsertTargetParticipant(db, {
      agentId: staleOwner.agentId,
      channelId: channel.channelId,
      threadRootId: rootMessageId.slice(0, 8),
      role: 'owner',
      lastActiveAt: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS - 1_000,
    });

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '这个 done task 还需要补充一个结论',
        senderName: 'User',
        replyTo: rootMessageId.slice(0, 8),
      }),
    });

    expect(response.status).toBe(201);

    const rootConv = manager.openAgentChannelThread(rootAuthor.agentId, channel.channelId, rootMessageId.slice(0, 8));
    expect(rootConv).not.toBeNull();
    if (!rootConv) throw new Error('missing root author conversation');

    const staleConvCount = db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.agent_id = ? AND c.channel_id = ? AND c.thread_root_id = ?`,
    ).get(staleOwner.agentId, channel.channelId, rootMessageId.slice(0, 8)) as { count: number };
    expect(staleConvCount.count).toBe(0);

    const rootDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(rootConv.id) as { promptText: string; contextText: string | null } | undefined;
    expect(rootDebug?.promptText).toContain(`[System: Your collaborative thread in #${channel.name} received a reply from User.]`);
    expect(rootDebug?.contextText).toContain('[Bound task-message for this thread]');
    expect(rootDebug?.contextText).toContain('#31 [done] @RootAuthor — Done task root');
    expect(rootDebug?.contextText).not.toContain('@StaleOwner (owner)');
  });

  it('POST /api/channels/:id/messages 在 bound task thread reply 时应给多 agent 注入一致的协作上下文', async () => {
    const now = Date.now();
    const owner = manager.createAgent({
      name: 'TaskOwnerPrompt',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/task-owner-prompt',
    });
    const reviewer = manager.createAgent({
      name: 'TaskReviewerPrompt',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/task-reviewer-prompt',
    });
    manager.joinChannel(owner.agentId, 'default');
    manager.joinChannel(reviewer.agentId, 'default');

    const rootSeq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('prmpt208-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Investigate rollout regression', ?, ?, 'task')`,
    ).run(rootSeq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('task-prompt-thread', 'default', 208, 'Investigate rollout regression', 'Goal: confirm prompt context exposes task ownership, reviewer presence, and the thread root. Done when both owner and reviewer get identical collaboration context.', 'in_progress', ?, ?, 'prmpt208-0000-0000-0000-000000000000', ?, ?)`,
    ).run(owner.agentId, owner.name, now, now);

    syncTaskThreadOwner(db, {
      taskId: 'task-prompt-thread',
      agentId: owner.agentId,
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: reviewer.agentId,
      channelId: 'default',
      threadRootId: 'prmpt208',
      role: 'participant',
      lastActiveAt: now,
    });

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '请同步下这个 task thread 的当前分工',
        senderName: 'User',
        replyTo: 'prmpt208',
      }),
    });

    expect(response.status).toBe(201);

    const ownerConv = manager.openAgentChannelThread(owner.agentId, 'default', 'prmpt208');
    const reviewerConv = manager.openAgentChannelThread(reviewer.agentId, 'default', 'prmpt208');
    expect(ownerConv).not.toBeNull();
    expect(reviewerConv).not.toBeNull();

    const ownerDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(ownerConv?.id) as { promptText: string; contextText: string | null } | undefined;
    const reviewerDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(reviewerConv?.id) as { promptText: string; contextText: string | null } | undefined;

    expect(ownerDebug?.promptText).toContain('[System: Your collaborative thread in #default received a reply from User.]');
    expect(reviewerDebug?.promptText).toContain('[System: Your collaborative thread in #default received a reply from User.]');

    for (const debugRow of [ownerDebug, reviewerDebug]) {
      expect(debugRow?.contextText).toContain('[Thread root message]');
      expect(debugRow?.contextText).toContain('Investigate rollout regression');
      expect(debugRow?.contextText).toContain('[Active participants on this target]');
      expect(debugRow?.contextText).toContain('@TaskOwnerPrompt (owner)');
      expect(debugRow?.contextText).toContain('@TaskReviewerPrompt (participant)');
      expect(debugRow?.contextText).toContain('[Bound task-message for this thread]');
      expect(debugRow?.contextText).toContain('#208 [in_progress] @TaskOwnerPrompt — Investigate rollout regression');
      expect(debugRow?.contextText).toContain('Task brief / goal / done criteria:');
      expect(debugRow?.contextText).toContain('confirm prompt context exposes task ownership');
      expect(debugRow?.contextText).toContain('shared work surface for that task-message');
      expect(debugRow?.contextText).not.toContain('[Task-message board summary]');
    }
  });

  it('POST /api/channels/:id/messages 在 task thread 中同时命中 assignee、recent participant 和显式 @mention 时应保持 reason 优先级与 participants 一致', async () => {
    const now = Date.now();
    const owner = manager.createAgent({
      name: 'MixOwner',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/mix-owner',
    });
    const helper = manager.createAgent({
      name: 'MixHelper',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/mix-helper',
    });
    const mentioned = manager.createAgent({
      name: 'MixMentioned',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/mix-mentioned',
    });
    manager.joinChannel(owner.agentId, 'default');
    manager.joinChannel(helper.agentId, 'default');
    manager.joinChannel(mentioned.agentId, 'default');

    const rootMessageId = 'mixa1u00-0000-0000-0000-000000000000';
    const threadRootId = rootMessageId.slice(0, 8);
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, 'default', ?, ?, 'agent', '#default', ?, ?, ?)`,
    ).run(rootMessageId, owner.agentId, owner.name, 'Task root kickoff', allocateNextChannelMessageSeq(db, 'default'), now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('task-mix-a1u', 'default', 301, 'Mixed priority task', 'Goal: verify assignee, recent participant, and explicit mention all wake together with stable context.', 'in_progress', ?, ?, ?, ?, ?)`,
    ).run(owner.agentId, owner.name, rootMessageId, now, now);

    upsertTargetParticipant(db, {
      agentId: owner.agentId,
      channelId: 'default',
      threadRootId,
      role: 'owner',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: helper.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: mentioned.agentId,
      channelId: 'default',
      threadRootId,
      role: 'participant',
      lastActiveAt: now,
    });

    const response = await fetchJson('/api/channels/default/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '请先让 @MixMentioned 看一下，再一起对齐这个 task thread 的后续安排。',
        senderName: 'User',
        replyTo: threadRootId,
      }),
    });

    expect(response.status).toBe(201);

    const ownerConv = manager.openAgentChannelThread(owner.agentId, 'default', threadRootId);
    const helperConv = manager.openAgentChannelThread(helper.agentId, 'default', threadRootId);
    const mentionedConv = manager.openAgentChannelThread(mentioned.agentId, 'default', threadRootId);
    expect(ownerConv).not.toBeNull();
    expect(helperConv).not.toBeNull();
    expect(mentionedConv).not.toBeNull();

    const ownerDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(ownerConv?.id) as { promptText: string; contextText: string | null } | undefined;
    const helperDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(helperConv?.id) as { promptText: string; contextText: string | null } | undefined;
    const mentionedDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(mentionedConv?.id) as { promptText: string; contextText: string | null } | undefined;

    expect(ownerDebug?.promptText).toContain('Your collaborative thread in #default received a reply from User.');
    expect(helperDebug?.promptText).toContain('Your collaborative thread in #default received a reply from User.');
    expect(mentionedDebug?.promptText).toContain('You were @mentioned in #default by User.');

    const participantsBlock = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );

    const ownerParticipants = participantsBlock(ownerDebug?.contextText);
    const helperParticipants = participantsBlock(helperDebug?.contextText);
    const mentionedParticipants = participantsBlock(mentionedDebug?.contextText);
    expect(ownerParticipants).toBe('@MixOwner (owner)\n@MixHelper (participant)\n@MixMentioned (participant)');
    expect(helperParticipants).toBe(ownerParticipants);
    expect(mentionedParticipants).toBe(ownerParticipants);
    expect(ownerDebug?.contextText).toContain('[Bound task-message for this thread]');
    expect(helperDebug?.contextText).toContain('[Bound task-message for this thread]');
    expect(mentionedDebug?.contextText).toContain('[Bound task-message for this thread]');
    expect(ownerDebug?.contextText).not.toContain('[Task-message board summary]');
  });

  it('POST /api/channels/:id/messages 在用户 owner 的 task thread 中应只显示真实 agent participants', async () => {
    const channel = manager.createChannel({ name: 'human-owned-task-thread' });
    const alice = manager.createAgent({
      name: 'HumanTaskAlice',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/human-task-alice',
      channelId: channel.channelId,
    });
    const bob = manager.createAgent({
      name: 'HumanTaskBob',
      agentType: 'claude_acp',
      nodeId: 'missing-node',
      workspacePath: '/tmp/human-task-bob',
      channelId: channel.channelId,
    });
    manager.joinChannel(alice.agentId, channel.channelId);
    manager.joinChannel(bob.agentId, channel.channelId);

    const rootMessageId = 'humantsk-0000-0000-0000-000000000000';
    const rootSeq = allocateNextChannelMessageSeq(db, channel.channelId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, ?, 'user', 'User', 'user', ?, ?, ?, ?)`,
    ).run(rootMessageId, channel.channelId, `#${channel.name}`, 'Human owned task root', rootSeq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_name, message_id, created_at, updated_at)
       VALUES(?, ?, 41, 'Human owned task', 'Goal: keep the owner human and the participants agent-only. Done when prompt context shows the human owner but does not invent an agent owner.', 'in_progress', ?, ?, ?, ?)`,
    ).run('task-human-owned', channel.channelId, 'oldpan', rootMessageId, now, now);
    upsertTargetParticipant(db, {
      agentId: alice.agentId,
      channelId: channel.channelId,
      threadRootId: rootMessageId.slice(0, 8),
      role: 'participant',
      lastActiveAt: now,
    });
    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: channel.channelId,
      threadRootId: rootMessageId.slice(0, 8),
      role: 'participant',
      lastActiveAt: now,
    });

    const response = await fetchJson(`/api/channels/${channel.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '请继续这个 human owned task thread',
        senderName: 'User',
        replyTo: rootMessageId.slice(0, 8),
      }),
    });

    expect(response.status).toBe(201);

    const aliceConv = manager.openAgentChannelThread(alice.agentId, channel.channelId, rootMessageId.slice(0, 8));
    const bobConv = manager.openAgentChannelThread(bob.agentId, channel.channelId, rootMessageId.slice(0, 8));
    expect(aliceConv).not.toBeNull();
    expect(bobConv).not.toBeNull();

    const aliceDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(aliceConv?.id) as { promptText: string; contextText: string | null } | undefined;
    const bobDebug = db.prepare(
      `SELECT prompt_text as promptText, context_text as contextText
       FROM run_debug_inputs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(bobConv?.id) as { promptText: string; contextText: string | null } | undefined;

    expect(aliceDebug?.promptText).toContain(`[System: Your collaborative thread in #${channel.name} received a reply from User.]`);
    expect(bobDebug?.promptText).toContain(`[System: Your collaborative thread in #${channel.name} received a reply from User.]`);
    expect(aliceDebug?.contextText).toContain('[Bound task-message for this thread]');
    expect(aliceDebug?.contextText).toContain('#41 [in_progress] @oldpan — Human owned task');
    expect(aliceDebug?.contextText).toContain('@HumanTaskAlice (participant)');
    expect(aliceDebug?.contextText).toContain('@HumanTaskBob (participant)');
    expect(aliceDebug?.contextText).not.toContain('@oldpan (owner)');

    const extractParticipants = (text?: string | null) => (
      /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? ''
    );
    expect(extractParticipants(aliceDebug?.contextText)).toBe(extractParticipants(bobDebug?.contextText));
    expect(extractParticipants(aliceDebug?.contextText)).toBe(
      '@HumanTaskAlice (participant)\n@HumanTaskBob (participant)',
    );
  });

  it('GET /api/conversations 应列出已创建的会话', async () => {
    const { body } = await fetchJson('/api/conversations');
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  it('DELETE /api/conversations/:id 删除会话', async () => {
    const { body: conv } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'To Delete' }),
    });

    const { status } = await fetchJson(`/api/conversations/${conv.id}`, { method: 'DELETE' });
    expect(status).toBe(204);

    const found = manager.getConversation(conv.id);
    expect(found).toBeNull();
  });

  it('DELETE 不存在的 id 返回 404', async () => {
    const { status } = await fetchJson('/api/conversations/non-existent', { method: 'DELETE' });
    expect(status).toBe(404);
  });

  it('POST /api/channels 应支持 description 和初始 agentIds', async () => {
    const a1 = manager.createAgent({
      name: 'Bob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob',
    });
    const a2 = manager.createAgent({
      name: 'Tab',
      agentType: 'codex_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/tab',
    });

    const { status, body } = await fetchJson('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'eng-room',
        description: 'Engineering channel',
        agentIds: [a1.agentId, a2.agentId],
      }),
    });

    expect(status).toBe(201);
    expect(body.description).toBe('Engineering channel');
    expect(body.members.map((item: { agentId: string }) => item.agentId).sort()).toEqual([a1.agentId, a2.agentId].sort());

    const bob = manager.getAgent(a1.agentId);
    const tab = manager.getAgent(a2.agentId);
    expect(bob?.channelIds).toContain(body.channelId);
    expect(tab?.channelIds).toContain(body.channelId);
  });

  it('POST/DELETE /api/channels/:id/agents/:agentId 应以 channel 为中心管理成员', async () => {
    const channel = manager.createChannel({ name: 'membership-room' });
    const agent = manager.createAgent({
      name: 'JoinMe',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/join-me',
    });

    const joined = await fetchJson(`/api/channels/${channel.channelId}/agents/${agent.agentId}`, {
      method: 'POST',
    });
    expect(joined.status).toBe(200);
    expect(joined.body.members.map((item: { agentId: string }) => item.agentId)).toContain(agent.agentId);
    expect(manager.getAgent(agent.agentId)?.channelIds).toContain(channel.channelId);

    const left = await fetchJson(`/api/channels/${channel.channelId}/agents/${agent.agentId}`, {
      method: 'DELETE',
    });
    expect(left.status).toBe(200);
    expect(left.body.members.map((item: { agentId: string }) => item.agentId)).not.toContain(agent.agentId);
    expect(manager.getAgent(agent.agentId)?.channelIds).not.toContain(channel.channelId);
  });

  it('GET /api/channels/:id/tasks 应始终返回 task root thread', async () => {
    const now = Date.now();
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('feedbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Root task', ?, ?)`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, thread_unbound, created_at, updated_at)
       VALUES('task-list-root', 'default', 90, 'Root task', 'todo', 'feedbeef-0000-0000-0000-000000000000', 1, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO thread_task_bindings(channel_id, thread_root_id, task_id, bound_at)
       VALUES('default', 'legacy999', 'task-list-root', ?)`,
    ).run(now);

    const { status, body } = await fetchJson('/api/channels/default/tasks');

    expect(status).toBe(200);
    const task = (body.tasks as Array<{ taskId: string; linkedThreadShortId?: string | null }>).find((item) => item.taskId === 'task-list-root');
    expect(task?.linkedThreadShortId).toBe('feedbeef');
  });

  it('PATCH /api/channels/:id/tasks/:num/status 标记 done 时应清空 task root owner', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'PublicTaskBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/public-task-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('donebeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Done task', ?, ?)`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
       VALUES('task-public-done', 'default', 91, 'Done task', 'in_review', ?, ?, 'donebeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run(agent.agentId, agent.name, now, now);
    upsertTargetParticipant(db, {
      agentId: agent.agentId,
      channelId: 'default',
      threadRootId: 'donebeef',
      role: 'owner',
      lastActiveAt: now,
    });

    const { status } = await fetchJson('/api/channels/default/tasks/91/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });

    expect(status).toBe(200);
    const participant = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'donebeef'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(participant?.role).toBe('participant');
  });

  it('POST /api/channels/:id/tasks/claim-message 应自动认领并置为 in_progress', async () => {
    const now = Date.now();
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('claimfeed-0000-0000-0000-000000000000', 'default', 'user', 'User', 'user', '#default', 'Promote me', ?, ?)`,
    ).run(seq, now);

    const { status, body } = await fetchJson('/api/channels/default/tasks/claim-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({
        messageId: 'claimfeed',
        description: 'Goal: turn this into a tracked task. Done when the work is picked up and reviewed.',
      }),
    });

    expect(status).toBe(201);
    expect(body.status).toBe('in_progress');
    expect(body.assigneeName).toBe('Alice');
    expect(body.linkedThreadShortId).toBe('claimfee');
    expect(body.description).toContain('Goal: turn this into a tracked task');

    const messageRow = db.prepare(
      `SELECT message_kind as messageKind FROM channel_messages WHERE message_id = 'claimfeed-0000-0000-0000-000000000000'`,
    ).get() as { messageKind: string | null };
    expect(messageRow.messageKind).toBe('task');
  });

  it('POST /api/channels/:id/tasks 应要求 description，且创建 dedicated task message', async () => {
    const missingDescription = await fetchJson('/api/channels/default/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({ title: 'Missing brief' }),
    });
    expect(missingDescription.status).toBe(400);
    expect(missingDescription.body.error).toBe('description is required');

    const created = await fetchJson('/api/channels/default/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({
        title: 'Create dedicated task',
        description: 'Goal: verify new tasks require a brief. Done when the task stores the brief.',
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('Create dedicated task');
    expect(created.body.description).toContain('verify new tasks require a brief');

    const messageRow = db.prepare(
      `SELECT sender_type as senderType, message_kind as messageKind, content
       FROM channel_messages
       WHERE message_id = ?`,
    ).get(created.body.messageId) as { senderType: string; messageKind: string | null; content: string };
    expect(messageRow.senderType).toBe('system');
    expect(messageRow.messageKind).toBe('task');
    expect(messageRow.content).toBe('Create dedicated task');
  });

  it('POST /api/channels/:id/tasks/claim-message 应要求 description', async () => {
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES('nodebrief-0000-0000-0000-000000000000', 'default', 'user', 'User', 'user', '#default', 'Needs a task brief', ?, ?)`,
    ).run(seq, Date.now() - 1000);

    const result = await fetchJson('/api/channels/default/tasks/claim-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({ messageId: 'nodebrief' }),
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('description is required');
  });

  it('PATCH /api/channels/:id/tasks/:num 应更新 task brief，并仅同步 dedicated task root 标题', async () => {
    const dedicatedNow = Date.now() - 5000;
    const dedicatedSeq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('editroot0-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Old dedicated title', ?, ?, 'task')`,
    ).run(dedicatedSeq, dedicatedNow);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id, created_at, updated_at)
       VALUES('task-edit-dedicated', 'default', 120, 'Old dedicated title', 'Old brief', 'todo', 'editroot0-0000-0000-0000-000000000000', ?, ?)`,
    ).run(dedicatedNow, dedicatedNow);

    const promotedSeq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('editroot1-0000-0000-0000-000000000000', 'default', 'user', 'User', 'user', '#default', 'Original promoted content', ?, ?, 'task')`,
    ).run(promotedSeq, dedicatedNow - 2000);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id, created_at, updated_at)
       VALUES('task-edit-promoted', 'default', 121, 'Promoted task title', 'Old promoted brief', 'in_progress', 'editroot1-0000-0000-0000-000000000000', ?, ?)`,
    ).run(dedicatedNow, dedicatedNow);

    const dedicatedUpdate = await fetchJson('/api/channels/default/tasks/120', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({
        title: 'Updated dedicated title',
        description: 'Goal: update the dedicated task brief. Done when both title and brief change.',
      }),
    });
    expect(dedicatedUpdate.status).toBe(200);
    expect(dedicatedUpdate.body.title).toBe('Updated dedicated title');
    expect(dedicatedUpdate.body.description).toContain('both title and brief change');

    const dedicatedMessage = db.prepare(
      `SELECT content FROM channel_messages WHERE message_id = 'editroot0-0000-0000-0000-000000000000'`,
    ).get() as { content: string };
    expect(dedicatedMessage.content).toBe('Updated dedicated title');

    const promotedUpdate = await fetchJson('/api/channels/default/tasks/121', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({
        title: 'Updated promoted title',
        description: 'Goal: clarify the promoted task without rewriting the original message.',
      }),
    });
    expect(promotedUpdate.status).toBe(200);
    expect(promotedUpdate.body.title).toBe('Updated promoted title');

    const promotedMessage = db.prepare(
      `SELECT content FROM channel_messages WHERE message_id = 'editroot1-0000-0000-0000-000000000000'`,
    ).get() as { content: string };
    expect(promotedMessage.content).toBe('Original promoted content');
  });

  it('POST /api/channels/:id/tasks/:num/claim 与 /unclaim 应维护 assignee 与状态', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, created_at, updated_at)
       VALUES('task-claim-cycle', 'default', 193, 'Claim cycle', 'todo', ?, ?)`,
    ).run(now, now);

    const claimed = await fetchJson('/api/channels/default/tasks/193/claim', {
      method: 'POST',
      headers: { 'x-user-name': 'Alice' },
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.status).toBe('in_progress');
    expect(claimed.body.assigneeName).toBe('Alice');

    const unclaimed = await fetchJson('/api/channels/default/tasks/193/unclaim', {
      method: 'POST',
      headers: { 'x-user-name': 'Alice' },
    });
    expect(unclaimed.status).toBe(200);
    expect(unclaimed.body.status).toBe('todo');
    expect(unclaimed.body.assigneeName).toBeNull();
  });

  it('POST /api/channels/:id/tasks/:num/claim 传 agentId 时应指派 agent 并写入 kickoff thread reply', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'AssignMe',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/assign-me',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('assignfeed-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Assigned task root', ?, ?, 'task')`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id, created_at, updated_at)
       VALUES('task-agent-claim', 'default', 194, 'Assigned task', 'Goal: have the agent start from the task thread. Done when kickoff prompt is posted.', 'todo', 'assignfeed-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);

    const claimed = await fetchJson('/api/channels/default/tasks/194/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({ agentId: agent.agentId }),
    });

    expect(claimed.status).toBe(200);
    expect(claimed.body.status).toBe('in_progress');
    expect(claimed.body.assigneeId).toBe(agent.agentId);
    expect(claimed.body.assigneeName).toBe(agent.name);

    const owner = db.prepare(
      `SELECT role FROM target_participants
       WHERE agent_id = ? AND channel_id = 'default' AND thread_root_id = 'assignfe'`,
    ).get(agent.agentId) as { role: string } | undefined;
    expect(owner?.role).toBe('owner');

    const kickoff = db.prepare(
      `SELECT sender_name as senderName, content, thread_root_id as threadRootId
       FROM channel_messages
       WHERE channel_id = 'default' AND thread_root_id = 'assignfe'
       ORDER BY seq DESC
       LIMIT 1`,
    ).get() as { senderName: string; content: string; threadRootId: string };
    expect(kickoff.senderName).toBe('Alice');
    expect(kickoff.threadRootId).toBe('assignfe');
    expect(kickoff.content).toContain('@AssignMe');
    expect(kickoff.content).toContain('Task brief / goal / done criteria:');
    expect(kickoff.content).toContain('Goal: have the agent start from the task thread.');

    const branch = manager.listConversations().find((conversation) =>
      conversation.agentId === agent.agentId && conversation.channelId === 'default' && conversation.threadRootId === 'assignfe');
    expect(branch).toBeTruthy();
  });

  it('POST /api/channels/:id/tasks/:num/claim 指派 agent 时要求 task brief', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'NoBriefAgent',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/no-brief-agent',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('nobrief0-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'No brief task root', ?, ?, 'task')`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES('task-agent-no-brief', 'default', 195, 'No brief task', 'todo', 'nobrief0-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);

    const claimed = await fetchJson('/api/channels/default/tasks/195/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({ agentId: agent.agentId }),
    });

    expect(claimed.status).toBe(409);
    expect(claimed.body.error).toBe('Task brief is required before assigning to an agent');
  });

  it('POST /api/channels/:id/tasks/:num/unclaim 应允许释放 agent claim', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'ReleaseMe',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/release-me',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, created_at, updated_at)
       VALUES('task-release-agent', 'default', 196, 'Release task', 'Goal: unassign the agent.', 'in_progress', ?, ?, ?, ?)`,
    ).run(agent.agentId, agent.name, now, now);

    const released = await fetchJson('/api/channels/default/tasks/196/unclaim', {
      method: 'POST',
      headers: { 'x-user-name': 'Alice' },
    });

    expect(released.status).toBe(200);
    expect(released.body.status).toBe('todo');
    expect(released.body.assigneeId).toBeNull();
    expect(released.body.assigneeName).toBeNull();
  });

  it('PATCH /api/channels/:id/tasks/:num/status 应限制非 assignee 推进状态，但允许 review 决策', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, claimed_by_name, created_at, updated_at)
       VALUES('task-user-owned', 'default', 94, 'User owned', 'in_progress', 'Alice', ?, ?)`,
    ).run(now, now);

    const forbidden = await fetchJson('/api/channels/default/tasks/94/status', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Bob',
      },
      body: JSON.stringify({ status: 'in_review' }),
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toContain('task assignee');

    const invalidDone = await fetchJson('/api/channels/default/tasks/94/status', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Alice',
      },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(invalidDone.status).toBe(400);
    expect(invalidDone.body.error).toBe('Invalid transition: in_progress → done');

    db.prepare(
      `UPDATE tasks SET status = 'in_review', updated_at = ? WHERE task_id = 'task-user-owned'`,
    ).run(Date.now());

    const sendBack = await fetchJson('/api/channels/default/tasks/94/status', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Bob',
      },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(sendBack.status).toBe(200);
    expect(sendBack.body.status).toBe('in_progress');
    expect(sendBack.body.assigneeName).toBe('Alice');

    db.prepare(
      `UPDATE tasks SET status = 'in_review', updated_at = ? WHERE task_id = 'task-user-owned'`,
    ).run(Date.now());

    const done = await fetchJson('/api/channels/default/tasks/94/status', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-name': 'Bob',
      },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');
  });

  it('DELETE /api/channels/:id/tasks/:num 应清理 task root 的 participants 与 checkpoints', async () => {
    const now = Date.now();
    const agent = manager.createAgent({
      name: 'DeleteTaskBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/delete-task-bob',
      channelId: 'default',
    });
    manager.joinChannel(agent.agentId, 'default');
    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('deadbeef-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Delete me', ?, ?, 'task')`,
    ).run(seq, now);
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES('task-delete-root', 'default', 197, 'Delete me', 'todo', 'deadbeef-0000-0000-0000-000000000000', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO thread_task_bindings(channel_id, thread_root_id, task_id, bound_at)
       VALUES('default', 'legacydel', 'task-delete-root', ?)`,
    ).run(now);
    upsertTargetParticipant(db, {
      agentId: agent.agentId,
      channelId: 'default',
      threadRootId: 'deadbeef',
      role: 'owner',
      lastActiveAt: now,
    });
    db.prepare(
      `INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq)
       VALUES(?, 'default', 'deadbeef', 3)`,
    ).run(agent.agentId);

    const { status, body } = await fetchJson('/api/channels/default/tasks/197', {
      method: 'DELETE',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const participantsCount = db.prepare(
      `SELECT count(*) as count FROM target_participants WHERE channel_id = 'default' AND thread_root_id = 'deadbeef'`,
    ).get() as { count: number };
    const checkpointsCount = db.prepare(
      `SELECT count(*) as count FROM agent_message_checkpoints WHERE channel_id = 'default' AND thread_root_id = 'deadbeef'`,
    ).get() as { count: number };
    expect(participantsCount.count).toBe(0);
    expect(checkpointsCount.count).toBe(0);
  });

  it('POST /api/channels/:id/clear-chat 应清空 channel 消息、branch 历史与 tasks', async () => {
    const agent = manager.createAgent({
      name: 'ClearRoomBob',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/clear-room-bob',
    });
    manager.joinChannel(agent.agentId, 'default');
    const branch = manager.openAgentChannelThread(agent.agentId, 'default', null);
    expect(branch).not.toBeNull();
    if (!branch) throw new Error('missing branch conversation');

    const sessionRow = db.prepare(
      'SELECT session_key as sessionKey FROM conversations WHERE id = ?',
    ).get(branch.id) as { sessionKey: string };

    const seq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id)
       VALUES(?, 'default', 'user', 'User', 'user', '#default', 'hello', ?, ?, NULL, NULL)`,
    ).run(randomUUID(), seq, Date.now());
    db.prepare(
      'INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq) VALUES(?, ?, ?, ?)',
    ).run(agent.agentId, 'default', '', seq);
    db.prepare(
      'INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)',
    ).run('run-clear-channel', sessionRow.sessionKey, 'hello', Date.now());
    db.prepare(
      'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
    ).run('run-clear-channel', 1, 'node/event', JSON.stringify({ type: 'content.delta', text: 'hi' }), Date.now());
    db.prepare(
      'INSERT INTO conversation_prompt_queue(agent_id, conversation_id, prompt_text, created_at, updated_at) VALUES(?, ?, ?, ?, ?)',
    ).run(agent.agentId, branch.id, 'queued', Date.now(), Date.now());
    const taskSeq = allocateNextChannelMessageSeq(db, 'default');
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, message_kind)
       VALUES('clear7777-0000-0000-0000-000000000000', 'default', 'system', 'system', 'system', '#default', 'Clear task', ?, ?, 'task')`,
    ).run(taskSeq, Date.now());
    db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, created_at, updated_at)
       VALUES(?, 'default', 1, 'Clear task', 'todo', ?, ?, ?)`,
    ).run(randomUUID(), 'clear7777-0000-0000-0000-000000000000', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO thread_task_bindings(channel_id, thread_root_id, task_id, bound_at)
       VALUES('default', 'clear7777', (SELECT task_id FROM tasks WHERE channel_id = 'default' AND task_number = 1), ?)`,
    ).run(Date.now());

    const { status, body } = await fetchJson('/api/channels/default/clear-chat', {
      method: 'POST',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.clearedConversationIds).toContain(branch.id);

    const messageCount = db.prepare(
      `SELECT count(*) as count FROM channel_messages WHERE channel_id = 'default'`,
    ).get() as { count: number };
    const checkpointCount = db.prepare(
      `SELECT count(*) as count FROM agent_message_checkpoints WHERE channel_id = 'default'`,
    ).get() as { count: number };
    const oldRunCount = db.prepare(
      'SELECT count(*) as count FROM runs WHERE session_key = ?',
    ).get(sessionRow.sessionKey) as { count: number };
    const eventCount = db.prepare(
      `SELECT count(*) as count FROM events WHERE run_id = 'run-clear-channel'`,
    ).get() as { count: number };
    const queueCount = db.prepare(
      'SELECT count(*) as count FROM conversation_prompt_queue WHERE conversation_id = ?',
    ).get(branch.id) as { count: number };
    const taskCount = db.prepare(
      `SELECT count(*) as count FROM tasks WHERE channel_id = 'default'`,
    ).get() as { count: number };
    const bindingCount = db.prepare(
      `SELECT count(*) as count FROM thread_task_bindings WHERE channel_id = 'default'`,
    ).get() as { count: number };
    const taskSequenceCount = db.prepare(
      `SELECT count(*) as count FROM channel_task_sequences WHERE channel_id = 'default'`,
    ).get() as { count: number };

    expect(messageCount.count).toBe(0);
    expect(checkpointCount.count).toBe(0);
    expect(oldRunCount.count).toBe(0);
    expect(eventCount.count).toBe(0);
    expect(queueCount.count).toBe(0);
    expect(taskCount.count).toBe(0);
    expect(bindingCount.count).toBe(0);
    expect(taskSequenceCount.count).toBe(0);
  });
});

describe('WebSocket', () => {
  it('连接后应收到 conversation.status 和 history.complete', async () => {
    const { body: conv } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'WS Test' }),
    });

    const { ws, events } = await createWsConnection(conv.id);
    const received = await waitForEvents(events, 2);
    ws.close();

    expect(received[0].type).toBe('conversation.status');
    expect(received[0].conversationId).toBe(conv.id);
    expect(received[0].status).toBe('idle');
    expect(received[1].type).toBe('history.complete');

    manager.deleteConversation(conv.id);
  });

  it('连接不存在的会话应收到 error 并关闭', async () => {
    const { ws, events } = await createWsConnection('non-existent');
    const received = await waitForEvents(events, 1);

    expect(received[0].type).toBe('error');
    expect(received[0].message).toContain('not found');

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.on('close', () => resolve());
    });
  });

  it('未绑定 agent-node 时发送 prompt 应收到 error', async () => {
    const { body: conv } = await fetchJson('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Prompt Test' }),
    });

    const { ws, events } = await createWsConnection(conv.id);
    await waitForEvents(events, 2); // status + history.complete

    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }));

    const allEvents = await waitForEvents(events, 3);
    ws.close();

    const errorEvent = allEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('agent node');

    manager.deleteConversation(conv.id);
  });

  it('恢复中的未结束 run 回放时不应发送 turn.end', async () => {
    const conv = manager.createConversation({ title: 'Recovering Replay' });
    const sessionRow = db
      .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
      .get(conv.id) as { sessionKey: string };

    createRun(db, {
      runId: 'run-recovering-1',
      sessionKey: sessionRow.sessionKey,
      promptText: 'continue previous run',
    });
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('recovering', conv.id);
    db.prepare(
      `INSERT INTO events(run_id, seq, method, payload_json, created_at)
       VALUES(?, ?, 'node/event', ?, ?)`,
    ).run(
      'run-recovering-1',
      1,
      JSON.stringify({ type: 'content.delta', text: 'partial output' }),
      Date.now(),
    );

    const { ws, events } = await createWsConnection(conv.id);
    const received = await waitForEvents(events, 5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.close();

    expect(received[0]).toEqual({
      type: 'conversation.status',
      conversationId: conv.id,
      status: 'recovering',
    });
    expect(received[1]).toEqual({
      type: 'history.user_message',
      text: 'continue previous run',
    });
    expect(received[2].type).toBe('turn.begin');
    expect(received[3]).toEqual({
      type: 'content.delta',
      text: 'partial output',
    });
    expect(received[4]).toEqual({ type: 'history.complete' });
    expect(events.some((event) => event.type === 'turn.end')).toBe(false);

    manager.deleteConversation(conv.id);
  });
});
