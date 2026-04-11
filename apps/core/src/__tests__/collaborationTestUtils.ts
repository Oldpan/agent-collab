import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { vi } from 'vitest';
import type { AgentInfo, ConversationInfo, ConversationStatus, CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createRun } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { registerInternalAgentRoutes } from '../web/internalAgentRouter.js';
import { AgentSkillsService } from '../services/agentSkillsService.js';
import { allocateNextChannelMessageSeq } from '../web/channelMessageSequences.js';
import { buildChannelActivationContextText, buildChannelActivationPrompt } from '../web/channelActivationPrompt.js';
import { buildTargetActivationContext } from '../web/activationContext.js';
import { findMentionedAgents } from '../web/channelMentions.js';
import { bumpAgentMessageCheckpoint } from '../web/messageCheckpoints.js';
import {
  listRecentTargetParticipants,
  TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  upsertTargetParticipant,
} from '../web/targetParticipants.js';
import { getThreadCollaborationSummary } from '../web/threadTaskBindings.js';

export type CollaborationHarness = {
  db: Db;
  manager: ConversationManager;
  baseUrl: string;
  close: () => Promise<void>;
  dispatches: CoreToNode[];
  state: Record<string, unknown>;
  now: () => number;
  setTime: (timestamp: number) => number;
  advanceTime: (ms: number) => number;
};

export const DEFAULT_COLLABORATION_TEST_TIME = Date.parse('2026-04-08T00:00:00.000Z');

type FetchJsonResult = {
  status: number;
  body: any;
};

type InsertChannelMessageParams = {
  messageId?: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderType: 'user' | 'agent' | 'system';
  target: string;
  content: string;
  createdAt?: number;
  threadRootId?: string | null;
  messageKind?: string | null;
};

type SendAgentMessageParams = {
  agentId: string;
  content: string;
  conversationId?: string;
  target?: string;
  kind?: 'progress' | 'final';
};

type PostUserChannelMessageParams = {
  channelId: string;
  content: string;
  senderName?: string;
  replyTo?: string | null;
};

type MentionCooldownRowParams = {
  channelId: string;
  threadRootId?: string | null;
  fromAgentId: string;
  toAgentId: string;
};

export function installDeterministicCollaborationClock(startAt = DEFAULT_COLLABORATION_TEST_TIME): number {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startAt);
  return startAt;
}

export function restoreDeterministicCollaborationClock(): void {
  vi.useRealTimers();
}

export async function createCollaborationHarness(): Promise<CollaborationHarness> {
  const db = createTestDb();
  const dispatches: CoreToNode[] = [];
  let manager: ConversationManager;
  const fakeRegistry = {
    getNode(nodeId: string) {
      return {
        nodeId,
        hostname: 'scenario-node',
        agentTypes: ['claude_acp', 'codex_acp'],
        version: 'test',
      };
    },
    send(_nodeId: string, msg: CoreToNode) {
      dispatches.push(msg);
      if (msg.type === 'run.dispatch') {
        queueMicrotask(() => {
          manager.handleRunAccepted(msg.runId, msg.conversationId);
        });
      }
      return true;
    },
  };
  const config = createTestConfig({ contextReplayEnabled: true, contextReplayRuns: 16 });
  manager = new ConversationManager({
    db,
    config,
    nodeRegistry: fakeRegistry as any,
  });
  manager.start();

  const app = Fastify({ logger: false });
  const skillsService = new AgentSkillsService({
    getAgentById: (agentId) => manager.getAgent(agentId),
    broker: {
      async listSkills(_nodeId: string, skillRoots: string[]) {
        return {
          path: null,
          roots: skillRoots,
          skills: [],
          entries: [],
        };
      },
      async readSkillFile(_nodeId: string, _skillRoots: string[], _params: unknown, skillPath: string) {
        return {
          path: skillPath,
          content: '# Skill\nplaceholder',
          mimeType: 'text/markdown' as const,
          size: 18,
          modifiedAt: 1,
        };
      },
    } as any,
  });

  registerInternalAgentRoutes(app, db, manager, () => {}, () => {}, () => {}, config.humanUserName, skillsService);

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
          const activationMetadata = !threadRootId
            ? (() => {
                const peerAgentIds = Array.from(pendingNotifications.keys())
                  .filter((targetAgentId) => targetAgentId !== agentId);
                return peerAgentIds.length > 0
                  ? {
                      mentionSuppression: {
                        mode: 'root_user_multi_mention' as const,
                        triggerSeq: seq,
                        peerMentionedAgentIds: peerAgentIds,
                      },
                    }
                  : undefined;
              })()
            : undefined;
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
              activationMetadata,
            },
          ).then(() => {
            bumpAgentMessageCheckpoint(db, agentId, req.params.id, seq, threadRootId ?? null);
          }).catch(() => {});
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
        const normalizedParticipants = summary.boundTask?.status === 'done'
          ? participants.map((participant) => ({ ...participant, role: 'participant' as const }))
          : participants;
        const rootMsg = db.prepare(
          `SELECT sender_id as senderId, sender_type as senderType
           FROM channel_messages
           WHERE channel_id = ? AND substr(message_id, 1, 8) = ?
           LIMIT 1`,
        ).get(req.params.id, threadRootId) as { senderId: string; senderType: string } | undefined;

        if (summary.ownerAgentId) {
          queueAgentNotification(summary.ownerAgentId, 'thread_reply', 'owner');
        }
        if (normalizedParticipants.length === 0 && !summary.ownerAgentId && rootMsg?.senderType === 'agent') {
          queueAgentNotification(rootMsg.senderId, 'thread_reply', 'owner');
        } else {
          for (const participant of normalizedParticipants) {
            queueAgentNotification(participant.agentId, 'thread_reply', participant.role);
          }
        }
      }

      for (const agent of mentionedAgents) {
        queueAgentNotification(agent.agentId, 'mention', threadRootId ? 'participant' : 'owner');
      }

      if (!threadRootId) {
        const rootParticipants = listRecentTargetParticipants(db, {
          channelId: req.params.id,
          threadRootId: null,
          activeSince: now - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
        });
        for (const participant of rootParticipants) {
          queueAgentNotification(participant.agentId, 'channel_activity', participant.role);
        }
      }

      flushAgentNotifications();
      reply.code(201);
      return { messageId, seq };
    },
  );

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    db,
    manager,
    baseUrl,
    dispatches,
    state: {},
    now: () => Date.now(),
    setTime: (timestamp) => {
      vi.setSystemTime(timestamp);
      return timestamp;
    },
    advanceTime: (ms) => {
      const timestamp = Date.now() + ms;
      vi.setSystemTime(timestamp);
      return timestamp;
    },
    close: async () => {
      manager.close();
      await app.close();
      db.close();
    },
  };
}

export async function fetchJson(harness: CollaborationHarness, path: string, init?: RequestInit): Promise<FetchJsonResult> {
  const res = await fetch(`${harness.baseUrl}${path}`, init);
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

export async function postUserChannelMessage(
  harness: CollaborationHarness,
  params: PostUserChannelMessageParams,
): Promise<FetchJsonResult> {
  return fetchJson(harness, `/api/channels/${params.channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: params.content,
      senderName: params.senderName ?? 'User',
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    }),
  });
}

export async function sendAgentMessage(
  harness: CollaborationHarness,
  params: SendAgentMessageParams,
): Promise<FetchJsonResult> {
  return fetchJson(harness, `/api/internal/agent/${params.agentId}/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${harness.manager.getConfig().internalAgentAuthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: params.content,
      ...(params.conversationId ? { conversationId: params.conversationId } : {}),
      ...(params.target ? { target: params.target } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
    }),
  });
}

export function createJoinedAgent(
  harness: CollaborationHarness,
  params: {
    name: string;
    channelId: string;
    agentType?: AgentInfo['agentType'];
    nodeId?: string;
    workspacePath?: string;
  },
): AgentInfo {
  const agent = harness.manager.createAgent({
    name: params.name,
    agentType: params.agentType ?? 'claude_acp',
    nodeId: params.nodeId ?? 'node-1',
    workspacePath: params.workspacePath ?? `/tmp/${params.name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    channelId: params.channelId,
  });
  harness.manager.joinChannel(agent.agentId, params.channelId);
  return agent;
}

export function requireChannelConversation(
  harness: CollaborationHarness,
  agentId: string,
  channelId: string,
  threadRootId?: string | null,
): ConversationInfo {
  const conv = harness.manager.openAgentChannelThread(agentId, channelId, threadRootId ?? null);
  if (!conv) {
    throw new Error(`missing conversation for ${agentId} on ${channelId}:${threadRootId ?? 'root'}`);
  }
  return conv;
}

export function createConversationRun(
  harness: CollaborationHarness,
  params: { conversationId: string; runId: string; promptText: string },
): void {
  const sessionRow = harness.db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
    .get(params.conversationId) as { sessionKey: string } | undefined;
  if (!sessionRow) throw new Error(`missing session for conversation ${params.conversationId}`);
  createRun(harness.db, {
    runId: params.runId,
    sessionKey: sessionRow.sessionKey,
    promptText: params.promptText,
  });
}

export function setConversationStatus(
  harness: CollaborationHarness,
  conversationId: string,
  status: ConversationStatus,
): void {
  harness.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, conversationId);
}

export function latestRunDebug(harness: CollaborationHarness, conversationId: string) {
  return harness.db.prepare(
    `SELECT prompt_text as promptText, context_text as contextText
     FROM run_debug_inputs
     WHERE conversation_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(conversationId) as { promptText: string; contextText: string | null } | undefined;
}

export function queueRows(harness: CollaborationHarness, conversationId: string) {
  return harness.db.prepare(
    `SELECT prompt_text as promptText, activation_context_text as activationContextText
     FROM conversation_prompt_queue
     WHERE conversation_id = ?
     ORDER BY queue_id ASC`,
  ).all(conversationId) as Array<{ promptText: string; activationContextText: string | null }>;
}

export function latestDispatch(harness: CollaborationHarness, conversationId: string) {
  const runs = harness.dispatches.filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch');
  return [...runs].reverse().find((msg) => msg.conversationId === conversationId);
}

export function latestConversationRunId(harness: CollaborationHarness, conversationId: string): string | null {
  const row = harness.db.prepare(
    `SELECT r.run_id as runId
     FROM runs r
     JOIN conversations c ON c.session_key = r.session_key
     WHERE c.id = ?
     ORDER BY r.started_at DESC
     LIMIT 1`,
  ).get(conversationId) as { runId: string } | undefined;
  return row?.runId ?? null;
}

export function participantsBlock(text?: string | null): string {
  return /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? '';
}

export function conversationRunCount(
  harness: CollaborationHarness,
  agentId: string | null,
  channelId: string,
  threadRootId: string | null,
  conversationId?: string,
): number {
  if (conversationId) {
    const row = harness.db.prepare(
      `SELECT COUNT(*) as count
       FROM runs r
       JOIN conversations c ON c.session_key = r.session_key
       WHERE c.id = ?`,
    ).get(conversationId) as { count: number };
    return row.count;
  }
  const row = harness.db.prepare(
    `SELECT COUNT(*) as count
     FROM runs r
     JOIN conversations c ON c.session_key = r.session_key
     WHERE c.agent_id = ? AND c.channel_id = ? AND c.thread_root_id ${threadRootId ? '= ?' : 'IS NULL'}`,
  ).get(...(threadRootId ? [agentId, channelId, threadRootId] : [agentId, channelId])) as { count: number };
  return row.count;
}

export async function settleHarness(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

export async function waitForLocalDebug(
  harness: CollaborationHarness,
  conversationId: string,
): Promise<{ promptText: string; contextText: string | null }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = latestRunDebug(harness, conversationId);
    if (row) return row;
    await settleHarness();
  }
  throw new Error(`No run_debug_inputs row appeared for conversation ${conversationId}.`);
}

export function insertChannelMessage(
  harness: CollaborationHarness,
  params: InsertChannelMessageParams,
): { messageId: string; seq: number } {
  const now = params.createdAt ?? Date.now();
  const messageId = params.messageId ?? randomUUID();
  const seq = allocateNextChannelMessageSeq(harness.db, params.channelId);
  harness.db.prepare(
    `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id, message_kind)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    params.channelId,
    params.senderId,
    params.senderName,
    params.senderType,
    params.target,
    params.content,
    seq,
    now,
    params.threadRootId ?? null,
    params.messageKind ?? null,
  );
  return { messageId, seq };
}

export function countMentionCooldowns(
  harness: CollaborationHarness,
  params: MentionCooldownRowParams,
): number {
  const row = harness.db.prepare(
    `SELECT COUNT(*) as count
     FROM agent_mention_cooldowns
     WHERE channel_id = ? AND thread_root_id = ? AND from_agent_id = ? AND to_agent_id = ?`,
  ).get(
    params.channelId,
    params.threadRootId ?? '',
    params.fromAgentId,
    params.toAgentId,
  ) as { count: number };
  return row.count;
}

export function setMentionCooldownTimestamp(
  harness: CollaborationHarness,
  params: MentionCooldownRowParams & { lastNotifiedAt: number },
): void {
  harness.db.prepare(
    `INSERT INTO agent_mention_cooldowns(channel_id, thread_root_id, from_agent_id, to_agent_id, last_notified_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_root_id, from_agent_id, to_agent_id)
     DO UPDATE SET last_notified_at = excluded.last_notified_at`,
  ).run(
    params.channelId,
    params.threadRootId ?? '',
    params.fromAgentId,
    params.toAgentId,
    params.lastNotifiedAt,
  );
}
