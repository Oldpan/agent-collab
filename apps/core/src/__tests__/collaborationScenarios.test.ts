import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildThreadShortId } from '@agent-collab/protocol';
import { finishRun } from '@agent-collab/runtime-acp';
import { TARGET_PARTICIPANT_ACTIVE_WINDOW_MS, upsertTargetParticipant } from '../web/targetParticipants.js';
import { syncTaskThreadOwner } from '../web/threadTaskBindings.js';
import type { CollaborationHarness } from './collaborationTestUtils.js';
import {
  conversationRunCount,
  countMentionCooldowns,
  createCollaborationHarness,
  createConversationRun,
  createJoinedAgent,
  insertChannelMessage,
  installDeterministicCollaborationClock,
  latestConversationRunId,
  latestDispatch,
  latestRunDebug,
  participantsBlock,
  postUserChannelMessage,
  queueRows,
  requireChannelConversation,
  restoreDeterministicCollaborationClock,
  sendAgentMessage,
  setConversationStatus,
  settleHarness,
  waitForLocalDebug,
} from './collaborationTestUtils.js';

type ScenarioStep = {
  name: string;
  run: (harness: CollaborationHarness) => Promise<void>;
};

type ScenarioSpec = {
  id: string;
  summary: string;
  setup?: (harness: CollaborationHarness) => Promise<void>;
  steps: ScenarioStep[];
};

let harnessesToClose: Array<() => Promise<void>> = [];

beforeEach(() => {
  installDeterministicCollaborationClock();
});

afterEach(async () => {
  const closers = harnessesToClose;
  harnessesToClose = [];
  for (const close of closers.reverse()) {
    await close();
  }
  restoreDeterministicCollaborationClock();
});

describe('collaborationScenarios', () => {
  const scenarios: ScenarioSpec[] = [
    {
      id: 'task_thread_done_owner_regression',
      summary: 'task thread 在 done 前后都应保持正确的 owner/fallback 语义',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-task-${randomUUID().slice(0, 8)}` });
        const rootAuthor = createJoinedAgent(harness, {
          name: 'ScenarioRootAuthor',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-root-author',
        });
        const owner = createJoinedAgent(harness, {
          name: 'ScenarioTaskOwner',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-task-owner',
        });

        const rootMessageId = 'scntask1-0000-0000-0000-000000000000';
        const now = harness.now();
        insertChannelMessage(harness, {
          messageId: rootMessageId,
          channelId: channel.channelId,
          senderId: rootAuthor.agentId,
          senderName: rootAuthor.name,
          senderType: 'agent',
          target: `#${channel.name}`,
          content: 'Scenario task root',
          createdAt: now,
        });
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
          rootAuthorAgentId: rootAuthor.agentId,
          ownerAgentId: owner.agentId,
          threadRootId: buildThreadShortId(rootMessageId),
        };
      },
      steps: [
        {
          name: 'before_done_reply_wakes_owner_with_bound_task_brief',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const ownerAgentId = harness.state.ownerAgentId as string;
            const threadRootId = harness.state.threadRootId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '请先同步一下这个 task thread 的当前状态。',
              replyTo: threadRootId,
            });
            expect(response.status).toBe(201);
            await settleHarness();

            const ownerConv = requireChannelConversation(harness, ownerAgentId, channelId, threadRootId);
            const ownerDebug = latestRunDebug(harness, ownerConv.id);
            harness.state.ownerConversationId = ownerConv.id;
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
            const ownerConversationId = harness.state.ownerConversationId as string;
            harness.advanceTime(TARGET_PARTICIPANT_ACTIVE_WINDOW_MS + 1_000);
            harness.db.prepare(`UPDATE tasks SET status = 'done', updated_at = ? WHERE task_id = 'scenario-task-1'`).run(harness.now());
            harness.db.prepare(
              `UPDATE target_participants
               SET role = 'owner', last_active_at = ?
               WHERE agent_id = ? AND channel_id = ? AND thread_root_id = ?`,
            ).run(harness.now() - TARGET_PARTICIPANT_ACTIVE_WINDOW_MS - 1_000, ownerAgentId, channelId, threadRootId);

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '这个 done task 还需要补一句总结。',
              replyTo: threadRootId,
            });
            expect(response.status).toBe(201);
            await settleHarness();

            const rootConv = requireChannelConversation(harness, rootAuthorAgentId, channelId, threadRootId);
            const staleOwnerRunCount = conversationRunCount(harness, null, channelId, threadRootId, ownerConversationId);
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
        const bob = createJoinedAgent(harness, {
          name: 'ScenarioMentionBob',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-mention-bob',
        });
        const carol = createJoinedAgent(harness, {
          name: 'ScenarioMentionCarol',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-mention-carol',
        });

        const bobConv = requireChannelConversation(harness, bob.agentId, channel.channelId, null);
        const carolConv = requireChannelConversation(harness, carol.agentId, channel.channelId, null);
        createConversationRun(harness, {
          conversationId: bobConv.id,
          runId: 'scenario-root-active-bob',
          promptText: 'already active on root',
        });
        setConversationStatus(harness, bobConv.id, 'active');

        harness.state = {
          channelId: channel.channelId,
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

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '@ScenarioMentionBob @ScenarioMentionCarol 一起看下这个主频道问题。',
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
            setConversationStatus(harness, bobConversationId, 'idle');
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
        const alice = createJoinedAgent(harness, {
          name: 'ScenarioThreadAlice',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-thread-alice',
        });
        const bob = createJoinedAgent(harness, {
          name: 'ScenarioThreadBob',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-thread-bob',
        });
        const carol = createJoinedAgent(harness, {
          name: 'ScenarioThreadCarol',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-thread-carol',
        });

        const threadRootId = 'scntrd01';
        const now = harness.now();
        insertChannelMessage(harness, {
          messageId: `${threadRootId}-0000-0000-0000-000000000000`,
          channelId: channel.channelId,
          senderId: alice.agentId,
          senderName: alice.name,
          senderType: 'agent',
          target: `#${channel.name}`,
          content: 'Scenario thread root',
          createdAt: now,
          threadRootId,
        });

        const aliceConv = requireChannelConversation(harness, alice.agentId, channel.channelId, threadRootId);
        const bobConv = requireChannelConversation(harness, bob.agentId, channel.channelId, threadRootId);
        const carolConv = requireChannelConversation(harness, carol.agentId, channel.channelId, threadRootId);

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

        createConversationRun(harness, {
          conversationId: bobConv.id,
          runId: 'scenario-thread-active-bob',
          promptText: 'already active in thread',
        });
        setConversationStatus(harness, bobConv.id, 'active');
        createConversationRun(harness, {
          conversationId: aliceConv.id,
          runId: 'scenario-thread-alice-source',
          promptText: 'source thread update',
        });

        harness.state = {
          channelName: channel.name,
          threadRootId,
          aliceAgentId: alice.agentId,
          aliceConversationId: aliceConv.id,
          bobConversationId: bobConv.id,
          carolConversationId: carolConv.id,
          activeRunId: 'scenario-thread-active-bob',
        };
      },
      steps: [
        {
          name: 'agent_mentions_dispatch_idle_target_and_queue_active_target',
          run: async (harness) => {
            const channelName = harness.state.channelName as string;
            const threadRootId = harness.state.threadRootId as string;
            const aliceAgentId = harness.state.aliceAgentId as string;
            const aliceConversationId = harness.state.aliceConversationId as string;
            const bobConversationId = harness.state.bobConversationId as string;
            const carolConversationId = harness.state.carolConversationId as string;

            const response = await sendAgentMessage(harness, {
              agentId: aliceAgentId,
              conversationId: aliceConversationId,
              target: `#${channelName}:${threadRootId}`,
              content: 'Need both of you here, @ScenarioThreadBob and @ScenarioThreadCarol.',
              kind: 'progress',
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
          },
        },
        {
          name: 'resumed_thread_prompt_keeps_the_same_participants_block',
          run: async (harness) => {
            const bobConversationId = harness.state.bobConversationId as string;
            const activeRunId = harness.state.activeRunId as string;

            finishRun(harness.db, { runId: activeRunId, stopReason: 'end_turn' });
            setConversationStatus(harness, bobConversationId, 'idle');
            await harness.manager.onConversationSettled(bobConversationId);
            await settleHarness();

            const resumed = latestDispatch(harness, bobConversationId);
            expect(resumed?.dispatchMode).toBe('resume');
            expect(participantsBlock(resumed?.contextText)).toBe(harness.state.threadQueuedParticipants as string);
          },
        },
      ],
    },
    {
      id: 'root_recent_participant_continues_after_mention',
      summary: '根频道先显式 @ 激活 agent，后续无 @ 的用户消息仍应继续唤醒 recent participant',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({
          name: `scenario-root-recent-${randomUUID().slice(0, 8)}`,
        });
        const alpha = createJoinedAgent(harness, {
          name: 'ScenarioRecentAlpha',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-recent-alpha',
        });
        const beta = createJoinedAgent(harness, {
          name: 'ScenarioRecentBeta',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-recent-beta',
        });

        harness.state = {
          channelId: channel.channelId,
          alphaConversationId: requireChannelConversation(harness, alpha.agentId, channel.channelId, null).id,
          betaConversationId: requireChannelConversation(harness, beta.agentId, channel.channelId, null).id,
        };
      },
      steps: [
        {
          name: 'explicit_mention_wakes_alpha_only',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const alphaConversationId = harness.state.alphaConversationId as string;
            const betaConversationId = harness.state.betaConversationId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '@ScenarioRecentAlpha 先看一下这个问题。',
            });
            expect(response.status).toBe(201);
            await settleHarness();

            expect(conversationRunCount(harness, null, channelId, null, alphaConversationId)).toBe(1);
            expect(conversationRunCount(harness, null, channelId, null, betaConversationId)).toBe(0);

            const alphaRunId = latestConversationRunId(harness, alphaConversationId);
            expect(alphaRunId).toBeTruthy();
            finishRun(harness.db, { runId: alphaRunId!, stopReason: 'end_turn' });
            setConversationStatus(harness, alphaConversationId, 'idle');
            await harness.manager.onConversationSettled(alphaConversationId);
          },
        },
        {
          name: 'plain_root_message_continues_waking_recent_alpha',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const alphaConversationId = harness.state.alphaConversationId as string;
            const betaConversationId = harness.state.betaConversationId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '这里补充一些新信息，这次不再显式 @。',
            });
            expect(response.status).toBe(201);
            await settleHarness();

            expect(conversationRunCount(harness, null, channelId, null, alphaConversationId)).toBe(2);
            expect(conversationRunCount(harness, null, channelId, null, betaConversationId)).toBe(0);

            const alphaDebug = latestRunDebug(harness, alphaConversationId);
            expect(alphaDebug?.promptText).toContain('There is new channel activity');
            expect(participantsBlock(alphaDebug?.contextText)).toContain('@ScenarioRecentAlpha (owner)');
          },
        },
      ],
    },
    {
      id: 'root_plain_message_without_recent_participants_keeps_agents_idle',
      summary: '根频道普通消息在没有显式 @ 且没有 recent participants 时不应误唤醒任何 agent',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({
          name: `scenario-plain-${randomUUID().slice(0, 8)}`,
        });
        const alpha = createJoinedAgent(harness, {
          name: 'ScenarioPlainAlpha',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-plain-alpha',
        });
        const beta = createJoinedAgent(harness, {
          name: 'ScenarioPlainBeta',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-plain-beta',
        });

        harness.state = {
          channelId: channel.channelId,
          alphaConversationId: requireChannelConversation(harness, alpha.agentId, channel.channelId, null).id,
          betaConversationId: requireChannelConversation(harness, beta.agentId, channel.channelId, null).id,
        };
      },
      steps: [
        {
          name: 'plain_root_message_keeps_all_agents_idle',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const alphaConversationId = harness.state.alphaConversationId as string;
            const betaConversationId = harness.state.betaConversationId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '这是一个普通的根频道更新，没有任何显式 @mention。',
            });
            expect(response.status).toBe(201);
            await settleHarness();

            expect(harness.dispatches.filter((msg) => msg.type === 'run.dispatch')).toHaveLength(0);
            expect(conversationRunCount(harness, null, channelId, null, alphaConversationId)).toBe(0);
            expect(conversationRunCount(harness, null, channelId, null, betaConversationId)).toBe(0);
            expect(queueRows(harness, alphaConversationId)).toHaveLength(0);
            expect(queueRows(harness, betaConversationId)).toHaveLength(0);
          },
        },
      ],
    },
    {
      id: 'task_thread_mixed_priority_consistency',
      summary: 'task thread 同时命中 owner、participant 和显式 mention 时，应保持 reason 优先级与上下文一致',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-task-mix-${randomUUID().slice(0, 8)}` });
        const owner = createJoinedAgent(harness, {
          name: 'ScenarioMixOwner',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-mix-owner',
        });
        const helper = createJoinedAgent(harness, {
          name: 'ScenarioMixHelper',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-mix-helper',
        });
        const mentioned = createJoinedAgent(harness, {
          name: 'ScenarioMixMentioned',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-mix-mentioned',
        });

        const rootMessageId = 'mixscn01-0000-0000-0000-000000000000';
        const threadRootId = buildThreadShortId(rootMessageId);
        const now = harness.now();
        insertChannelMessage(harness, {
          messageId: rootMessageId,
          channelId: channel.channelId,
          senderId: owner.agentId,
          senderName: owner.name,
          senderType: 'agent',
          target: `#${channel.name}`,
          content: 'Scenario mixed priority task root',
          createdAt: now,
        });
        harness.db.prepare(
          `INSERT INTO tasks(task_id, channel_id, task_number, title, description, status, claimed_by_agent_id, claimed_by_name, message_id, created_at, updated_at)
           VALUES('scenario-task-mix', ?, 512, 'Scenario mixed priority task', 'Goal: ensure owner, helper, and explicitly mentioned agent all see stable shared context while only the mentioned target gets mention reason.', 'in_progress', ?, ?, ?, ?, ?)`,
        ).run(channel.channelId, owner.agentId, owner.name, rootMessageId, now, now);
        syncTaskThreadOwner(harness.db, {
          taskId: 'scenario-task-mix',
          agentId: owner.agentId,
          lastActiveAt: now,
        });
        upsertTargetParticipant(harness.db, {
          agentId: owner.agentId,
          channelId: channel.channelId,
          threadRootId,
          role: 'owner',
          lastActiveAt: now,
        });
        upsertTargetParticipant(harness.db, {
          agentId: helper.agentId,
          channelId: channel.channelId,
          threadRootId,
          role: 'participant',
          lastActiveAt: now,
        });
        upsertTargetParticipant(harness.db, {
          agentId: mentioned.agentId,
          channelId: channel.channelId,
          threadRootId,
          role: 'participant',
          lastActiveAt: now,
        });

        harness.state = {
          channelId: channel.channelId,
          threadRootId,
          ownerConversationId: requireChannelConversation(harness, owner.agentId, channel.channelId, threadRootId).id,
          helperConversationId: requireChannelConversation(harness, helper.agentId, channel.channelId, threadRootId).id,
          mentionedConversationId: requireChannelConversation(harness, mentioned.agentId, channel.channelId, threadRootId).id,
        };
      },
      steps: [
        {
          name: 'explicit_mention_changes_reason_not_shared_context',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const threadRootId = harness.state.threadRootId as string;
            const ownerConversationId = harness.state.ownerConversationId as string;
            const helperConversationId = harness.state.helperConversationId as string;
            const mentionedConversationId = harness.state.mentionedConversationId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '请先让 @ScenarioMixMentioned 看一下，再一起推进这个 task thread。',
              replyTo: threadRootId,
            });
            expect(response.status).toBe(201);
            await settleHarness();

            const ownerDebug = await waitForLocalDebug(harness, ownerConversationId);
            const helperDebug = await waitForLocalDebug(harness, helperConversationId);
            const mentionedDebug = await waitForLocalDebug(harness, mentionedConversationId);

            expect(ownerDebug.promptText).toContain('received a reply from User');
            expect(helperDebug.promptText).toContain('received a reply from User');
            expect(mentionedDebug.promptText).toContain('You were @mentioned');

            const sharedParticipants = '@ScenarioMixOwner (owner)\n@ScenarioMixHelper (participant)\n@ScenarioMixMentioned (participant)';
            expect(participantsBlock(ownerDebug.contextText)).toBe(sharedParticipants);
            expect(participantsBlock(helperDebug.contextText)).toBe(sharedParticipants);
            expect(participantsBlock(mentionedDebug.contextText)).toBe(sharedParticipants);

            for (const debugRow of [ownerDebug, helperDebug, mentionedDebug]) {
              expect(debugRow.contextText).toContain('[Bound task-message for this thread]');
              expect(debugRow.contextText).toContain('#512 [in_progress] @ScenarioMixOwner — Scenario mixed priority task');
              expect(debugRow.contextText).not.toContain('[Task-message board summary]');
            }
          },
        },
      ],
    },
    {
      id: 'user_duplicate_mentions_single_queue',
      summary: '同一条用户根消息重复 @ 同一个 agent 时，只应为该 target 生成一条 queue 并在后续只 resume 一次',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-user-dup-${randomUUID().slice(0, 8)}` });
        const bob = createJoinedAgent(harness, {
          name: 'ScenarioUserDupBob',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-user-dup-bob',
        });

        const bobConv = requireChannelConversation(harness, bob.agentId, channel.channelId, null);
        createConversationRun(harness, {
          conversationId: bobConv.id,
          runId: 'scenario-user-dup-active',
          promptText: 'already active on root',
        });
        setConversationStatus(harness, bobConv.id, 'active');

        harness.state = {
          channelId: channel.channelId,
          bobConversationId: bobConv.id,
          activeRunId: 'scenario-user-dup-active',
        };
      },
      steps: [
        {
          name: 'duplicate_mentions_only_enqueue_once',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const bobConversationId = harness.state.bobConversationId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '@ScenarioUserDupBob 先看一下这个问题，同一条消息里再 @ScenarioUserDupBob 一次也不应重复排队。',
            });
            expect(response.status).toBe(201);
            await settleHarness();

            expect(queueRows(harness, bobConversationId)).toHaveLength(1);
            expect(queueRows(harness, bobConversationId)[0]?.promptText).toContain('You were @mentioned');
            expect(
              harness.dispatches.filter((msg) => msg.type === 'run.dispatch' && msg.conversationId === bobConversationId),
            ).toHaveLength(0);
            expect(conversationRunCount(harness, null, channelId, null, bobConversationId)).toBe(1);
          },
        },
        {
          name: 'settling_active_run_resumes_once_without_leftover_queue',
          run: async (harness) => {
            const bobConversationId = harness.state.bobConversationId as string;
            const activeRunId = harness.state.activeRunId as string;

            finishRun(harness.db, { runId: activeRunId, stopReason: 'end_turn' });
            setConversationStatus(harness, bobConversationId, 'idle');
            await harness.manager.onConversationSettled(bobConversationId);
            await settleHarness();

            const resumed = latestDispatch(harness, bobConversationId);
            expect(resumed?.dispatchMode).toBe('resume');
            expect(resumed?.prompt).toContain('You were @mentioned');
            expect(queueRows(harness, bobConversationId)).toHaveLength(0);
          },
        },
      ],
    },
    {
      id: 'agent_duplicate_mentions_single_wake',
      summary: '同一条 agent 根消息重复 @ 同一个目标时，只应唤醒一次并只记录一条 cooldown',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-dup-${randomUUID().slice(0, 8)}` });
        const alice = createJoinedAgent(harness, {
          name: 'ScenarioDupAlice',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-dup-alice',
        });
        const bob = createJoinedAgent(harness, {
          name: 'ScenarioDupBob',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-dup-bob',
        });

        const aliceConv = requireChannelConversation(harness, alice.agentId, channel.channelId, null);
        const bobConv = requireChannelConversation(harness, bob.agentId, channel.channelId, null);
        createConversationRun(harness, {
          conversationId: aliceConv.id,
          runId: 'scenario-dup-source',
          promptText: 'root coordination from alice',
        });

        harness.state = {
          channelId: channel.channelId,
          channelName: channel.name,
          aliceAgentId: alice.agentId,
          bobAgentId: bob.agentId,
          aliceConversationId: aliceConv.id,
          bobConversationId: bobConv.id,
        };
      },
      steps: [
        {
          name: 'duplicate_mentions_dispatch_once_and_record_one_cooldown_row',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const channelName = harness.state.channelName as string;
            const aliceAgentId = harness.state.aliceAgentId as string;
            const bobAgentId = harness.state.bobAgentId as string;
            const aliceConversationId = harness.state.aliceConversationId as string;
            const bobConversationId = harness.state.bobConversationId as string;

            const response = await sendAgentMessage(harness, {
              agentId: aliceAgentId,
              conversationId: aliceConversationId,
              target: `#${channelName}`,
              content: '请 @ScenarioDupBob 看一下，同一条消息里再 @ScenarioDupBob 一次也不应重复唤醒。',
              kind: 'progress',
            });
            expect(response.status).toBe(200);
            await settleHarness();

            expect(conversationRunCount(harness, null, channelId, null, bobConversationId)).toBe(1);
            expect(queueRows(harness, bobConversationId)).toHaveLength(0);
            expect(
              harness.dispatches.filter((msg) => msg.type === 'run.dispatch' && msg.conversationId === bobConversationId),
            ).toHaveLength(1);
            expect(countMentionCooldowns(harness, {
              channelId,
              fromAgentId: aliceAgentId,
              toAgentId: bobAgentId,
            })).toBe(1);

            const bobDebug = await waitForLocalDebug(harness, bobConversationId);
            expect(bobDebug.promptText).toContain('Another agent (@ScenarioDupAlice) explicitly asked for your help');
          },
        },
      ],
    },
    {
      id: 'same_agent_root_thread_queue_isolation',
      summary: '同一 agent 的 root/thread conversation 同时 active 时，root mention 和 thread reply 应各自只进入对应 queue',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-isolation-${randomUUID().slice(0, 8)}` });
        const bob = createJoinedAgent(harness, {
          name: 'ScenarioIsoBob',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-iso-bob',
        });

        const rootConv = requireChannelConversation(harness, bob.agentId, channel.channelId, null);
        const threadRootId = 'isoqroot';
        insertChannelMessage(harness, {
          messageId: `${threadRootId}-0000-0000-0000-000000000000`,
          channelId: channel.channelId,
          senderId: bob.agentId,
          senderName: bob.name,
          senderType: 'agent',
          target: `#${channel.name}`,
          content: 'Isolation thread root',
          createdAt: harness.now(),
          threadRootId,
        });
        const threadConv = requireChannelConversation(harness, bob.agentId, channel.channelId, threadRootId);

        createConversationRun(harness, {
          conversationId: rootConv.id,
          runId: 'scenario-isolation-root-active',
          promptText: 'active root branch',
        });
        setConversationStatus(harness, rootConv.id, 'active');
        createConversationRun(harness, {
          conversationId: threadConv.id,
          runId: 'scenario-isolation-thread-active',
          promptText: 'active thread branch',
        });
        setConversationStatus(harness, threadConv.id, 'active');

        harness.state = {
          channelId: channel.channelId,
          rootConversationId: rootConv.id,
          threadConversationId: threadConv.id,
          rootRunId: 'scenario-isolation-root-active',
          threadRunId: 'scenario-isolation-thread-active',
          threadRootId,
        };
      },
      steps: [
        {
          name: 'root_mention_hits_root_queue',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const rootConversationId = harness.state.rootConversationId as string;
            const threadConversationId = harness.state.threadConversationId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '@ScenarioIsoBob 先看一下 root 分支的问题。',
            });
            expect(response.status).toBe(201);
            await settleHarness();

            expect(queueRows(harness, rootConversationId)).toHaveLength(1);
            expect(queueRows(harness, rootConversationId)[0]?.promptText).toContain('You were @mentioned');
            expect(queueRows(harness, threadConversationId)).toHaveLength(0);
          },
        },
        {
          name: 'thread_reply_only_hits_thread_queue',
          run: async (harness) => {
            const channelId = harness.state.channelId as string;
            const rootConversationId = harness.state.rootConversationId as string;
            const threadConversationId = harness.state.threadConversationId as string;
            const threadRootId = harness.state.threadRootId as string;

            const response = await postUserChannelMessage(harness, {
              channelId,
              content: '线程分支这里也需要更新。',
              replyTo: threadRootId,
            });
            expect(response.status).toBe(201);
            await settleHarness();

            expect(queueRows(harness, rootConversationId)).toHaveLength(1);
            expect(queueRows(harness, threadConversationId)).toHaveLength(1);
            expect(queueRows(harness, threadConversationId)[0]?.promptText).toContain('received a reply from User');
          },
        },
        {
          name: 'settling_each_branch_only_resumes_its_own_queue',
          run: async (harness) => {
            const rootConversationId = harness.state.rootConversationId as string;
            const threadConversationId = harness.state.threadConversationId as string;
            const rootRunId = harness.state.rootRunId as string;
            const threadRunId = harness.state.threadRunId as string;

            finishRun(harness.db, { runId: rootRunId, stopReason: 'end_turn' });
            setConversationStatus(harness, rootConversationId, 'idle');
            await harness.manager.onConversationSettled(rootConversationId);
            await settleHarness();

            const rootResume = latestDispatch(harness, rootConversationId);
            expect(rootResume?.dispatchMode).toBe('resume');
            expect(rootResume?.prompt).toContain('You were @mentioned');
            expect(queueRows(harness, threadConversationId)).toHaveLength(1);

            finishRun(harness.db, { runId: threadRunId, stopReason: 'end_turn' });
            setConversationStatus(harness, threadConversationId, 'idle');
            await harness.manager.onConversationSettled(threadConversationId);
            await settleHarness();

            const threadResume = latestDispatch(harness, threadConversationId);
            expect(threadResume?.dispatchMode).toBe('resume');
            expect(threadResume?.prompt).toContain('received a reply from User');
          },
        },
      ],
    },
    {
      id: 'agent_mention_cooldown_direction_and_boundary',
      summary: 'agent mention cooldown 应区分方向，并在超出边界后允许重新唤醒',
      setup: async (harness) => {
        const channel = harness.manager.createChannel({ name: `scenario-cooldown-${randomUUID().slice(0, 8)}` });
        const alice = createJoinedAgent(harness, {
          name: 'ScenarioCoolAlice',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-cool-alice',
        });
        const bob = createJoinedAgent(harness, {
          name: 'ScenarioCoolBob',
          channelId: channel.channelId,
          workspacePath: '/tmp/scenario-cool-bob',
        });

        const aliceConv = requireChannelConversation(harness, alice.agentId, channel.channelId, null);
        const bobConv = requireChannelConversation(harness, bob.agentId, channel.channelId, null);
        createConversationRun(harness, {
          conversationId: aliceConv.id,
          runId: 'scenario-cooldown-alice-source',
          promptText: 'root coordination from alice',
        });

        harness.state = {
          channelId: channel.channelId,
          channelName: channel.name,
          aliceAgentId: alice.agentId,
          bobAgentId: bob.agentId,
          aliceConversationId: aliceConv.id,
          bobConversationId: bobConv.id,
        };
      },
      steps: [
        {
          name: 'same_direction_repeat_is_suppressed_within_cooldown',
          run: async (harness) => {
            const channelName = harness.state.channelName as string;
            const aliceAgentId = harness.state.aliceAgentId as string;
            const bobAgentId = harness.state.bobAgentId as string;
            const aliceConversationId = harness.state.aliceConversationId as string;
            const bobConversationId = harness.state.bobConversationId as string;
            const channelId = harness.state.channelId as string;

            const first = await sendAgentMessage(harness, {
              agentId: aliceAgentId,
              conversationId: aliceConversationId,
              target: `#${channelName}`,
              content: 'First ping to @ScenarioCoolBob.',
              kind: 'progress',
            });
            expect(first.status).toBe(200);
            await settleHarness();

            expect(conversationRunCount(harness, null, channelId, null, bobConversationId)).toBe(1);
            expect(countMentionCooldowns(harness, {
              channelId,
              fromAgentId: aliceAgentId,
              toAgentId: bobAgentId,
            })).toBe(1);

            harness.advanceTime(30_000);
            const second = await sendAgentMessage(harness, {
              agentId: aliceAgentId,
              conversationId: aliceConversationId,
              target: `#${channelName}`,
              content: 'Second ping to @ScenarioCoolBob within cooldown.',
              kind: 'progress',
            });
            expect(second.status).toBe(200);
            await settleHarness();

            expect(conversationRunCount(harness, null, channelId, null, bobConversationId)).toBe(1);
            expect(queueRows(harness, bobConversationId)).toHaveLength(0);
          },
        },
        {
          name: 'reverse_direction_is_tracked_separately',
          run: async (harness) => {
            const channelName = harness.state.channelName as string;
            const aliceAgentId = harness.state.aliceAgentId as string;
            const bobAgentId = harness.state.bobAgentId as string;
            const aliceConversationId = harness.state.aliceConversationId as string;
            const bobConversationId = harness.state.bobConversationId as string;
            const channelId = harness.state.channelId as string;

            const reverse = await sendAgentMessage(harness, {
              agentId: bobAgentId,
              conversationId: bobConversationId,
              target: `#${channelName}`,
              content: 'Reply ping to @ScenarioCoolAlice from Bob.',
              kind: 'progress',
            });
            expect(reverse.status).toBe(200);
            await settleHarness();

            const aliceQueued = queueRows(harness, aliceConversationId);
            expect(aliceQueued).toHaveLength(1);
            expect(aliceQueued[0]?.promptText).toContain('Another agent (@ScenarioCoolBob) explicitly asked for your help');
            expect(countMentionCooldowns(harness, {
              channelId,
              fromAgentId: bobAgentId,
              toAgentId: aliceAgentId,
            })).toBe(1);
          },
        },
        {
          name: 'expired_same_direction_cooldown_allows_retrigger',
          run: async (harness) => {
            const channelName = harness.state.channelName as string;
            const aliceAgentId = harness.state.aliceAgentId as string;
            const bobAgentId = harness.state.bobAgentId as string;
            const aliceConversationId = harness.state.aliceConversationId as string;
            const bobConversationId = harness.state.bobConversationId as string;
            const channelId = harness.state.channelId as string;
            const latestBobRunId = latestConversationRunId(harness, bobConversationId);

            expect(latestBobRunId).toBeTruthy();
            finishRun(harness.db, { runId: latestBobRunId!, stopReason: 'end_turn' });
            setConversationStatus(harness, bobConversationId, 'idle');
            await harness.manager.onConversationSettled(bobConversationId);
            harness.advanceTime(30_001);

            const third = await sendAgentMessage(harness, {
              agentId: aliceAgentId,
              conversationId: aliceConversationId,
              target: `#${channelName}`,
              content: 'Third ping to @ScenarioCoolBob after cooldown expiry.',
              kind: 'progress',
            });
            expect(third.status).toBe(200);
            await settleHarness();

            expect(conversationRunCount(harness, null, channelId, null, bobConversationId)).toBe(2);
            expect(countMentionCooldowns(harness, {
              channelId,
              fromAgentId: aliceAgentId,
              toAgentId: bobAgentId,
            })).toBe(1);
          },
        },
      ],
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.summary}`, async () => {
      const harness = await createCollaborationHarness();
      harnessesToClose.push(harness.close);
      if (scenario.setup) await scenario.setup(harness);
      for (const step of scenario.steps) {
        await step.run(harness);
      }
    });
  }
});
