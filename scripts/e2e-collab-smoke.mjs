#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../apps/core/package.json', import.meta.url));
const WebSocket = require('ws');

const CORE_URL = (process.env.CORE_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const WS_BASE_URL = CORE_URL.replace(/^http/, 'ws');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const SMOKE_NODE_ID = process.env.SMOKE_NODE_ID ?? '';
const SMOKE_AGENT_TYPE = process.env.SMOKE_AGENT_TYPE ?? 'claude_acp';
const SMOKE_WORKSPACE_ROOT = process.env.SMOKE_WORKSPACE_ROOT ?? '/tmp/agent-collab-smoke';
const RUN_TAG = process.env.SMOKE_RUN_TAG ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

const args = process.argv.slice(2);
const hasArg = (name) => args.includes(name);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const scenarioFilter = getArg('--scenario')?.trim() ?? null;
const timeoutMs = Math.max(5_000, Number(getArg('--timeout-ms') ?? 90_000));
const keepGoing = hasArg('--keep-going');

function usage() {
  return [
    'Usage: node scripts/e2e-collab-smoke.mjs [--list] [--scenario <name>] [--keep-going] [--timeout-ms <ms>]',
    '',
    'Required environment:',
    '  CORE_URL=http://127.0.0.1:3100',
    '  SMOKE_NODE_ID=<connected node id>',
    '  ADMIN_TOKEN=<bearer token>  or  ADMIN_USERNAME=<user> + ADMIN_PASSWORD=<pass>',
    '',
    'Optional environment:',
    '  SMOKE_AGENT_TYPE=claude_acp|codex_acp',
    '  SMOKE_WORKSPACE_ROOT=/tmp/agent-collab-smoke',
    '  SMOKE_RUN_TAG=custom-suffix',
  ].join('\n');
}

async function main() {
  const scenarios = buildScenarios();
  if (hasArg('--list')) {
    for (const scenario of scenarios) {
      console.log(`${scenario.name}: ${scenario.summary}`);
    }
    return;
  }

  if (!SMOKE_NODE_ID) {
    throw new Error('SMOKE_NODE_ID is required.\n\n' + usage());
  }

  const token = await ensureAdminToken();
  await ensureNodeVisible(token, SMOKE_NODE_ID);

  const selected = scenarioFilter
    ? scenarios.filter((scenario) => scenario.name === scenarioFilter)
    : scenarios;
  if (selected.length === 0) {
    throw new Error(`Unknown scenario: ${scenarioFilter}`);
  }

  const results = [];
  for (const scenario of selected) {
    const startedAt = Date.now();
    try {
      await scenario.run({
        token,
        timeoutMs,
        runTag: RUN_TAG,
      });
      const durationMs = Date.now() - startedAt;
      results.push({ name: scenario.name, status: 'passed', durationMs });
      console.log(`PASS ${scenario.name} (${durationMs}ms)`);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      results.push({ name: scenario.name, status: 'failed', durationMs, error: String(error?.message ?? error) });
      console.error(`FAIL ${scenario.name} (${durationMs}ms)`);
      console.error(`  ${String(error?.message ?? error)}`);
      if (!keepGoing) break;
    }
  }

  console.log('\nSmoke summary');
  for (const result of results) {
    if (result.status === 'passed') {
      console.log(`- ${result.name}: passed (${result.durationMs}ms)`);
    } else {
      console.log(`- ${result.name}: failed (${result.durationMs}ms)`);
      console.log(`  ${result.error}`);
    }
  }

  if (results.some((result) => result.status === 'failed')) {
    process.exitCode = 1;
  }
}

function buildScenarios() {
  return [
    {
      name: 'dm_restore_smoke',
      summary: 'restart 后的 direct conversation prompt 不应重复最近历史',
      run: async (ctx) => {
        const agent = await createAgent(ctx.token, {
          name: `SmokeRestore-${ctx.runTag}`,
          channelId: 'default',
        });
        const conversation = await postJson(`/api/agents/${agent.agentId}/open-thread`, { method: 'POST' }, ctx.token);
        const stream = await openConversationStream(conversation.id, ctx.token);
        try {
          await postJson(`/api/conversations/${conversation.id}/prompt`, {
            method: 'POST',
            body: JSON.stringify({ text: 'Remember the phrase pumpkin ladder.' }),
          }, ctx.token);
          await waitForConversationTurnEnd(stream.events, 1, ctx.timeoutMs);

          await postJson(`/api/conversations/${conversation.id}/restart`, { method: 'POST' }, ctx.token);
          await postJson(`/api/conversations/${conversation.id}/prompt`, {
            method: 'POST',
            body: JSON.stringify({ text: 'What phrase did I ask you to remember?' }),
          }, ctx.token);
          await waitForConversationTurnEnd(stream.events, 2, ctx.timeoutMs);

          const evidence = await getLatestPromptEvidence(conversation.id, ctx.token);
          expectContains(evidence.promptText, 'What phrase did I ask you to remember?');
          const oldPromptCount = countOccurrences(evidence.promptText, 'Remember the phrase pumpkin ladder.');
          if (oldPromptCount > 1) {
            throw new Error(`Restore replay duplicated prior direct-history tail (${oldPromptCount} occurrences).`);
          }
        } finally {
          stream.close();
        }
      },
    },
    {
      name: 'active_conversation_queue_resume',
      summary: '同一 direct conversation 的第二条 prompt 应进入 queue 并在前一轮结束后恢复',
      run: async (ctx) => {
        const agent = await createAgent(ctx.token, {
          name: `SmokeQueue-${ctx.runTag}`,
          channelId: 'default',
        });
        const conversation = await postJson(`/api/agents/${agent.agentId}/open-thread`, { method: 'POST' }, ctx.token);
        const stream = await openConversationStream(conversation.id, ctx.token);
        try {
          await postJson(`/api/conversations/${conversation.id}/prompt`, {
            method: 'POST',
            body: JSON.stringify({ text: 'Give me a short three-point checklist about queue handling.' }),
          }, ctx.token);
          await waitForEvent(stream.events, (event) => event.type === 'turn.begin' || (event.type === 'conversation.status' && event.status === 'active'), ctx.timeoutMs, 'first run to start');

          const queued = await postJson(`/api/conversations/${conversation.id}/prompt`, {
            method: 'POST',
            body: JSON.stringify({ text: 'After that, summarize the result in one sentence.' }),
          }, ctx.token);
          if (!queued.queued) {
            throw new Error('Second prompt did not queue while the first run was active.');
          }

          await waitForConversationTurnEnd(stream.events, 2, ctx.timeoutMs);

          const history = await getJson(`/api/conversations/${conversation.id}/history`, ctx.token);
          if (!Array.isArray(history) || history.length < 2) {
            throw new Error('Expected at least two runs after queued resume.');
          }
        } finally {
          stream.close();
        }
      },
    },
    {
      name: 'channel_multi_agent_mention',
      summary: '主频道一次 @ 多个 agent 时，两个 branch prompt 应包含同一 participants block',
      run: async (ctx) => {
        const channel = await createChannel(ctx.token, {
          name: `smoke-mention-${ctx.runTag}`,
          collaborationMode: 'mention_only',
        });
        const alpha = await createAgent(ctx.token, {
          name: `SmokeMentionAlpha-${ctx.runTag}`,
          channelId: channel.channelId,
        });
        const beta = await createAgent(ctx.token, {
          name: `SmokeMentionBeta-${ctx.runTag}`,
          channelId: channel.channelId,
        });
        await joinAgentToChannel(ctx.token, channel.channelId, alpha.agentId);
        await joinAgentToChannel(ctx.token, channel.channelId, beta.agentId);

        const channelStream = await openChannelStream(channel.channelId, ctx.token);
        try {
          await postJson(`/api/channels/${channel.channelId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content: `@${alpha.name} @${beta.name} please coordinate on this smoke test.` }),
          }, ctx.token);

          await waitForEvent(channelStream.events, (event) => event.type === 'channel.notice', ctx.timeoutMs, 'channel notice');

          const alphaConv = await postJson(`/api/channels/${channel.channelId}/agents/${alpha.agentId}/open-session`, {
            method: 'POST',
            body: JSON.stringify({ threadRootId: null }),
          }, ctx.token);
          const betaConv = await postJson(`/api/channels/${channel.channelId}/agents/${beta.agentId}/open-session`, {
            method: 'POST',
            body: JSON.stringify({ threadRootId: null }),
          }, ctx.token);

          const alphaEvidence = await waitForPromptEvidence(alphaConv.id, ctx.token, (promptText) => promptText.includes('You were @mentioned'), ctx.timeoutMs);
          const betaEvidence = await waitForPromptEvidence(betaConv.id, ctx.token, (promptText) => promptText.includes('You were @mentioned'), ctx.timeoutMs);

          const alphaParticipants = extractParticipantsBlock(alphaEvidence.contextText);
          const betaParticipants = extractParticipantsBlock(betaEvidence.contextText);
          if (!alphaParticipants || alphaParticipants !== betaParticipants) {
            throw new Error('Mentioned agents did not receive the same active-participants block.');
          }
        } finally {
          channelStream.close();
        }
      },
    },
    {
      name: 'thread_recent_participant',
      summary: 'task thread 二次回复时，prompt context 应继续保留 thread recent history',
      run: async (ctx) => {
        const channel = await createChannel(ctx.token, {
          name: `smoke-thread-${ctx.runTag}`,
          collaborationMode: 'mention_only',
        });
        const owner = await createAgent(ctx.token, {
          name: `SmokeThreadOwner-${ctx.runTag}`,
          channelId: channel.channelId,
        });
        await joinAgentToChannel(ctx.token, channel.channelId, owner.agentId);

        const task = await postJson(`/api/channels/${channel.channelId}/tasks`, {
          method: 'POST',
          body: JSON.stringify({
            title: 'Smoke recent participant task',
            description: 'Goal: make sure the task thread keeps recent-history context across multiple user replies.',
          }),
        }, ctx.token);
        await postJson(`/api/channels/${channel.channelId}/tasks/${task.taskNumber}/claim`, {
          method: 'POST',
          body: JSON.stringify({ agentId: owner.agentId }),
        }, ctx.token);

        const conversation = await postJson(`/api/channels/${channel.channelId}/agents/${owner.agentId}/open-session`, {
          method: 'POST',
          body: JSON.stringify({ threadRootId: task.linkedThreadShortId }),
        }, ctx.token);

        await postJson(`/api/channels/${channel.channelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: '第一轮：请先同步当前状态。', replyTo: task.linkedThreadShortId }),
        }, ctx.token);
        await waitForPromptEvidence(conversation.id, ctx.token, (promptText) => promptText.includes('第一轮'), ctx.timeoutMs);

        await postJson(`/api/channels/${channel.channelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: '第二轮：再补一句 thread 总结。', replyTo: task.linkedThreadShortId }),
        }, ctx.token);
        const evidence = await waitForPromptEvidence(conversation.id, ctx.token, (promptText) => promptText.includes('第二轮'), ctx.timeoutMs);

        expectContains(evidence.contextText ?? '', '[Recent messages on this exact target]');
        expectContains(evidence.contextText ?? '', '第一轮：请先同步当前状态。');
      },
    },
    {
      name: 'task_thread_assignee_priority',
      summary: 'task thread 用户回复时，assignee branch prompt 应包含 bound task brief',
      run: async (ctx) => {
        const channel = await createChannel(ctx.token, {
          name: `smoke-task-${ctx.runTag}`,
          collaborationMode: 'mention_only',
        });
        const owner = await createAgent(ctx.token, {
          name: `SmokeTaskOwner-${ctx.runTag}`,
          channelId: channel.channelId,
        });
        await joinAgentToChannel(ctx.token, channel.channelId, owner.agentId);

        const task = await postJson(`/api/channels/${channel.channelId}/tasks`, {
          method: 'POST',
          body: JSON.stringify({
            title: 'Smoke assignee priority task',
            description: 'Goal: verify assignee receives a task-thread prompt with the bound task brief.',
          }),
        }, ctx.token);
        await postJson(`/api/channels/${channel.channelId}/tasks/${task.taskNumber}/claim`, {
          method: 'POST',
          body: JSON.stringify({ agentId: owner.agentId }),
        }, ctx.token);

        const conversation = await postJson(`/api/channels/${channel.channelId}/agents/${owner.agentId}/open-session`, {
          method: 'POST',
          body: JSON.stringify({ threadRootId: task.linkedThreadShortId }),
        }, ctx.token);

        await postJson(`/api/channels/${channel.channelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            content: '请在这个 task thread 里给出当前计划。',
            replyTo: task.linkedThreadShortId,
          }),
        }, ctx.token);

        const evidence = await waitForPromptEvidence(conversation.id, ctx.token, (promptText) => promptText.includes('received a reply'), ctx.timeoutMs);
        expectContains(evidence.contextText ?? '', '[Bound task-message for this thread]');
        expectContains(evidence.contextText ?? '', `#${task.taskNumber} [in_progress]`);
      },
    },
    {
      name: 'done_task_no_stale_owner',
      summary: 'done task 的 thread summary 不应继续暴露 owner',
      run: async (ctx) => {
        const channel = await createChannel(ctx.token, {
          name: `smoke-done-${ctx.runTag}`,
          collaborationMode: 'mention_only',
        });
        const owner = await createAgent(ctx.token, {
          name: `SmokeDoneOwner-${ctx.runTag}`,
          channelId: channel.channelId,
        });
        await joinAgentToChannel(ctx.token, channel.channelId, owner.agentId);

        const task = await postJson(`/api/channels/${channel.channelId}/tasks`, {
          method: 'POST',
          body: JSON.stringify({
            title: 'Smoke done task',
            description: 'Goal: verify done task threads do not continue to expose owner semantics.',
          }),
        }, ctx.token);
        await postJson(`/api/channels/${channel.channelId}/tasks/${task.taskNumber}/claim`, {
          method: 'POST',
          body: JSON.stringify({ agentId: owner.agentId }),
        }, ctx.token);
        await patchJson(`/api/channels/${channel.channelId}/tasks/${task.taskNumber}/status`, {
          status: 'done',
        }, ctx.token);
        await postJson(`/api/channels/${channel.channelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            content: '这个 done task 再补一条后续说明。',
            replyTo: task.linkedThreadShortId,
          }),
        }, ctx.token);

        const summary = await getJson(`/api/channels/${channel.channelId}/threads/${task.linkedThreadShortId}/summary`, ctx.token);
        if (summary.ownerAgentId || summary.ownerName) {
          throw new Error('Done task thread summary still exposes an owner.');
        }
      },
    },
  ];
}

async function ensureAdminToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    throw new Error('Provide ADMIN_TOKEN or ADMIN_USERNAME + ADMIN_PASSWORD.\n\n' + usage());
  }
  const result = await postJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  });
  if (!result.token) {
    throw new Error('Login did not return a bearer token.');
  }
  return result.token;
}

async function ensureNodeVisible(token, nodeId) {
  const nodes = await getJson('/api/nodes', token);
  if (!Array.isArray(nodes) || !nodes.some((node) => node.nodeId === nodeId)) {
    throw new Error(`Node ${nodeId} is not visible from core.`);
  }
}

async function createChannel(token, { name, collaborationMode }) {
  return postJson('/api/channels', {
    method: 'POST',
    body: JSON.stringify({
      name,
      collaborationMode,
    }),
  }, token);
}

async function createAgent(token, { name, channelId }) {
  return postJson('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      agentType: SMOKE_AGENT_TYPE,
      nodeId: SMOKE_NODE_ID,
      channelId,
      workspacePath: `${SMOKE_WORKSPACE_ROOT}/${name}`,
    }),
  }, token);
}

async function joinAgentToChannel(token, channelId, agentId) {
  return postJson(`/api/channels/${channelId}/agents/${agentId}`, {
    method: 'POST',
  }, token);
}

async function patchJson(path, body, token) {
  return postJson(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, token);
}

async function getLatestPromptEvidence(conversationId, token) {
  try {
    const debug = await getJson(`/api/conversations/${conversationId}/codex-debug`, token);
    const inputs = [];
    for (const rollout of debug.rollouts ?? []) {
      for (const turn of rollout.turns ?? []) {
        if (turn.platformInput) {
          inputs.push(turn.platformInput);
        }
      }
    }
    for (const input of debug.unmatchedPlatformInputs ?? []) {
      inputs.push(input);
    }
    inputs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const latest = inputs.at(-1);
    if (latest?.promptText) {
      return {
        promptText: latest.promptText,
        contextText: latest.contextText ?? null,
      };
    }
  } catch {
    // Fall back to conversation history when debug is unavailable.
  }

  const history = await getJson(`/api/conversations/${conversationId}/history`, token);
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error(`No conversation history available for ${conversationId}.`);
  }
  const latest = history.at(-1);
  return {
    promptText: latest.promptText ?? '',
    contextText: null,
  };
}

async function waitForPromptEvidence(conversationId, token, predicate, timeout) {
  return waitFor(async () => {
    const evidence = await getLatestPromptEvidence(conversationId, token);
    return predicate(evidence.promptText, evidence.contextText) ? evidence : null;
  }, timeout, `prompt evidence for ${conversationId}`);
}

async function getJson(path, token) {
  const response = await fetch(`${CORE_URL}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function postJson(path, init, token) {
  const response = await fetch(`${CORE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'POST'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

async function openConversationStream(conversationId, token) {
  return openWs(`${WS_BASE_URL}/api/conversations/${conversationId}/stream?token=${encodeURIComponent(token)}`);
}

async function openChannelStream(channelId, token) {
  return openWs(`${WS_BASE_URL}/api/channels/${channelId}/stream?token=${encodeURIComponent(token)}`);
}

async function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events = [];
    ws.on('message', (data) => {
      try {
        events.push(JSON.parse(data.toString()));
      } catch {
        events.push({ type: 'raw', data: data.toString() });
      }
    });
    ws.on('open', () => resolve({
      events,
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}

async function waitForConversationTurnEnd(events, expectedCount, timeout) {
  return waitFor(
    async () => (events.filter((event) => event.type === 'turn.end').length >= expectedCount ? true : null),
    timeout,
    `conversation turn.end x${expectedCount}`,
  );
}

async function waitForEvent(events, predicate, timeout, label) {
  return waitFor(
    async () => events.find((event) => predicate(event)) ?? null,
    timeout,
    label,
  );
}

async function waitFor(producer, timeout, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await producer();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractParticipantsBlock(text) {
  return /\[Active participants on this target\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(text ?? '')?.[1]?.trim() ?? '';
}

function expectContains(text, needle) {
  if (!String(text).includes(needle)) {
    throw new Error(`Expected text to include: ${needle}`);
  }
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text).split(needle).length - 1;
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
