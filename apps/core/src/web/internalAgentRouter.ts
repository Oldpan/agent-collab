import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@agent-collab/runtime-acp';
import type { ServerEvent } from '@agent-collab/protocol';
import type { ConversationManager } from './conversationManager.js';
import type { AgentSkillsService } from '../services/agentSkillsService.js';
import { AgentSkillsServiceError } from '../services/agentSkillsService.js';
import {
  bumpAgentMessageCheckpoint,
  checkpointThreadKey,
  getAgentMessageCheckpoint,
  setAgentMessageCheckpoint,
} from './messageCheckpoints.js';
import { buildTargetActivationContext } from './activationContext.js';
import { recordAgentMentionNotification, shouldTriggerAgentMention } from './agentMentionCooldowns.js';
import { buildChannelActivationContextText, buildChannelActivationPrompt } from './channelActivationPrompt.js';
import { findMentionedAgents } from './channelMentions.js';
import { resolveConversationReplyTarget } from './directReplyTargets.js';
import { setTargetOwner, upsertTargetParticipant } from './targetParticipants.js';
import { bindTaskToThread, getThreadBindingForTask } from './threadTaskBindings.js';
import { allocateNextChannelMessageSeq } from './channelMessageSequences.js';
import { isValidTransition } from './taskStatusTransitions.js';

const AGENT_MENTION_COOLDOWN_MS = 60_000;

type MessageRow = {
  messageId: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderType: string;
  target: string;
  content: string;
  seq: number;
  createdAt: number;
  threadRootId: string | null;
};

type TaskRow = {
  taskId: string;
  channelId: string;
  taskNumber: number;
  title: string;
  description?: string | null;
  status: string;
  claimedByAgentId: string | null;
  claimedByName: string | null;
  createdByAgentId: string | null;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
};

type ContextMsg = { senderName: string; senderType: string; content: string; seq: number };

/** 获取 task 对应消息之前的 K 条主线消息作为上下文 */
function fetchTaskContext(db: Db, channelId: string, messageId: string, limit = 8): ContextMsg[] {
  const seqRow = db.prepare(
    `SELECT seq FROM channel_messages WHERE message_id = ?`,
  ).get(messageId) as { seq: number } | undefined;
  if (!seqRow) return [];

  return (db.prepare(
    `SELECT cm.sender_name as senderName, cm.sender_type as senderType,
            cm.content, cm.seq
     FROM channel_messages cm
     WHERE cm.channel_id = ? AND cm.seq < ? AND cm.thread_root_id IS NULL
     ORDER BY cm.seq DESC LIMIT ?`,
  ).all(channelId, seqRow.seq, limit) as ContextMsg[]).reverse();
}

/**
 * Registers internal agent API routes — used by channel-bridge MCP server.
 *
 * These endpoints let agents (via the channel-bridge) send messages to channels,
 * poll for new messages, browse the server directory, and manage task boards.
 */
export function registerInternalAgentRoutes(
  app: FastifyInstance,
  db: Db,
  conversationManager: ConversationManager,
  broadcastToAgent: (agentId: string, event: ServerEvent, conversationId?: string) => void,
  broadcastToChannel: (channelId: string, event: ServerEvent) => void,
  humanUserName: string,
  skillsService?: AgentSkillsService,
  internalAuthToken?: string,
  attachmentsDir?: string,
): void {
  const broadcastChannelTasksChanged = (channelId: string) => {
    broadcastToChannel(channelId, {
      type: 'channel.tasks.changed',
      channelId,
      changedAt: Date.now(),
    });
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/internal/agent/')) return;
    if (!internalAuthToken) return;
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== internalAuthToken) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // ─── Messaging ───────────────────────────────────────────────────────────

  /**
   * POST /api/internal/agent/:agentId/send
   * Send a message to a target (channel, DM, or thread).
   * Body: { target: string; content: string; attachmentIds?: string[] }
   */
  app.post<{
    Params: { agentId: string };
    Body: {
      target?: string;
      content: string;
      kind?: 'progress' | 'final';
      attachmentIds?: string[];
      conversationId?: string;
    };
  }>('/api/internal/agent/:agentId/send', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { target, content, kind, conversationId, attachmentIds } = req.body ?? {};
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!normalizedContent) {
      reply.code(400);
      return { error: 'content must not be empty' };
    }
    if (kind && kind !== 'progress' && kind !== 'final') {
      reply.code(400);
      return { error: 'kind must be "progress" or "final"' };
    }

    if (conversationId) {
      const conversation = conversationManager.getConversation(conversationId);
      if (!conversation || conversation.agentId !== agentId) {
        reply.code(400);
        return { error: 'conversationId does not belong to this agent' };
      }
    }

    const defaultTarget = conversationId ? resolveDefaultReplyTarget(db, conversationId, humanUserName) : null;
    const initialTarget = target?.trim() || defaultTarget;
    if (!initialTarget) {
      reply.code(400);
      return { error: 'target is required unless conversationId is provided for the current conversation reply' };
    }
    const resolvedTarget = conversationId
      ? normalizeTargetForConversation(db, conversationId, initialTarget)
      : initialTarget;

    // For DM targets that don't resolve to a known agent (e.g. dm:@User — a human),
    // fall back to the sending agent's own DM channel so the reply is visible to frontend.
    const channelId = resolveChannelFromTarget(resolvedTarget, db) ?? (resolvedTarget.startsWith('dm:') ? `dm:${agentId}` : null);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel from target: ${resolvedTarget}` };
    }

    const now = Date.now();
    const messageId = randomUUID();
    const seq = allocateNextChannelMessageSeq(db, channelId);
    const runId = conversationId ? findActiveConversationRunId(db, conversationId) : null;
    const threadRootId = resolveThreadRootId(resolvedTarget);

    const attachmentIdsJson = Array.isArray(attachmentIds) && attachmentIds.length > 0
      ? JSON.stringify(attachmentIds)
      : null;
    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind, message_source, attachment_ids)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      channelId,
      agentId,
      agent.name,
      resolvedTarget,
      normalizedContent,
      seq,
      now,
      runId,
      threadRootId,
      kind ?? null,
      'agent_send',
      attachmentIdsJson,
    );

    if (!channelId.startsWith('dm:')) {
      upsertTargetParticipant(db, {
        agentId,
        channelId,
        threadRootId,
        role: threadRootId ? 'participant' : 'participant',
        lastActiveAt: now,
      });
    }

    const channelMessageEvent: ServerEvent = {
      type: 'channel.message',
      message: {
        id: messageId,
        senderName: agent.name,
        senderType: 'agent',
        content: normalizedContent,
        createdAt: new Date(now).toISOString(),
        seq,
        ...(threadRootId ? { threadRootId } : {}),
      },
    };

    broadcastToAgent(agentId, channelMessageEvent, conversationId);

    // Public channels (not DMs) also broadcast to channel-level WS subscribers
    if (!channelId.startsWith('dm:')) {
      broadcastToChannel(channelId, channelMessageEvent);
    }

    if (!channelId.startsWith('dm:')) {
      const channel = conversationManager.getChannel(channelId);
      const mentionableAgents = conversationManager
        .listAgents(channelId)
        .filter((candidate) => candidate.agentId !== agentId);
      const mentionedAgents = findMentionedAgents(normalizedContent, mentionableAgents);

      for (const mentionedAgent of mentionedAgents) {
        if (!shouldTriggerAgentMention(db, {
          channelId,
          threadRootId,
          fromAgentId: agentId,
          toAgentId: mentionedAgent.agentId,
          now,
          cooldownMs: AGENT_MENTION_COOLDOWN_MS,
        })) {
          continue;
        }

        const conv = conversationManager.openAgentChannelThread(mentionedAgent.agentId, channelId, threadRootId ?? null);
        if (!conv || !channel) continue;

        upsertTargetParticipant(db, {
          agentId: mentionedAgent.agentId,
          channelId,
          threadRootId,
          role: 'participant',
          lastActiveAt: now,
        });

        const activationContext = buildTargetActivationContext(db, {
          agentId: mentionedAgent.agentId,
          channelId,
          replyTarget: conv.replyTarget ?? resolvedTarget,
          triggerSeq: seq,
          threadRootId,
        });

        recordAgentMentionNotification(db, {
          channelId,
          threadRootId,
          fromAgentId: agentId,
          toAgentId: mentionedAgent.agentId,
          notifiedAt: now,
        });

        broadcastToChannel(channelId, {
          type: 'channel.notice',
          notice: {
            message: `@${mentionedAgent.name} was mentioned by @${agent.name} and notified.`,
            createdAt: new Date(now).toISOString(),
          },
        });

        conversationManager.submitPrompt(
          conv.id,
          buildChannelActivationPrompt({
            channelName: channel.name,
            target: resolvedTarget,
            replyTarget: activationContext.replyTarget,
            senderName: agent.name,
            content: normalizedContent,
            reason: 'agent_mention',
          }),
          {
            recordAsUserMessage: false,
            activationContextText: buildChannelActivationContextText({
              target: resolvedTarget,
              recentMessages: activationContext.recentMessages,
              rootMessage: activationContext.rootMessage,
              unreadCount: activationContext.unreadCount,
              oldestVisibleSeq: activationContext.oldestVisibleSeq,
              participants: activationContext.participants,
              boundTask: activationContext.boundTask,
              openTasks: activationContext.openTasks,
            }) || undefined,
          },
        ).then(() => {
          bumpAgentMessageCheckpoint(db, mentionedAgent.agentId, channelId, seq, threadRootId);
        }).catch(() => {});
      }
    }

    return { messageId, seq, runId, target: resolvedTarget, kind: kind ?? null };
  });

  /**
   * POST /api/internal/agent/:agentId/upload
   * Upload a file (image) and store it as an attachment.
   * Multipart form: file field + optional channelId text field.
   * Returns { id, filename, sizeBytes }.
   */
  app.post<{ Params: { agentId: string } }>(
    '/api/internal/agent/:agentId/upload',
    async (req, reply) => {
      const { agentId } = req.params;
      if (!conversationManager.getAgent(agentId)) {
        reply.code(404);
        return { error: 'Agent not found' };
      }
      if (!attachmentsDir) {
        reply.code(503);
        return { error: 'Attachment storage not configured' };
      }

      const data = await req.file();
      if (!data) { reply.code(400); return { error: 'No file uploaded' }; }

      const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedMimes.includes(data.mimetype)) {
        reply.code(400);
        return { error: `Unsupported file type: ${data.mimetype}. Allowed: JPEG, PNG, GIF, WebP` };
      }

      const buffer = await data.toBuffer();
      if (buffer.length > 5 * 1024 * 1024) {
        reply.code(400);
        return { error: 'File too large (max 5MB)' };
      }

      const id = randomUUID();
      const ext = extname(data.filename) || '.bin';
      const storagePath = join(attachmentsDir, `${id}${ext}`);
      writeFileSync(storagePath, buffer);

      // Optional channelId from form fields
      const fields = data.fields as Record<string, { value?: string }> | undefined;
      const channelId = fields?.channelId?.value ?? null;

      db.prepare(
        `INSERT INTO attachments(id, filename, mime_type, size_bytes, storage_path, channel_id, agent_id, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, data.filename, data.mimetype, buffer.length, storagePath, channelId, agentId, Date.now());

      return { id, filename: data.filename, sizeBytes: buffer.length };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/receive
   * Poll for new messages since the agent's last-read checkpoint.
   * Returns immediately with pending messages (or empty array).
   */
  app.get<{ Params: { agentId: string }; Querystring: { channel?: string } }>(
    '/api/internal/agent/:agentId/receive',
    async (req, reply) => {
      const { agentId } = req.params;
      if (!conversationManager.getAgent(agentId)) {
        reply.code(404);
        return { error: 'Agent not found' };
      }

      // Query all channels the agent has joined, plus the user DM channel
      const agent = conversationManager.getAgent(agentId)!;
      const dmChannelId = `dm:${agentId}`;

      let channelsToQuery: string[];
      const channelFilter = req.query.channel?.trim();
      if (channelFilter) {
        const filteredId = resolveChannelFromTarget(channelFilter, db)
          ?? (channelFilter.startsWith('dm:') ? dmChannelId : null);
        if (!filteredId) {
          reply.code(400);
          return { error: `Cannot resolve channel: ${channelFilter}` };
        }
        const memberOf = new Set([...(agent.channelIds ?? []), dmChannelId]);
        channelsToQuery = memberOf.has(filteredId) ? [filteredId] : [];
      } else {
        channelsToQuery = Array.from(new Set([...(agent.channelIds ?? []), dmChannelId]));
      }

      let allRows: MessageRow[] = [];
      for (const channelId of channelsToQuery) {
        const threadKeys = (
          db.prepare(
            `SELECT DISTINCT COALESCE(thread_root_id, '') as threadKey
             FROM channel_messages
             WHERE channel_id = ? AND sender_id != ?
             ORDER BY threadKey ASC`,
          ).all(channelId, agentId) as Array<{ threadKey: string }>
        ).map((row) => row.threadKey);

        for (const threadKey of threadKeys) {
          const checkpoint = getAgentMessageCheckpoint(db, agentId, channelId, threadKey || null);
          const rows = db
          .prepare(
            `SELECT cm.message_id as messageId, cm.channel_id as channelId, cm.sender_id as senderId,
                    cm.sender_name as senderName, cm.sender_type as senderType,
                    cm.target, cm.content, cm.seq, cm.created_at as createdAt, cm.thread_root_id as threadRootId,
                    t.task_number as taskNumber, t.status as taskStatus, t.claimed_by_name as taskAssigneeName
             FROM channel_messages cm
             LEFT JOIN tasks t ON t.message_id = cm.message_id
             WHERE cm.channel_id = ? AND cm.seq > ? AND cm.sender_id != ? AND COALESCE(cm.thread_root_id, '') = ?
             ORDER BY cm.seq ASC
             LIMIT 50`,
          )
          .all(channelId, checkpoint, agentId, threadKey) as MessageRow[];

          allRows = allRows.concat(rows);
        }
      }

      // Merge and sort by createdAt
      const rows = allRows
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
        .slice(0, 50);

      if (rows.length > 0) {
        const maxSeqByThread = new Map<string, { channelId: string; threadKey: string; maxSeq: number }>();
        for (const row of rows) {
          const threadKey = checkpointThreadKey(row.threadRootId);
          const aggregateKey = `${row.channelId}::${threadKey}`;
          const current = maxSeqByThread.get(aggregateKey);
          if (!current || row.seq > current.maxSeq) {
            maxSeqByThread.set(aggregateKey, { channelId: row.channelId, threadKey, maxSeq: row.seq });
          }
        }
        for (const { channelId, threadKey, maxSeq } of maxSeqByThread.values()) {
          setAgentMessageCheckpoint(db, agentId, channelId, maxSeq, threadKey || null);
        }
      }

      const messages = rows.map((r) => ({
        message_id: r.messageId,
        channel_id: r.channelId,
        sender_id: r.senderId,
        sender_name: r.senderName,
        sender_type: r.senderType,
        target: r.target,
        content: r.content,
        seq: r.seq,
        timestamp: new Date(r.createdAt).toISOString(),
        ...((r as MessageRow & { taskNumber?: number | null; taskStatus?: string | null; taskAssigneeName?: string | null }).taskNumber != null ? {
          task_number: (r as MessageRow & { taskNumber?: number | null }).taskNumber,
          task_status: (r as MessageRow & { taskStatus?: string | null }).taskStatus,
          task_assignee_name: (r as MessageRow & { taskAssigneeName?: string | null }).taskAssigneeName,
        } : {}),
      }));

      return { messages };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/server
   * Returns channels (with joined status), other agents, and humans.
   */
  app.get<{ Params: { agentId: string } }>(
    '/api/internal/agent/:agentId/server',
    async (req, reply) => {
      const { agentId } = req.params;
      const agent = conversationManager.getAgent(agentId);
      if (!agent) {
        reply.code(404);
        return { error: 'Agent not found' };
      }

      const joinedSet = new Set(agent.channelIds ?? []);
      const channels = conversationManager.listChannels().map((ch) => ({
        name: ch.name,
        joined: joinedSet.has(ch.channelId),
        description: ch.description,
      }));

      const allAgents = conversationManager.listAgents().filter((a) => a.agentId !== agentId);
      const agents = allAgents.map((a) => ({
        name: a.name,
        status: 'online',
      }));

      const humanRows = db.prepare(
        `SELECT DISTINCT sender_name as name FROM channel_messages
         WHERE sender_type = 'user' ORDER BY created_at DESC LIMIT 20`,
      ).all() as Array<{ name: string }>;
      const humans = humanRows;

      return { channels, agents, humans };
    },
  );

  /**
   * GET /api/internal/agent/:agentId/history
   * Read message history for a target.
   * Query: channel (target string), limit?, before?, after?
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { channel: string; limit?: string; before?: string; after?: string };
  }>('/api/internal/agent/:agentId/history', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, limit: limitStr, before: beforeStr, after: afterStr } = req.query;
    if (!channel) {
      reply.code(400);
      return { error: 'channel query parameter is required' };
    }

    const channelId = resolveChannelFromTarget(channel, db) ?? (channel.startsWith('dm:') ? `dm:${agentId}` : null);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }
    if (channel.startsWith('#') && !(agent.channelIds ?? []).includes(channelId)) {
      reply.code(403);
      return { error: 'Agent is not a member of this channel' };
    }

    const limit = Math.min(Number(limitStr ?? 50), 100);
    const before = beforeStr ? Number(beforeStr) : undefined;
    const after = afterStr ? Number(afterStr) : undefined;
    // Thread filter: "#channel:shortId" reads thread; "#channel" reads main channel only
    const targetThreadRootId = resolveThreadRootId(channel);
    const threadFilter = targetThreadRootId !== null
      ? `AND thread_root_id = '${targetThreadRootId.replace(/'/g, "''")}'`
      : `AND thread_root_id IS NULL`;

    const taskJoinSelect = `cm.message_id as messageId, cm.channel_id as channelId, cm.sender_id as senderId,
                  cm.sender_name as senderName, cm.sender_type as senderType,
                  cm.target, cm.content, cm.seq, cm.created_at as createdAt,
                  t.task_number as taskNumber, t.status as taskStatus, t.claimed_by_name as taskAssigneeName`;
    const taskJoin = `LEFT JOIN tasks t ON t.message_id = cm.message_id`;

    let rows: MessageRow[];
    if (after !== undefined) {
      rows = db
        .prepare(
          `SELECT ${taskJoinSelect}
           FROM channel_messages cm ${taskJoin}
           WHERE cm.channel_id = ? AND cm.seq > ? ${threadFilter.replace(/\bthread_root_id\b/g, 'cm.thread_root_id')}
           ORDER BY cm.seq ASC LIMIT ?`,
        )
        .all(channelId, after, limit) as MessageRow[];
    } else if (before !== undefined) {
      rows = db
        .prepare(
          `SELECT ${taskJoinSelect}
           FROM channel_messages cm ${taskJoin}
           WHERE cm.channel_id = ? AND cm.seq < ? ${threadFilter.replace(/\bthread_root_id\b/g, 'cm.thread_root_id')}
           ORDER BY cm.seq DESC LIMIT ?`,
        )
        .all(channelId, before, limit).reverse() as MessageRow[];
    } else {
      rows = db
        .prepare(
          `SELECT ${taskJoinSelect}
           FROM channel_messages cm ${taskJoin}
           WHERE cm.channel_id = ? ${threadFilter.replace(/\bthread_root_id\b/g, 'cm.thread_root_id')}
           ORDER BY cm.seq DESC LIMIT ?`,
        )
        .all(channelId, limit).reverse() as MessageRow[];
    }

    const hasMore = rows.length === limit;
    const messages = rows.map((r) => {
      const ext = r as MessageRow & { taskNumber?: number | null; taskStatus?: string | null; taskAssigneeName?: string | null };
      return {
        id: r.messageId,
        senderName: r.senderName,
        senderType: r.senderType,
        content: r.content,
        seq: r.seq,
        createdAt: new Date(r.createdAt).toISOString(),
        ...(ext.taskNumber != null ? {
          taskNumber: ext.taskNumber,
          taskStatus: ext.taskStatus,
          taskAssigneeName: ext.taskAssigneeName,
        } : {}),
      };
    });

    return { messages, has_more: hasMore };
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { path?: string };
  }>('/api/internal/agent/:agentId/skills', async (req, reply) => {
    if (!skillsService) {
      reply.code(503);
      return { error: 'Skill service unavailable' };
    }
    if (!conversationManager.getAgent(req.params.agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    try {
      return await skillsService.listSkills(req.params.agentId, normalizeSkillPath(req.query.path));
    } catch (error) {
      if (error instanceof AgentSkillsServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { path?: string };
  }>('/api/internal/agent/:agentId/skills/file', async (req, reply) => {
    if (!skillsService) {
      reply.code(503);
      return { error: 'Skill service unavailable' };
    }
    if (!conversationManager.getAgent(req.params.agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const skillPath = normalizeSkillPath(req.query.path);
    if (!skillPath) {
      reply.code(400);
      return { error: 'path query parameter is required' };
    }

    try {
      return await skillsService.readSkillFile(req.params.agentId, skillPath);
    } catch (error) {
      if (error instanceof AgentSkillsServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      reply.code(500);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  // ─── Task board ──────────────────────────────────────────────────────────

  /**
   * GET /api/internal/agent/:agentId/tasks
   * List tasks for a channel.
   * Query: channel (target string), status?
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { channel: string; status?: string };
  }>('/api/internal/agent/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, status } = req.query;
    if (!channel) {
      reply.code(400);
      return { error: 'channel query parameter is required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const rows: TaskRow[] = status && status !== 'all'
      ? db
        .prepare(
          `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                  title, description, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt,
                  message_id as messageId
           FROM tasks WHERE channel_id = ? AND status = ? ORDER BY task_number ASC`,
        )
        .all(channelId, status) as TaskRow[]
      : db
        .prepare(
          `SELECT task_id as taskId, channel_id as channelId, task_number as taskNumber,
                  title, description, status, claimed_by_agent_id as claimedByAgentId,
                  claimed_by_name as claimedByName, created_by_agent_id as createdByAgentId,
                  created_by_name as createdByName, created_at as createdAt, updated_at as updatedAt,
                  message_id as messageId
           FROM tasks WHERE channel_id = ? ORDER BY task_number ASC`,
        )
        .all(channelId) as TaskRow[];

    const tasks = rows.map((r) => ({
      taskId: r.taskId,
      taskNumber: r.taskNumber,
      title: r.title,
      description: r.description ?? null,
      status: r.status,
      claimedByName: r.claimedByName,
      createdByName: r.createdByName,
      messageId: (r as TaskRow & { messageId?: string | null }).messageId ?? null,
    }));

    return { tasks };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks
   * Create one or more tasks on a channel's task board.
   * Body: { channel: string; tasks: Array<{ title: string }> }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; tasks: Array<{ title: string; description?: string }> };
  }>('/api/internal/agent/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, tasks } = req.body ?? {};
    if (!channel || !Array.isArray(tasks) || tasks.length === 0) {
      reply.code(400);
      return { error: 'channel and non-empty tasks array are required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const now = Date.now();
    const created: Array<{ taskId: string; taskNumber: number; title: string; messageId: string }> = [];

    const channelRow = db.prepare('SELECT name FROM channels WHERE channel_id = ?').get(channelId) as { name: string } | undefined;
    const channelName = channelRow?.name ?? channelId;

    const insertMessage = db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, NULL, NULL, 'task')`,
    );

    const insertTask = db.prepare(
      `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, message_id,
                         created_by_agent_id, created_by_name, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
    );

    for (const taskDef of tasks) {
      const taskId = randomUUID();
      const messageId = randomUUID();
      const taskNumber = nextTaskNumber(db, channelId);
      const seq = allocateNextChannelMessageSeq(db, channelId);
      const target = `#${channelName}`;
      insertMessage.run(messageId, channelId, agentId, agent.name, target, taskDef.title, seq, now);
      insertTask.run(taskId, channelId, taskNumber, taskDef.title, taskDef.description ?? null, messageId, agentId, agent.name, now, now);
      created.push({ taskId, taskNumber, title: taskDef.title, messageId });
      broadcastToChannel(channelId, {
        type: 'channel.message',
        message: {
          id: messageId, senderName: agent.name, senderType: 'agent', content: taskDef.title,
          createdAt: new Date(now).toISOString(), seq,
          taskNumber, taskStatus: 'todo', taskAssigneeName: null,
        },
      });
    }

    if (created.length > 0) broadcastChannelTasksChanged(channelId);

    reply.code(201);
    return { tasks: created };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/claim-message
   * Promote one or more existing messages to tasks (Slock-style claim by message_id).
   * Body: { channel: string; message_ids: string[]; title?: string }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; message_ids: string[]; title?: string };
  }>('/api/internal/agent/:agentId/tasks/claim-message', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) { reply.code(404); return { error: 'Agent not found' }; }

    const { channel, message_ids, title } = req.body ?? {};
    if (!channel || !Array.isArray(message_ids) || message_ids.length === 0) {
      reply.code(400);
      return { error: 'channel and non-empty message_ids array are required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) { reply.code(400); return { error: `Cannot resolve channel: ${channel}` }; }

    const now = Date.now();
    const results: Array<{ messageId: string; taskNumber?: number; success: boolean; reason?: string; context?: ContextMsg[] }> = [];
    let changed = false;

    for (const msgShortId of message_ids) {
      // Accept both full UUIDs and 8-char short IDs
      const msg = db.prepare(
        `SELECT message_id, content, thread_root_id FROM channel_messages WHERE message_id LIKE ? AND channel_id = ?`,
      ).get(`${msgShortId}%`, channelId) as { message_id: string; content: string; thread_root_id: string | null } | undefined;

      if (!msg) { results.push({ messageId: msgShortId, success: false, reason: 'Message not found' }); continue; }
      if (msg.thread_root_id) { results.push({ messageId: msgShortId, success: false, reason: 'Cannot promote a thread reply to task' }); continue; }

      const existing = db.prepare(`SELECT task_id FROM tasks WHERE message_id = ?`).get(msg.message_id) as { task_id: string } | undefined;
      if (existing) { results.push({ messageId: msgShortId, success: false, reason: 'Message is already a task' }); continue; }

      const taskId = randomUUID();
      const taskNumber = nextTaskNumber(db, channelId);
      const taskTitle = title?.trim() || msg.content.slice(0, 120);
      db.prepare(
        `INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id,
                           claimed_by_agent_id, claimed_by_name,
                           created_by_agent_id, created_by_name, created_at, updated_at)
         VALUES(?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(taskId, channelId, taskNumber, taskTitle, msg.message_id, agentId, agent.name, agentId, agent.name, now, now);
      db.prepare(`UPDATE channel_messages SET message_kind = 'task' WHERE message_id = ?`).run(msg.message_id);
      changed = true;

      results.push({
        messageId: msg.message_id, taskNumber, success: true,
        context: fetchTaskContext(db, channelId, msg.message_id),
      });
    }

    if (changed) broadcastChannelTasksChanged(channelId);

    reply.code(201);
    return { results };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/claim
   * Claim one or more tasks atomically (prevents race conditions).
   * Body: { channel: string; task_numbers: number[] }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_numbers: number[]; conversationId?: string };
  }>('/api/internal/agent/:agentId/tasks/claim', async (req, reply) => {
    const { agentId } = req.params;
    const agent = conversationManager.getAgent(agentId);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_numbers, conversationId } = req.body ?? {};
    if (!channel || !Array.isArray(task_numbers)) {
      reply.code(400);
      return { error: 'channel and task_numbers array are required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const now = Date.now();
    const results: Array<{ taskNumber: number; success: boolean; reason?: string; messageId?: string | null; context?: ContextMsg[] }> = [];
    const threadBinding = resolveThreadBindingContext(db, conversationId, channelId);
    let changed = false;

    for (const taskNumber of task_numbers) {
      const row = db
        .prepare(
          `SELECT task_id as taskId, status, claimed_by_agent_id as claimedByAgentId, message_id as messageId
           FROM tasks WHERE channel_id = ? AND task_number = ?`,
        )
        .get(channelId, taskNumber) as {
          taskId: string;
          status: string;
          claimedByAgentId: string | null;
          messageId: string | null;
        } | undefined;

      if (!row) {
        results.push({ taskNumber, success: false, reason: 'Task not found' });
        continue;
      }
      if (row.claimedByAgentId && row.claimedByAgentId !== agentId) {
        results.push({ taskNumber, success: false, reason: 'Already claimed by another agent' });
        continue;
      }
      if (row.status === 'done') {
        results.push({ taskNumber, success: false, reason: 'Task is already done' });
        continue;
      }

      if (threadBinding.threadRootId) {
        const bindResult = bindTaskToThread(db, {
          channelId,
          threadRootId: threadBinding.threadRootId,
          taskId: row.taskId,
          boundAt: now,
        });
        if (!bindResult.ok) {
          results.push({ taskNumber, success: false, reason: bindResult.reason });
          continue;
        }
      }

      const newStatus = row.status === 'todo' ? 'in_progress' : row.status;
      db.prepare(
        `UPDATE tasks SET claimed_by_agent_id = ?, claimed_by_name = ?, status = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(agentId, agent.name, newStatus, now, row.taskId);
      changed = true;

      const ownerBinding = threadBinding.threadRootId
        ? { channelId, threadRootId: threadBinding.threadRootId }
        : getThreadBindingForTask(db, row.taskId);
      if (ownerBinding) {
        setTargetOwner(db, {
          channelId: ownerBinding.channelId,
          threadRootId: ownerBinding.threadRootId,
          agentId,
          lastActiveAt: now,
        });
      }

      results.push({
        taskNumber, success: true, messageId: row.messageId ?? null,
        context: row.messageId ? fetchTaskContext(db, channelId, row.messageId) : [],
      });
    }

    if (changed) broadcastChannelTasksChanged(channelId);

    return { results };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/unclaim
   * Release the agent's claim on a task.
   * Body: { channel: string; task_number: number }
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_number: number };
  }>('/api/internal/agent/:agentId/tasks/unclaim', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_number } = req.body ?? {};
    if (!channel || task_number == null) {
      reply.code(400);
      return { error: 'channel and task_number are required' };
    }

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const row = db
      .prepare(
        `SELECT task_id as taskId, claimed_by_agent_id as claimedByAgentId, status
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      )
      .get(channelId, task_number) as { taskId: string; claimedByAgentId: string | null; status: 'todo' | 'in_progress' | 'in_review' | 'done' } | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    if (row.claimedByAgentId !== agentId) {
      reply.code(403);
      return { error: 'You do not own this task' };
    }

    const newStatus = row.status === 'in_progress' ? 'todo' : row.status;
    db.prepare(
      `UPDATE tasks SET claimed_by_agent_id = NULL, claimed_by_name = NULL, status = ?, updated_at = ?
       WHERE task_id = ?`,
    ).run(newStatus, Date.now(), row.taskId);

    const binding = getThreadBindingForTask(db, row.taskId);
    if (binding) {
      setTargetOwner(db, {
        channelId: binding.channelId,
        threadRootId: binding.threadRootId,
        agentId: null,
        lastActiveAt: Date.now(),
      });
    }

    broadcastChannelTasksChanged(channelId);

    return { ok: true };
  });

  /**
   * POST /api/internal/agent/:agentId/tasks/update-status
   * Update a task's progress status.
   * Body: { channel: string; task_number: number; status: string }
   * Valid transitions: todo→in_progress, in_progress→in_review, in_progress→done,
   *                    in_review→done, in_review→in_progress
   */
  app.post<{
    Params: { agentId: string };
    Body: { channel: string; task_number: number; status: string };
  }>('/api/internal/agent/:agentId/tasks/update-status', async (req, reply) => {
    const { agentId } = req.params;
    if (!conversationManager.getAgent(agentId)) {
      reply.code(404);
      return { error: 'Agent not found' };
    }

    const { channel, task_number, status } = req.body ?? {};
    if (!channel || task_number == null || !status) {
      reply.code(400);
      return { error: 'channel, task_number, and status are required' };
    }

    const validStatuses = ['todo', 'in_progress', 'in_review', 'done'];
    if (!validStatuses.includes(status)) {
      reply.code(400);
      return { error: `Invalid status: ${status}` };
    }
    const nextStatus = status as 'todo' | 'in_progress' | 'in_review' | 'done';

    const channelId = resolveChannelFromTarget(channel, db);
    if (!channelId) {
      reply.code(400);
      return { error: `Cannot resolve channel: ${channel}` };
    }

    const row = db
      .prepare(
        `SELECT task_id as taskId, status as currentStatus, claimed_by_agent_id as claimedByAgentId
         FROM tasks WHERE channel_id = ? AND task_number = ?`,
      )
      .get(channelId, task_number) as {
        taskId: string;
        currentStatus: 'todo' | 'in_progress' | 'in_review' | 'done';
        claimedByAgentId: string | null;
      } | undefined;

    if (!row) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    if (!isValidTransition(row.currentStatus, nextStatus)) {
      reply.code(400);
      return { error: `Invalid transition: ${row.currentStatus} → ${nextStatus}` };
    }

    // in_review→done is allowed by anyone; other transitions require the assignee
    const isReviewToDone = row.currentStatus === 'in_review' && nextStatus === 'done';
    if (!isReviewToDone && row.claimedByAgentId !== agentId) {
      reply.code(403);
      return { error: 'You must be the task assignee to update its status' };
    }

    db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?`).run(
      nextStatus,
      Date.now(),
      row.taskId,
    );

    const binding = getThreadBindingForTask(db, row.taskId);
    if (binding) {
      setTargetOwner(db, {
        channelId: binding.channelId,
        threadRootId: binding.threadRootId,
        agentId: nextStatus === 'done' ? null : (row.claimedByAgentId ?? null),
        lastActiveAt: Date.now(),
      });
    }

    broadcastChannelTasksChanged(channelId);

    return { ok: true, taskNumber: task_number, status: nextStatus };
  });
}

function normalizeSkillPath(rawPath?: string): string | null {
  const trimmed = (rawPath ?? '').trim();
  return trimmed || null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves a target string (e.g. "#general", "dm:@alice", "#general:msgid") to a channelId.
 * For now, targets are resolved by channel name. DM and thread targets use the base channel.
 */
function resolveChannelFromTarget(target: string, db: Db): string | null {
  // "#channel:threadid" or "#channel"
  const channelMatch = target.match(/^#([^:]+)/);
  if (channelMatch) {
    const name = channelMatch[1];
    const row = db
      .prepare('SELECT channel_id as channelId FROM channels WHERE name = ?')
      .get(name) as { channelId: string } | undefined;
    return row?.channelId ?? null;
  }

  // "dm:@agentname" or "dm:@agentname:threadid" — resolve to dm:{agentId} virtual channel
  if (target.startsWith('dm:')) {
    const match = target.match(/^dm:@([^:]+)/);
    if (match) {
      const agentName = match[1];
      const agentRow = db
        .prepare('SELECT agent_id as agentId FROM agents WHERE name = ?')
        .get(agentName) as { agentId: string } | undefined;
      if (agentRow) return `dm:${agentRow.agentId}`;
    }
    // Non-agent DM target (e.g. dm:@User) — return null so the caller can fall back to dm:{agentId}
    return null;
  }

  return null;
}

function resolveDefaultReplyTarget(db: Db, conversationId: string, humanUserName: string): string | null {
  return resolveConversationReplyTarget(db, conversationId, humanUserName);
}

function normalizeTargetForConversation(db: Db, conversationId: string, target: string): string {
  const row = db.prepare(
    `SELECT c.channel_id as channelId, c.thread_kind as threadKind, c.thread_root_id as threadRootId,
            ch.name as channelName
     FROM conversations c
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`,
  ).get(conversationId) as {
    channelId: string;
    threadKind: 'direct' | 'branch';
    threadRootId: string | null;
    channelName: string | null;
  } | undefined;

  if (!row || row.threadKind !== 'branch' || row.threadRootId) return target;

  const channelName = row.channelName ?? row.channelId;
  const canonicalBaseTarget = `#${channelName}`;
  const sameChannelThread = target.match(/^#([^:]+):([a-zA-Z0-9]+)$/);
  if (sameChannelThread) {
    const [, targetChannel] = sameChannelThread;
    if (targetChannel === channelName || targetChannel === row.channelId) {
      return canonicalBaseTarget;
    }
  }

  return target;
}

function resolveThreadBindingContext(
  db: Db,
  conversationId: string | undefined,
  channelId: string,
): { threadRootId: string | null } {
  if (!conversationId) return { threadRootId: null };
  const row = db.prepare(
    `SELECT channel_id as channelId, thread_kind as threadKind, thread_root_id as threadRootId
     FROM conversations
     WHERE id = ?`,
  ).get(conversationId) as {
    channelId: string;
    threadKind: 'direct' | 'branch';
    threadRootId: string | null;
  } | undefined;

  if (!row || row.channelId !== channelId || row.threadKind !== 'branch' || !row.threadRootId) {
    return { threadRootId: null };
  }
  return { threadRootId: row.threadRootId };
}

/** Extracts the thread shortId from targets like "#general:a1b2c3d4". Returns null for non-thread targets. */
function resolveThreadRootId(target: string): string | null {
  const match = target.match(/^(?:#[^:]+|dm:@[^:]+):([a-zA-Z0-9]+)$/);
  return match ? match[1] : null;
}


function findActiveConversationRunId(db: Db, conversationId: string): string | null {
  const row = db
    .prepare(
      `SELECT r.run_id as runId
       FROM conversations c
       JOIN runs r ON r.session_key = c.session_key
       WHERE c.id = ? AND r.ended_at IS NULL
       ORDER BY r.started_at DESC
       LIMIT 1`,
    )
    .get(conversationId) as { runId: string } | undefined;
  return row?.runId ?? null;
}
function nextTaskNumber(db: Db, channelId: string): number {
  const row = db
    .prepare('SELECT MAX(task_number) as maxNum FROM tasks WHERE channel_id = ?')
    .get(channelId) as { maxNum: number | null };
  return (row.maxNum ?? 0) + 1;
}
