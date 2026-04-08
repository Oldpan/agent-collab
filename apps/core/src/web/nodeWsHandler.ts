import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { NodeToCore, ServerEvent, ConversationStatus } from '@agent-collab/protocol';
import { log, finishRun } from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import type { NodeRegistry } from '../services/nodeRegistry.js';
import type { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import type { AgentSkillsBroker } from '../services/agentSkillsBroker.js';
import type { CodexTranscriptBroker } from '../services/codexTranscriptBroker.js';
import type { ClaudeTranscriptBroker } from '../services/claudeTranscriptBroker.js';
import type { ConversationManager } from './conversationManager.js';
import { resolveConversationReplyTarget } from './directReplyTargets.js';
import { allocateNextChannelMessageSeq } from './channelMessageSequences.js';
import { getBoundTaskForThread } from './threadTaskBindings.js';

/** Persist a ServerEvent from a remote run into core DB as a node/event entry */
function appendNodeEvent(db: Db, runId: string, seq: number, event: ServerEvent): void {
  db.prepare(
    'INSERT OR IGNORE INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
  ).run(runId, seq, 'node/event', JSON.stringify(event), Date.now());
}

function applyRunDebugSnapshot(
  db: Db,
  params: {
    runId: string;
    conversationId: string;
    sessionKey: string;
    acpSessionId: string;
    isFreshSession: boolean;
    isExact: boolean;
    effectiveSystemPromptText?: string;
    effectiveContextText?: string;
  },
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE run_debug_inputs
        SET acp_session_id = ?,
            is_fresh_session = ?,
            is_exact = ?,
            system_prompt_text = COALESCE(?, system_prompt_text),
            context_text = ?,
            updated_at = ?
      WHERE run_id = ?`,
  ).run(
    params.acpSessionId,
    params.isFreshSession ? 1 : 0,
    params.isExact ? 1 : 0,
    params.effectiveSystemPromptText ?? null,
    params.effectiveContextText ?? null,
    now,
    params.runId,
  );

  db.prepare(
    `UPDATE sessions
        SET acp_session_id = ?,
            system_prompt_text = COALESCE(?, system_prompt_text),
            updated_at = ?
      WHERE session_key = ?`,
  ).run(
    params.acpSessionId,
    params.effectiveSystemPromptText ?? null,
    now,
    params.sessionKey,
  );
}

/** Event types worth persisting for history replay */
const REPLAY_EVENT_TYPES = new Set([
  'content.delta',
  'tool.call',
  'tool.result',
  'thinking.delta',
  'plan.update',
  'task.update',
]);
const DM_TASK_HANDOFF_EVENT_METHOD = 'platform/handoff';
const TASK_STATUS_REMINDER_EVENT_METHOD = 'platform/task-status-reminder';
const TASK_STATUS_REMINDER_PROMPT_PREFIX = '[Platform task status reminder]';

type EventBroadcaster = (conversationId: string, event: ServerEvent) => void;

function nextSyntheticRunEventSeq(db: Db, runId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) as maxSeq
     FROM events
     WHERE run_id = ?`,
  ).get(runId) as { maxSeq: number } | undefined;
  return (row?.maxSeq ?? 0) + 1;
}

function hasRunTaskStatusReminder(db: Db, runId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1
     FROM events
     WHERE run_id = ?
       AND method = ?
     LIMIT 1`,
  ).get(runId, TASK_STATUS_REMINDER_EVENT_METHOD));
}

function isTaskStatusReminderRun(db: Db, runId: string): boolean {
  const row = db.prepare(
    `SELECT prompt_text as promptText
     FROM runs
     WHERE run_id = ?
     LIMIT 1`,
  ).get(runId) as { promptText: string } | undefined;
  return row?.promptText?.startsWith(TASK_STATUS_REMINDER_PROMPT_PREFIX) ?? false;
}

function hasQueuedTaskStatusReminder(db: Db, conversationId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1
     FROM conversation_prompt_queue
     WHERE conversation_id = ?
       AND prompt_text LIKE ?
     LIMIT 1`,
  ).get(conversationId, `${TASK_STATUS_REMINDER_PROMPT_PREFIX}%`));
}

function getTaskBoardTarget(replyTarget: string): string {
  if (replyTarget.startsWith('dm:@')) {
    const parts = replyTarget.split(':');
    return parts.length >= 3 ? parts.slice(0, 2).join(':') : replyTarget;
  }
  if (replyTarget.startsWith('#')) {
    const idx = replyTarget.lastIndexOf(':');
    return idx > 0 ? replyTarget.slice(0, idx) : replyTarget;
  }
  return replyTarget;
}

function buildTaskStatusReminderPrompt(params: {
  replyTarget: string;
  taskNumber: number;
  title: string;
  status: string;
}): string {
  const boardTarget = getTaskBoardTarget(params.replyTarget);
  return [
    TASK_STATUS_REMINDER_PROMPT_PREFIX,
    `This thread is bound to task #${params.taskNumber} "${params.title}", but the task is still marked ${params.status}.`,
    `If the work you just completed is ready for review, call update_task_status(channel="${boardTarget}", task_number=${params.taskNumber}, status="in_review") before replying further.`,
    'Only use status="done" for trivial work or after explicit human approval.',
    'If the work is still ongoing, keep the task open and continue with a progress update in this thread.',
  ].join('\n');
}

function maybeQueueTaskStatusReminder(params: {
  db: Db;
  conversationId: string;
  runId: string;
  stopReason?: string;
  error?: string;
}): void {
  if (params.error) return;
  if (params.stopReason === 'handoff' || isCancelStopReason(params.stopReason)) return;
  if (hasRunTaskStatusReminder(params.db, params.runId) || isTaskStatusReminderRun(params.db, params.runId)) return;

  const conversation = params.db.prepare(
    `SELECT agent_id as agentId,
            channel_id as channelId,
            reply_target as replyTarget,
            thread_root_id as threadRootId
     FROM conversations
     WHERE id = ?
     LIMIT 1`,
  ).get(params.conversationId) as {
    agentId: string | null;
    channelId: string;
    replyTarget: string | null;
    threadRootId: string | null;
  } | undefined;
  if (!conversation?.agentId || !conversation.replyTarget || !conversation.threadRootId) return;

  const boundTask = getBoundTaskForThread(params.db, {
    channelId: conversation.channelId,
    threadRootId: conversation.threadRootId,
  });
  if (!boundTask || (boundTask.status !== 'todo' && boundTask.status !== 'in_progress')) return;
  if (hasQueuedTaskStatusReminder(params.db, params.conversationId)) return;

  const now = Date.now();
  const promptText = buildTaskStatusReminderPrompt({
    replyTarget: conversation.replyTarget,
    taskNumber: boundTask.taskNumber,
    title: boundTask.title,
    status: boundTask.status,
  });

  params.db.prepare(
    `INSERT INTO conversation_prompt_queue(
       agent_id, conversation_id, prompt_text, record_as_user_message, activation_context_text, replay_overlap_recent_messages_json, sender_name, client_message_id, created_at, updated_at
     )
     VALUES(?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(conversation.agentId, params.conversationId, promptText, now, now);

  params.db.prepare(
    `INSERT INTO events(run_id, seq, method, payload_json, created_at)
     VALUES(?, ?, ?, ?, ?)`,
  ).run(
    params.runId,
    nextSyntheticRunEventSeq(params.db, params.runId),
    TASK_STATUS_REMINDER_EVENT_METHOD,
    JSON.stringify({
      conversationId: params.conversationId,
      taskId: boundTask.taskId,
      taskNumber: boundTask.taskNumber,
      status: boundTask.status,
    }),
    now,
  );
}

type ExistingNodeRow = {
  node_id: string;
  status: string;
};

type PendingProvisionedNodeRow = {
  node_id: string;
};

function adoptProvisionedNodeIdentity(
  db: Db,
  pendingNodeId: string,
  registeredNodeId: string,
  hostname: string,
  agentTypesJson: string,
  version: string,
  now: number,
): void {
  db.prepare(
    `UPDATE agents
     SET node_id = ?
     WHERE node_id = ?`,
  ).run(registeredNodeId, pendingNodeId);

  db.prepare(
    `UPDATE conversations
     SET node_id = ?
     WHERE node_id = ?`,
  ).run(registeredNodeId, pendingNodeId);

  db.prepare(
    `UPDATE nodes
     SET node_id = ?,
         hostname = ?,
         agent_types_json = ?,
         version = ?,
         status = 'online',
         last_seen = ?,
         created_at = CASE WHEN created_at = 0 THEN ? ELSE created_at END
     WHERE node_id = ?`,
  ).run(registeredNodeId, hostname, agentTypesJson, version, now, now, pendingNodeId);
}

function requiresMcpReplyContract(db: Db, conversationId: string): boolean {
  const row = db
    .prepare('SELECT agent_id as agentId FROM conversations WHERE id = ?')
    .get(conversationId) as { agentId: string | null } | undefined;
  return Boolean(row?.agentId);
}

function hasRunReplyMessage(db: Db, conversationId: string, runId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(1) as count
       FROM channel_messages
       WHERE run_id = ?
         AND sender_type = 'agent'`,
    )
    .get(runId) as { count: number } | undefined;
  return (row?.count ?? 0) > 0;
}

type RunAgentMessageRow = {
  content: string;
  created_at: number;
  channel_id: string;
  seq: number;
};

type RunDeltaEventRow = {
  createdAt: number;
  seq: number;
  text: string;
};

type FallbackMessageContext = {
  agentId: string;
  agentName: string;
  channelId: string;
  target: string;
  threadRootId: string | null;
};

function hasRunFinalReplyMessage(db: Db, runId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(1) as count
       FROM channel_messages
       WHERE run_id = ?
         AND sender_type = 'agent'
         AND message_kind = 'final'`,
    )
    .get(runId) as { count: number } | undefined;
  return (row?.count ?? 0) > 0;
}

function isCancelStopReason(stopReason?: string): boolean {
  return Boolean(stopReason?.includes('cancel'));
}

function normalizeComparisonText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripLegacyStatusText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:-\s*)?\[(?:plan|task)\]\b/i.test(line))
    .join('\n');
}

function stripInternalReminderTail(text: string): string {
  return text
    .replace(/\(?System reminder acknowledged[\s\S]*$/i, '')
    .trim();
}

function cleanFallbackText(text: string): string {
  return stripInternalReminderTail(stripLegacyStatusText(text)).trim();
}

function isIgnorableFallbackText(text: string): boolean {
  return text.includes(`Empty response: {'content':`);
}

function hasSubstantiveFallbackText(text: string): boolean {
  return text.trim().length > 0;
}

function listRunAgentMessages(db: Db, runId: string): RunAgentMessageRow[] {
  return db.prepare(
    `SELECT content, created_at, channel_id, seq
     FROM channel_messages
     WHERE run_id = ?
       AND sender_type = 'agent'
     ORDER BY created_at ASC, seq ASC`,
  ).all(runId) as RunAgentMessageRow[];
}

function listRunDeltaEvents(db: Db, runId: string): RunDeltaEventRow[] {
  const rows = db
    .prepare(
      `SELECT payload_json as payloadJson
              ,created_at as createdAt
              ,seq
       FROM events
       WHERE run_id = ?
         AND method = 'node/event'
       ORDER BY seq ASC`,
    ).all(runId) as Array<{ payloadJson: string; createdAt: number; seq: number }>;

  const deltas: RunDeltaEventRow[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payloadJson) as { type?: string; text?: string };
      if (payload.type === 'content.delta' && typeof payload.text === 'string') {
        deltas.push({
          createdAt: row.createdAt,
          seq: row.seq,
          text: payload.text,
        });
      }
    } catch {
      // Ignore malformed historic payloads
    }
  }
  return deltas;
}

function collectFallbackSegments(db: Db, runId: string): string[] {
  const replyRows = listRunAgentMessages(db, runId);
  const deltaRows = listRunDeltaEvents(db, runId);
  if (deltaRows.length === 0) return [];

  const timeline = [
    ...replyRows.map((row, index) => ({ type: 'message' as const, createdAt: row.created_at, order: index })),
    ...deltaRows.map((row, index) => ({ type: 'delta' as const, createdAt: row.createdAt, order: index, text: row.text, seq: row.seq })),
  ].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.type !== b.type) return a.type === 'delta' ? -1 : 1;
    return a.order - b.order;
  });

  let buffer = '';
  const rawSegments: string[] = [];
  const flushBuffer = () => {
    if (!buffer) return;
    rawSegments.push(buffer);
    buffer = '';
  };

  for (const item of timeline) {
    if (item.type === 'delta') {
      buffer += item.text;
      continue;
    }
    flushBuffer();
  }
  flushBuffer();

  const existingNormalized = new Set(
    replyRows.map((row) => normalizeComparisonText(cleanFallbackText(row.content))).filter(Boolean),
  );
  const emittedNormalized = new Set<string>();

  return rawSegments
    .map((segment) => cleanFallbackText(segment))
    .filter((segment) => hasSubstantiveFallbackText(segment))
    .filter((segment) => !isIgnorableFallbackText(segment))
    .filter((segment) => {
      const normalized = normalizeComparisonText(segment);
      if (!normalized) return false;
      if (existingNormalized.has(normalized) || emittedNormalized.has(normalized)) return false;
      emittedNormalized.add(normalized);
      return true;
    });
}

function getFallbackMessageContext(
  db: Db,
  conversationId: string,
  humanUserName: string,
): FallbackMessageContext | null {
  const row = db.prepare(
    `SELECT c.id as conversationId,
            c.agent_id as agentId,
            c.channel_id as channelId,
            c.thread_kind as threadKind,
            c.is_primary_thread as isPrimaryThread,
            c.thread_root_id as threadRootId,
            ch.name as channelName,
            a.name as agentName
     FROM conversations c
     JOIN agents a ON a.agent_id = c.agent_id
     LEFT JOIN channels ch ON ch.channel_id = c.channel_id
     WHERE c.id = ?`,
  ).get(conversationId) as {
    conversationId: string;
    agentId: string | null;
    agentName: string;
    channelId: string;
    threadKind: 'direct' | 'branch';
    isPrimaryThread: number;
    threadRootId: string | null;
    channelName: string | null;
  } | undefined;
  if (!row?.agentId) return null;

  const target = resolveConversationReplyTarget(db, conversationId, humanUserName)
    ?? `${`#${row.channelName ?? row.channelId}`}${row.threadRootId ? `:${row.threadRootId}` : ''}`;

  return {
    agentId: row.agentId,
    agentName: row.agentName,
    channelId: row.threadKind === 'direct' ? `dm:${row.agentId}` : row.channelId,
    target,
    threadRootId: row.threadRootId ?? null,
  };
}

function persistDeltaFallbackMessages(params: {
  db: Db,
  conversationId: string,
  runId: string,
  broadcast: EventBroadcaster;
  manager: ConversationManager;
}): number {
  if (!requiresMcpReplyContract(params.db, params.conversationId)) return 0;

  const context = getFallbackMessageContext(
    params.db,
    params.conversationId,
    params.manager.getConfig().humanUserName,
  );
  if (!context) return 0;

  const segments = collectFallbackSegments(params.db, params.runId);
  if (segments.length === 0) return 0;

  let createdAt = Date.now();
  let emittedCount = 0;
  for (const content of segments) {
    const seq = allocateNextChannelMessageSeq(params.db, context.channelId);
    const messageId = randomUUID();
    params.db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, run_id, thread_root_id, message_kind, message_source)
       VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      context.channelId,
      context.agentId,
      context.agentName,
      context.target,
      content,
      seq,
      createdAt,
      params.runId,
      context.threadRootId,
      null,
      'delta_fallback',
    );
    params.broadcast(params.conversationId, {
      type: 'channel.message',
      message: {
        id: messageId,
        senderName: context.agentName,
        senderType: 'agent',
        content,
        createdAt: new Date(createdAt).toISOString(),
        seq,
        messageSource: 'delta_fallback',
        ...(context.threadRootId ? { threadRootId: context.threadRootId } : {}),
      },
    });
    createdAt += 1;
    emittedCount += 1;
  }
  return emittedCount;
}

function getRunEndError(
  msg: { stopReason?: string; error?: string },
  db: Db,
  conversationId: string,
  runId: string,
  wasHandedOff = false,
): string | null {
  if (msg.error) return msg.error;
  if (isCancelStopReason(msg.stopReason)) {
    if (wasHandedOff) return null;
    if (hasRunFinalReplyMessage(db, runId)) return null;
    if (requiresMcpReplyContract(db, conversationId)) {
      return 'Agent run was cancelled before sending a final reply';
    }
    return 'Run cancelled before completion';
  }
  return null;
}

function wasRunHandedOff(db: Db, runId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1
     FROM events
     WHERE run_id = ?
       AND method = ?
     LIMIT 1`,
  ).get(runId, DM_TASK_HANDOFF_EVENT_METHOD));
}

function updateConversationStatus(
  db: Db,
  broadcast: EventBroadcaster,
  conversationId: string,
  status: ConversationStatus,
): void {
  db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), conversationId);
  broadcast(conversationId, {
    type: 'conversation.status',
    conversationId,
    status,
  });
}

function finishConversationRun(params: {
  db: Db;
  broadcast: EventBroadcaster;
  manager: ConversationManager;
  conversationId: string;
  runId: string;
  stopReason?: string;
  error?: string;
}): void {
  const endedAt = Date.now();
  finishRun(
    params.db,
    params.error
      ? { runId: params.runId, error: params.error }
      : { runId: params.runId, stopReason: params.stopReason ?? 'end_turn' },
  );
  updateConversationStatus(
    params.db,
    params.broadcast,
    params.conversationId,
    params.error ? 'failed' : 'idle',
  );
  params.broadcast(params.conversationId, {
    type: 'turn.end',
    turnId: params.runId,
    stopReason: params.error ? 'error' : (params.stopReason ?? 'end_turn'),
    endedAt,
    error: params.error,
  });
  if (params.error) {
    params.broadcast(params.conversationId, { type: 'error', message: params.error });
  }
  maybeQueueTaskStatusReminder({
    db: params.db,
    conversationId: params.conversationId,
    runId: params.runId,
    stopReason: params.stopReason,
    error: params.error,
  });
  void params.manager.onConversationSettled(params.conversationId);
}

export function handleNodeWebSocket(
  socket: WebSocket,
  registry: NodeRegistry,
  broadcast: EventBroadcaster,
  db: Db,
  manager: ConversationManager,
  workspaceBroker?: AgentWorkspaceBroker,
  skillsBroker?: AgentSkillsBroker,
  codexTranscriptBroker?: CodexTranscriptBroker,
  claudeTranscriptBroker?: ClaudeTranscriptBroker,
): void {
  let nodeId: string | null = null;
  // Sequence counter per runId for node/event persistence
  const runSeq = new Map<string, number>();

  socket.on('message', (raw) => {
    let msg: NodeToCore;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      log.warn('[node-ws] invalid JSON from node');
      return;
    }

    switch (msg.type) {
      case 'node.register': {
        nodeId = msg.nodeId;
        const now = Date.now();

        const existing = db.prepare('SELECT node_id, status FROM nodes WHERE node_id = ?').get(msg.nodeId) as ExistingNodeRow | undefined;
        if (existing?.status === 'deleted') {
          log.warn(`[node-ws] connection rejected: node ${msg.nodeId} was deleted`);
          socket.close(4000, 'Machine has been deleted');
          return;
        }

        registry.register({
          nodeId: msg.nodeId,
          hostname: msg.hostname,
          agentTypes: msg.agentTypes,
          version: msg.version,
          ws: socket,
          lastSeen: now,
        });

        // Persist to DB: update existing pre-provisioned row or insert new
        const agentTypesJson = JSON.stringify(msg.agentTypes);
        if (existing) {
          db.prepare(
            `UPDATE nodes SET hostname=?, agent_types_json=?, version=?, status='online', last_seen=?,
             created_at=CASE WHEN created_at=0 THEN ? ELSE created_at END WHERE node_id=?`
          ).run(msg.hostname, agentTypesJson, msg.version, now, now, msg.nodeId);
        } else {
          const pending = db.prepare(
            `SELECT node_id
             FROM nodes
             WHERE status = 'pending'
               AND display_name = ?
             ORDER BY provisioned_at DESC
             LIMIT 1`,
          ).get(msg.hostname) as PendingProvisionedNodeRow | undefined;

          if (pending) {
            adoptProvisionedNodeIdentity(
              db,
              pending.node_id,
              msg.nodeId,
              msg.hostname,
              agentTypesJson,
              msg.version,
              now,
            );
          } else {
            db.prepare(
              `INSERT INTO nodes(node_id, hostname, agent_types_json, version, status, last_seen, created_at, provisioned_at, display_name, env_var_keys)
               VALUES(?,?,?,?,'online',?,?,0,NULL,'[]')`
            ).run(msg.nodeId, msg.hostname, agentTypesJson, msg.version, now, now);
          }
        }

        socket.send(JSON.stringify({ type: 'node.ack', nodeId: msg.nodeId }));
        const queuedConversationIds = db.prepare(
          `SELECT DISTINCT conversation_id as conversationId
           FROM conversation_prompt_queue
           WHERE conversation_id IN (
             SELECT id FROM conversations WHERE node_id = ?
           )`,
        ).all(msg.nodeId) as Array<{ conversationId: string }>;
        for (const conversation of queuedConversationIds) {
          void manager.onConversationSettled(conversation.conversationId);
        }
        log.info(`[node-ws] registered: ${msg.nodeId} (${msg.hostname})`);
        break;
      }

      case 'node.heartbeat': {
        registry.heartbeat(msg.nodeId);
        break;
      }

      case 'run.accepted': {
        const accepted = manager.handleRunAccepted(msg.runId, msg.conversationId);
        if (!accepted) {
          log.debug('[node-ws] ignoring late run.accepted without pending waiter', {
            runId: msg.runId,
            conversationId: msg.conversationId,
          });
          break;
        }
        broadcast(msg.conversationId, {
          type: 'conversation.status',
          conversationId: msg.conversationId,
          status: 'active',
        });
        break;
      }

      case 'run.event': {
        log.debug('[node-ws] run.event', { conversationId: msg.conversationId, eventType: msg.event.type });
        if (msg.event.type === 'conversation.status') {
          db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
            .run(msg.event.status, Date.now(), msg.conversationId);
          broadcast(msg.conversationId, msg.event);
          break;
        }
        // Silently discard events for runs that no longer exist (deleted by reset/clear-chat)
        const runKnown = !!(db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(msg.runId));
        if (!runKnown) {
          log.debug('[node-ws] ignoring run.event for unknown/deleted run', { runId: msg.runId });
          break;
        }
        const broadcastEvent =
          msg.event.type === 'tool.call'
            ? { ...msg.event, startedAt: msg.event.startedAt ?? Date.now() }
            : msg.event.type === 'tool.result'
              ? { ...msg.event, endedAt: msg.event.endedAt ?? Date.now() }
              : msg.event;
        broadcast(msg.conversationId, broadcastEvent);
        // Persist replay-worthy events to core DB immediately
        if (REPLAY_EVENT_TYPES.has(msg.event.type)) {
          const seq = (runSeq.get(msg.runId) ?? 0) + 1;
          runSeq.set(msg.runId, seq);
          appendNodeEvent(db, msg.runId, seq, broadcastEvent);
        }
        break;
      }

      case 'run.end': {
        log.info('[node-ws] run.end', { runId: msg.runId, conversationId: msg.conversationId, error: msg.error ?? null });
        runSeq.delete(msg.runId);
        // Check if this run still exists in core's DB.
        // After reset/clear-chat the run rows are deleted — ignore stale run.end messages
        // so they don't overwrite the conversation status set by the reset operation.
        const runExists = !!(db
          .prepare('SELECT 1 FROM runs WHERE run_id = ?')
          .get(msg.runId));
        if (!runExists) {
          log.warn('[node-ws] ignoring run.end for unknown/deleted run', { runId: msg.runId });
          void manager.onConversationSettled(msg.conversationId);
          break;
        }
        const handedOff = isCancelStopReason(msg.stopReason) && wasRunHandedOff(db, msg.runId);
        const runEndError = getRunEndError(msg, db, msg.conversationId, msg.runId, handedOff);
        if (!msg.error && !isCancelStopReason(msg.stopReason)) {
          const fallbackCount = persistDeltaFallbackMessages({
            db,
            conversationId: msg.conversationId,
            runId: msg.runId,
            broadcast,
            manager,
          });
          if (fallbackCount > 0) {
            log.info('[node-ws] emitted delta fallback messages', {
              conversationId: msg.conversationId,
              runId: msg.runId,
              count: fallbackCount,
            });
          }
        }

        finishConversationRun({
          db,
          broadcast,
          manager,
          conversationId: msg.conversationId,
          runId: msg.runId,
          stopReason: handedOff ? 'handoff' : msg.stopReason,
          error: runEndError ?? undefined,
        });
        break;
      }

      case 'run.debug.snapshot': {
        applyRunDebugSnapshot(db, {
          runId: msg.runId,
          conversationId: msg.conversationId,
          sessionKey: msg.sessionKey,
          acpSessionId: msg.acpSessionId,
          isFreshSession: msg.isFreshSession,
          isExact: msg.isExact,
          effectiveSystemPromptText: msg.effectiveSystemPromptText,
          effectiveContextText: msg.effectiveContextText,
        });
        break;
      }

      case 'permission.request': {
        db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
          .run('awaiting_approval', Date.now(), msg.conversationId);
        broadcast(msg.conversationId, {
          type: 'conversation.status',
          conversationId: msg.conversationId,
          status: 'awaiting_approval',
        });
        broadcast(msg.conversationId, {
          type: 'approval.request',
          requestId: msg.requestId,
          toolName: msg.toolName,
          toolArgs: msg.toolArgs,
          toolKind: msg.toolKind,
        });
        break;
      }

      case 'workspace.list.response': {
        workspaceBroker?.handleWorkspaceListResponse(msg);
        break;
      }

      case 'workspace.read.response': {
        workspaceBroker?.handleWorkspaceReadResponse(msg);
        break;
      }

      case 'workspace.write.response': {
        workspaceBroker?.handleWorkspaceWriteResponse(msg);
        break;
      }

      case 'workspace.reset.response': {
        workspaceBroker?.handleWorkspaceResetResponse(msg);
        break;
      }

      case 'skills.list.response': {
        skillsBroker?.handleSkillsListResponse(msg);
        break;
      }

      case 'skills.read.response': {
        skillsBroker?.handleSkillsReadResponse(msg);
        break;
      }

      case 'codex.transcript.list.response': {
        codexTranscriptBroker?.handleListResponse(msg);
        break;
      }

      case 'codex.transcript.read.response': {
        codexTranscriptBroker?.handleReadResponse(msg);
        break;
      }

      case 'claude.transcript.list.response': {
        claudeTranscriptBroker?.handleListResponse(msg);
        break;
      }

      case 'claude.transcript.read.response': {
        claudeTranscriptBroker?.handleReadResponse(msg);
        break;
      }

      default: {
        log.warn('[node-ws] unknown message type', (msg as any).type);
      }
    }
  });

  socket.on('close', () => {
    if (nodeId) {
      const disconnectMessage = `Agent node disconnected: ${nodeId}`;
      workspaceBroker?.rejectPendingForNode(nodeId);
      skillsBroker?.rejectPendingForNode(nodeId);
      codexTranscriptBroker?.rejectPendingForNode(nodeId);
      claudeTranscriptBroker?.rejectPendingForNode(nodeId);
      manager.rejectPendingDispatchesForNode(nodeId, disconnectMessage);
      registry.unregister(nodeId);
      db.prepare(`UPDATE nodes SET status='offline', last_seen=? WHERE node_id=?`)
        .run(Date.now(), nodeId);
      const affected = db.prepare(
        `SELECT id FROM conversations WHERE node_id = ? AND status != 'idle'`
      ).all(nodeId) as Array<{ id: string }>;
      const openRuns = db.prepare(
        `SELECT r.run_id as runId, c.id as conversationId
         FROM runs r
         JOIN conversations c ON c.session_key = r.session_key
         WHERE c.node_id = ?
           AND r.ended_at IS NULL`,
      ).all(nodeId) as Array<{ runId: string; conversationId: string }>;
      for (const run of openRuns) {
        finishRun(db, { runId: run.runId, error: disconnectMessage });
        broadcast(run.conversationId, {
          type: 'turn.end',
          turnId: run.runId,
          stopReason: 'error',
          endedAt: Date.now(),
          error: disconnectMessage,
        });
      }
      db.prepare(`UPDATE conversations SET status='failed', updated_at=? WHERE node_id=? AND status != 'idle'`)
        .run(Date.now(), nodeId);
      for (const conv of affected) {
        broadcast(conv.id, {
          type: 'conversation.status',
          conversationId: conv.id,
          status: 'failed',
        });
        broadcast(conv.id, {
          type: 'error',
          message: disconnectMessage,
        });
      }
      log.info(`[node-ws] disconnected: ${nodeId}`);
    }
  });

  socket.on('error', (err) => {
    log.warn('[node-ws] socket error', err);
  });
}
