import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreToNode } from '@agent-collab/protocol';
import type { Db } from '@agent-collab/runtime-acp';
import { createRun, finishRun } from '@agent-collab/runtime-acp';
import { createTestConfig, createTestDb } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { registerInternalAgentRoutes } from '../web/internalAgentRouter.js';
import { AgentSkillsService } from '../services/agentSkillsService.js';
import { allocateNextChannelMessageSeq } from '../web/channelMessageSequences.js';
import { buildChannelActivationContextText, buildChannelActivationPrompt } from '../web/channelActivationPrompt.js';
import { buildTargetActivationContext } from '../web/activationContext.js';
import { findMentionedAgents } from '../web/channelMentions.js';
import { bumpAgentMessageCheckpoint } from '../web/messageCheckpoints.js';
import { listChannelSubscriptions } from '../web/channelSubscriptions.js';
import {
  listRecentTargetParticipants,
  TARGET_PARTICIPANT_ACTIVE_WINDOW_MS,
  upsertTargetParticipant,
} from '../web/targetParticipants.js';
import {
  getThreadCollaborationSummary,
  syncTaskThreadOwner,
} from '../web/threadTaskBindings.js';

type ScenarioHarness = {
  db: Db;
  manager: ConversationManager;
  baseUrl: string;
  close: () => Promise<void>;
  dispatches: CoreToNode[];
  state: Record<string, unknown>;
};

type ScenarioStep = {
  name: string;
  run: (harness: ScenarioHarness) => Promise<void>;
};

type ScenarioSpec = {
  id: string;
  summary: string;
  setup?: (harness: ScenarioHarness) => Promise<void>;
  steps: ScenarioStep[];
};

let harnessesToClose: Array<() => Promise<void>> = [];

afterEach(async () => {
  const closers = harnessesToClose;
  harnessesToClose = [];
  for (const close of closers.reverse()) {
    await close();
  }
});

describe('collaborationScenarios', () => {
  const scenarios: ScenarioSpec[] = [
    {
      id: 'task_thread_done_owner_regression',
      summary: 'task thread 在 done 前后都应保持正确的 owner/fallback 语义',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-task-${randomUUID().slice(0, 8)}` });
        const rootAuthor = harness.manager.createAgent({
          name: 'ScenarioRootAuthor',
          agentType: 'claude_acp',
          nodeId: 'node-1',
          workspacePath: '/tmp/scenario-root-author',
          channelId: channel.channelId,
        });
        const owner = harness.manager.createAgent({
          name: 'ScenarioTaskOwner',
          agentType: 'claude_acp',
          nodeId: 'node-1',
          workspacePath: '/tmp/scenario-task-owner',
          channelId: channel.channelId,
        });
        harness.manager.joinChannel(rootAuthor.agentId, channel.channelId);
        harness.manager.joinChannel(owner.agentId, channel.channelId);

        const rootMessageId = 'scntask1-0000-0000-0000-000000000000';
        const now = Date.now();
        const rootSeq = allocateNextChannelMessageSeq(harness.db, channel.channelId);
        harness.db.prepare(
          `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
           VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?)`,
        ).run(rootMessageId, channel.channelId, rootAuthor.agentId, rootAuthor.name, `#${channel.name}`, 'Scenario task root', rootSeq, now);
        harness.db.prepare(
          `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
           VALUES('scenario-task-1', ?, 401, 'Scenario task root', 'Goal: keep owner semantics before done, then fall back after done without stale owner leakage.', 'in_progress', ?, ?, ?, ?, ?)`,
        ).run(channel.channelId, owner.agentId, owner.name, rootMessageId, now, now);
        syncTaskThreadOwner(harness.db, {
          taskId: 'scenario-task-1',
          agentId: owner.agentId,
          lastActiveAt: now,
        });

        harness.state = {
          channelId: channel.channelId,
          channelName: channel.name,
          rootAuthorAgentId: rootAuthor.agentId,
          ownerAgentId: owner.agentId,
          threadRootId: rootMessageId.slice(0, 8),
        };
      },
      steps: [
        {
          name: 'before_done_reply_wakes_owner_with_bound_task_brief',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const ownerAgentId = harness.state.ownerAgentId as string;
            const threadRootId = harness.state.threadRootId as string;

            const response = await fetchJson(harness, `/api/channels/${channelId}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: '请先同步一下这个 task thread 的当前状态。',
                senderName: 'User',
                replyTo: threadRootId,
              }),
            });
            expect(response.status).toBe(201);
            await settleHarness();

            const ownerConv = harness.manager.openAgentChannelThread(ownerAgentId, channelId, threadRootId);
            if (!ownerConv) throw new Error('missing owner conversation');
            const ownerDebug = latestRunDebug(harness, ownerConv.id);
            expect(ownerDebug?.promptText).toContain('received a reply from User');
            expect(ownerDebug?.contextText).toContain('[Bound task-message for this thread]');
            expect(ownerDebug?.contextText).toContain('#401 [in_progress] @ScenarioTaskOwner — Scenario task root');
            expect(ownerDebug?.contextText).toContain('@ScenarioTaskOwner (owner)');
          },
        },
        {
          name: 'done_task_reply_falls_back_without_stale_owner',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const rootAuthorAgentId = harness.state.rootAuthorAgentId as string;
            const ownerAgentId = harness.state.ownerAgentId as string;
            const threadRootId = harness.state.threadRootId as string;
            const staleAt = Date.now() - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS - 1_000;

            harness.db.prepare(`UPDATE tasks SET status = 'done', updated_at = ? WHERE task_id = 'scenario-task-1'`).run(Date.now());
            harness.db.prepare(
              `UPDATE target_participants
               SET role = 'owner', last_active_at = ?
               WHERE agent_id = ? AND channel_id = ? AND thread_root_id = ?`,
            ).run(staleAt, ownerAgentId, channelId, threadRootId);

            const response = await fetchJson(harness, `/api/channels/${channelId}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: '这个 done task 还需要补一句总结。',
                senderName: 'User',
                replyTo: threadRootId,
              }),
            });
            expect(response.status).toBe(201);
            await settleHarness();

            const rootConv = harness.manager.openAgentChannelThread(rootAuthorAgentId, channelId, threadRootId);
            if (!rootConv) throw new Error('missing root author conversation');

            const staleOwnerRunCount = conversationRunCount(harness, ownerAgentId, channelId, threadRootId);
            expect(staleOwnerRunCount).toBe(1);

            const rootDebug = await waitForLocalDebug(harness, rootConv.id);
            expect(rootDebug?.contextText).toContain('#401 [done] @ScenarioTaskOwner — Scenario task root');
            expect(rootDebug?.contextText).not.toContain('@ScenarioTaskOwner (owner)');
          },
        },
      ],
    },
    {
      id: 'channel_root_active_mention_queue',
      summary: '主频道根消息一次 @ 多个 agent 时，active 目标先 queue，resume 后上下文不漂移',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-root-${randomUUID().slice(0, 8)}` });
        const bob = harness.manager.createAgent({
          name: 'ScenarioMentionBob',
          agentType: 'claude_acp',
          nodeId: 'node-1',
          workspacePath: '/tmp/scenario-mention-bob',
          channelId: channel.channelId,
        });
        const carol = harness.manager.createAgent({
          name: 'ScenarioMentionCarol',
          agentType: 'claude_acp',
          nodeId: 'node-1',
          workspacePath: '/tmp/scenario-mention-carol',
          channelId: channel.channelId,
        });
        harness.manager.joinChannel(bob.agentId, channel.channelId);
        harness.manager.joinChannel(carol.agentId, channel.channelId);

        const bobConv = harness.manager.openAgentChannelThread(bob.agentId, channel.channelId, null);
        const carolConv = harness.manager.openAgentChannelThread(carol.agentId, channel.channelId, null);
        if (!bobConv || !carolConv) throw new Error('missing root scenario conversations');

        const bobSession = harness.db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
          .get(bobConv.id) as { sessionKey: string };
        createRun(harness.db, {
          runId: 'scenario-root-active-bob',
          sessionKey: bobSession.sessionKey,
          promptText: 'already active on root',
        });
        harness.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

        harness.state = {
          channelId: channel.channelId,
          bobAgentId: bob.agentId,
          carolAgentId: carol.agentId,
          bobConversationId: bobConv.id,
          carolConversationId: carolConv.id,
          activeRunId: 'scenario-root-active-bob',
        };
      },
      steps: [
        {
          name: 'user_mention_queues_active_target_and_dispatches_idle_target',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const bobConversationId = harness.state.bobConversationId as string;
            const carolConversationId = harness.state.carolConversationId as string;

            const response = await fetchJson(harness, `/api/channels/${channelId}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: '@ScenarioMentionBob @ScenarioMentionCarol 一起看下这个主频道问题。',
                senderName: 'User',
              }),
            });
            expect(response.status).toBe(201);
            await settleHarness();

            const queued = queueRows(harness, bobConversationId);
            expect(queued).toHaveLength(1);
            expect(queued[0]?.promptText).toContain('You were @mentioned');

            const carolDebug = latestRunDebug(harness, carolConversationId);
            expect(carolDebug?.promptText).toContain('You were @mentioned');

            const queuedParticipants = participantsBlock(queued[0]?.activationContextText);
            const dispatchedParticipants = participantsBlock(carolDebug?.contextText);
            expect(queuedParticipants).toBe(dispatchedParticipants);
            harness.state.rootQueuedParticipants = queuedParticipants;
          },
        },
        {
          name: 'resumed_root_prompt_keeps_the_same_participants_block',
          run: async (harness) => {
            const bobConversationId = harness.state.bobConversationId as string;
            const activeRunId = harness.state.activeRunId as string;

            finishRun(harness.db, { runId: activeRunId, stopReason: 'end_turn' });
            harness.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', bobConversationId);
            await harness.manager.onConversationSettled(bobConversationId);
            await settleHarness();

            const resumed = latestDispatch(harness, bobConversationId);
            expect(resumed?.dispatchMode).toBe('resume');
            expect(participantsBlock(resumed?.contextText)).toBe(harness.state.rootQueuedParticipants as string);
          },
        },
      ],
    },
    {
      id: 'agent_only_thread_multi_round_resume',
      summary: 'agent-only 线程协作里，mention 触发的 queue/resume 应保持一致上下文',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-thread-${randomUUID().slice(0, 8)}` });
        const alice = harness.manager.createAgent({
          name: 'ScenarioThreadAlice',
          agentType: 'claude_acp',
          nodeId: 'node-1',
          workspacePath: '/tmp/scenario-thread-alice',
          channelId: channel.channelId,
        });
        const bob = harness.manager.createAgent({
          name: 'ScenarioThreadBob',
          agentType: 'claude_acp',
          nodeId: 'node-1',
          workspacePath: '/tmp/scenario-thread-bob',
          channelId: channel.channelId,
        });
        const carol = harness.manager.createAgent({
          name: 'ScenarioThreadCarol',
          agentType: 'claude_acp',
          nodeId: 'node-1',
          workspacePath: '/tmp/scenario-thread-carol',
          channelId: channel.channelId,
        });
        harness.manager.joinChannel(alice.agentId, channel.channelId);
        harness.manager.joinChannel(bob.agentId, channel.channelId);
        harness.manager.joinChannel(carol.agentId, channel.channelId);

        const threadRootId = 'scntrd01';
        const rootSeq = allocateNextChannelMessageSeq(harness.db, channel.channelId);
        const now = Date.now();
        harness.db.prepare(
          `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
           VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
        ).run(
          `${threadRootId}-0000-0000-0000-000000000000`,
          channel.channelId,
          alice.agentId,
          alice.name,
          `#${channel.name}`,
          'Scenario thread root',
          rootSeq,
          now,
          threadRootId,
        );

        const aliceConv = harness.manager.openAgentChannelThread(alice.agentId, channel.channelId, threadRootId);
        const bobConv = harness.manager.openAgentChannelThread(bob.agentId, channel.channelId, threadRootId);
        const carolConv = harness.manager.openAgentChannelThread(carol.agentId, channel.channelId, threadRootId);
        if (!aliceConv || !bobConv || !carolConv) throw new Error('missing thread scenario conversations');

        upsertTargetParticipant(harness.db, {
          agentId: alice.agentId,
          channelId: channel.channelId,
          threadRootId,
          role: 'owner',
          lastActiveAt: now,
        });
        upsertTargetParticipant(harness.db, {
          agentId: bob.agentId,
          channelId: channel.channelId,
          threadRootId,
          role: 'participant',
          lastActiveAt: now,
        });
        upsertTargetParticipant(harness.db, {
          agentId: carol.agentId,
          channelId: channel.channelId,
          threadRootId,
          role: 'participant',
          lastActiveAt: now,
        });

        const bobSession = harness.db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
          .get(bobConv.id) as { sessionKey: string };
        createRun(harness.db, {
          runId: 'scenario-thread-active-bob',
          sessionKey: bobSession.sessionKey,
          promptText: 'already active in thread',
        });
        harness.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('active', bobConv.id);

        const aliceSession = harness.db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
          .get(aliceConv.id) as { sessionKey: string };
        createRun(harness.db, {
          runId: 'scenario-thread-alice-source',
          sessionKey: aliceSession.sessionKey,
          promptText: 'source thread update',
        });

        harness.state = {
          channelId: channel.channelId,
          channelName: channel.name,
          threadRootId,
          aliceAgentId: alice.agentId,
          bobConversationId: bobConv.id,
          carolConversationId: carolConv.id,
          aliceConversationId: aliceConv.id,
          activeRunId: 'scenario-thread-active-bob',
        };
      },
      steps: [
        {
          name: 'agent_mentions_dispatch_idle_target_and_queue_active_target',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const threadRootId = harness.state.threadRootId as string;
            const aliceAgentId = harness.state.aliceAgentId as string;
            const aliceConversationId = harness.state.aliceConversationId as string;
            const bobConversationId = harness.state.bobConversationId as string;
            const carolConversationId = harness.state.carolConversationId as string;

            const response = await fetch(`${harness.baseUrl}/api/internal/agent/${aliceAgentId}/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                target: `#${harness.state.channelName as string}:${threadRootId}`,
                content: 'Need both of you here, @ScenarioThreadBob and @ScenarioThreadCarol.',
                kind: 'progress',
                conversationId: aliceConversationId,
              }),
            });
            expect(response.status).toBe(200);
            await settleHarness();

            const queued = queueRows(harness, bobConversationId);
            expect(queued).toHaveLength(1);
            expect(queued[0]?.promptText).toContain('Another agent (@ScenarioThreadAlice) explicitly asked for your help');

            const carolDispatch = latestDispatch(harness, carolConversationId);
            expect(carolDispatch?.prompt).toContain('Another agent (@ScenarioThreadAlice) explicitly asked for your help');

            const queuedParticipants = participantsBlock(queued[0]?.activationContextText);
            const dispatchedParticipants = participantsBlock(carolDispatch?.contextText);
            expect(queuedParticipants).toBe(dispatchedParticipants);
            harness.state.threadQueuedParticipants = queuedParticipants;

            const runCount = conversationRunCount(harness, null, channelId, threadRootId, carolConversationId);
            expect(runCount).toBeGreaterThanOrEqual(1);
          },
        },
        {
          name: 'resumed_thread_prompt_keeps_the_same_participants_block',
          run: async (harness) => {
            const bobConversationId = harness.state.bobConversationId as string;
            const activeRunId = harness.state.activeRunId as string;

            finishRun(harness.db, { runId: activeRunId, stopReason: 'end_turn' });
            harness.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('idle', bobConversationId);
            await harness.manager.onConversationSettled(bobConversationId);
            await settleHarness();

            const resumed = latestDispatch(harness, bobConversationId);
            expect(resumed?.dispatchMode).toBe('resume');
            expect(participantsBlock(resumed?.contextText)).toBe(harness.state.threadQueuedParticipants as string);
          },
        },
      ],
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.summary}`, async () => {
      const harness = await createScenarioHarness();
      harnessesToClose.push(harness.close);
      if (scenario.setup) await scenario.setup(harness);
      for (const step of scenario.steps) {
        await step.run(harness);
      }
    });
  }
});

async function createScenarioHarness(): Promise<ScenarioHarness> {
  const db = createTestDb();
  const dispatches: CoreToNode[] = [];
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
      return true;
    },
  };
  const config = createTestConfig({ contextReplayEnabled: true, contextReplayRuns: 16 });
  const manager = new ConversationManager({
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

  registerInternalAgentRoutes(app, db, manager, () => {}, () => {}, config.humanUserName, skillsService);

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

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    db,
    manager,
    baseUrl,
    dispatches,
    state: {},
    close: async () => {
      manager.close();
      await app.close();
      db.close();
    },
  };
}

async function fetchJson(harness: ScenarioHarness, path: string, init?: RequestInit) {
  const res = await fetch(`${harness.baseUrl}${path}`, init);
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

function latestRunDebug(harness: ScenarioHarness, conversationId: string) {
  return harness.db.prepare(
    `SELECT prompt_text as promptText, context_text as contextText
     FROM run_debug_inputs
     WHERE conversation_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(conversationId) as { promptText: string; contextText: string | null } | undefined;
}

function queueRows(harness: ScenarioHarness, conversationId: string) {
  return harness.db.prepare(
    `SELECT prompt_text as promptText, activation_context_text as activationContextText
     FROM conversation_prompt_queue
     WHERE conversation_id = ?
     ORDER BY queue_id ASC`,
  ).all(conversationId) as Array<{ promptText: string; activationContextText: string | null }>;
}

function latestDispatch(harness: ScenarioHarness, conversationId: string) {
  const runs = harness.dispatches.filter((msg): msg is Extract<CoreToNode, { type: 'run.dispatch' }> => msg.type === 'run.dispatch');
  return [...runs].reverse().find((msg) => msg.conversationId === conversationId);
}

function participantsBlock(text?: string | null): string {
  return /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? '';
}

function conversationRunCount(
  harness: ScenarioHarness,
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

async function settleHarness(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

async function waitForLocalDebug(
  harness: ScenarioHarness,
  conversationId: string,
): Promise<{ promptText: string; contextText: string | null }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = latestRunDebug(harness, conversationId);
    if (row) return row;
    await settleHarness();
  }
  throw new Error(`No run_debug_inputs row appeared for conversation ${conversationId}.`);
}
