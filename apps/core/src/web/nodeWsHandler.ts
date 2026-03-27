import type { WebSocket } from 'ws';
import type { NodeToCore, ServerEvent, ConversationStatus } from '@agent-collab/protocol';
import { log, finishRun } from '@agent-collab/runtime-acp';
import type { Db } from '@agent-collab/runtime-acp';
import type { NodeRegistry } from '../services/nodeRegistry.js';
import type { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import type { ConversationManager } from './conversationManager.js';

/** Persist a ServerEvent from a remote run into core DB as a node/event entry */
function appendNodeEvent(db: Db, runId: string, seq: number, event: ServerEvent): void {
  db.prepare(
    'INSERT OR IGNORE INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
  ).run(runId, seq, 'node/event', JSON.stringify(event), Date.now());
}

/** Event types worth persisting for history replay */
const REPLAY_EVENT_TYPES = new Set(['content.delta', 'tool.call', 'tool.result', 'thinking.delta']);

type EventBroadcaster = (conversationId: string, event: ServerEvent) => void;
type PendingRepair = { sourceRunId: string; repairRunId?: string };

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

type ReplyOutputAnalysis = {
  hasSubstantiveOutput: boolean;
  duplicatesLastReply: boolean;
  textAfterReply: string;
};

function normalizeReplyText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripInternalReminderTail(text: string): string {
  return text
    .replace(/\(?System reminder acknowledged[\s\S]*$/i, '')
    .trim();
}

function analyzeOutputAfterLastReply(db: Db, runId: string): ReplyOutputAnalysis {
  const replyRows = db
    .prepare(
      `SELECT content, created_at, message_kind
       FROM channel_messages
       WHERE run_id = ?
         AND sender_type = 'agent'`,
  ).all(runId) as Array<{ content: string; created_at: number; message_kind: string | null }>;
  if (replyRows.length === 0) {
    return { hasSubstantiveOutput: false, duplicatesLastReply: false, textAfterReply: '' };
  }

  const lastReply = replyRows.reduce((latest, row) => (row.created_at > latest.created_at ? row : latest));
  return analyzeOutputAfterTimestamp(db, runId, lastReply.created_at, lastReply.content ?? '', lastReply.message_kind);
}

function analyzeOutputAfterLastFinal(db: Db, runId: string): ReplyOutputAnalysis {
  const finalRows = db.prepare(
    `SELECT content, created_at, message_kind
     FROM channel_messages
     WHERE run_id = ?
       AND sender_type = 'agent'
       AND message_kind = 'final'
     ORDER BY created_at DESC
     LIMIT 1`,
  ).all(runId) as Array<{ content: string; created_at: number; message_kind: string | null }>;
  const lastFinal = finalRows[0];
  if (!lastFinal) {
    return { hasSubstantiveOutput: false, duplicatesLastReply: false, textAfterReply: '' };
  }
  return analyzeOutputAfterTimestamp(db, runId, lastFinal.created_at, lastFinal.content ?? '', lastFinal.message_kind);
}

function analyzeOutputAfterTimestamp(
  db: Db,
  runId: string,
  createdAfter: number,
  replyContent: string,
  replyKind: string | null,
): ReplyOutputAnalysis {
  const rows = db
    .prepare(
      `SELECT payload_json as payloadJson
       FROM events
       WHERE run_id = ?
         AND method = 'node/event'
         AND created_at > ?
       ORDER BY seq ASC`,
    ).all(runId, createdAfter) as Array<{ payloadJson: string }>;

  let textAfterReply = '';
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payloadJson) as { type?: string; text?: string };
      if (payload.type === 'content.delta' && typeof payload.text === 'string') {
        textAfterReply += payload.text;
      }
    } catch {
      // Ignore malformed historic payloads
    }
  }

  const normalizedOutput = stripInternalReminderTail(normalizeReplyText(textAfterReply));
  if (normalizedOutput.length < 32) {
    return { hasSubstantiveOutput: false, duplicatesLastReply: false, textAfterReply: normalizedOutput };
  }

  const normalizedLastReply = normalizeReplyText(replyContent);
  const duplicatesLastReply =
    !!normalizedLastReply &&
    (normalizedOutput === normalizedLastReply ||
      normalizedOutput.includes(normalizedLastReply) ||
      normalizedLastReply.includes(normalizedOutput));

  return {
    hasSubstantiveOutput: true,
    duplicatesLastReply,
    textAfterReply: normalizedOutput,
  };
}

function getReplyContractError(
  msg: { stopReason?: string; error?: string },
  db: Db,
  conversationId: string,
  runId: string,
): string | null {
  if (msg.error) return null;
  if (isCancelStopReason(msg.stopReason)) return null;
  if (!requiresMcpReplyContract(db, conversationId)) return null;
  if (!hasRunReplyMessage(db, conversationId, runId)) {
    return 'Agent did not reply via send_message';
  }
  if (hasRunFinalReplyMessage(db, runId)) {
    return null;
  }
  const outputAnalysis = analyzeOutputAfterLastReply(db, runId);
  if (outputAnalysis.hasSubstantiveOutput && !(outputAnalysis.duplicatesLastReply && !hasRunFinalReplyMessage(db, runId))) {
    return 'Agent did not send a final reply via send_message';
  }
  return null;
}

function shouldRepairTrailingDeltaAfterFinal(
  msg: { stopReason?: string; error?: string },
  db: Db,
  conversationId: string,
  runId: string,
): boolean {
  if (msg.error) return false;
  if (isCancelStopReason(msg.stopReason)) return false;
  if (!requiresMcpReplyContract(db, conversationId)) return false;
  if (!hasRunFinalReplyMessage(db, runId)) return false;

  const outputAnalysis = analyzeOutputAfterLastFinal(db, runId);
  return outputAnalysis.hasSubstantiveOutput && !outputAnalysis.duplicatesLastReply;
}

function getRunEndError(
  msg: { stopReason?: string; error?: string },
  db: Db,
  conversationId: string,
  runId: string,
): string | null {
  if (msg.error) return msg.error;
  if (isCancelStopReason(msg.stopReason)) {
    if (hasRunFinalReplyMessage(db, runId)) return null;
    if (requiresMcpReplyContract(db, conversationId)) {
      return 'Agent run was cancelled before sending a final reply';
    }
    return 'Run cancelled before completion';
  }
  return getReplyContractError(msg, db, conversationId, runId);
}

function collectRunOutputText(db: Db, runId: string, createdAfter?: number): string {
  const rows = db.prepare(
    `SELECT payload_json as payloadJson
     FROM events
     WHERE run_id = ?
       AND method = 'node/event'
       AND (? IS NULL OR created_at > ?)
     ORDER BY seq ASC`,
  ).all(runId, createdAfter ?? null, createdAfter ?? null) as Array<{ payloadJson: string }>;

  let text = '';
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payloadJson) as { type?: string; text?: string };
      if (payload.type === 'content.delta' && typeof payload.text === 'string') {
        text += payload.text;
      }
    } catch {
      // Ignore malformed historic payloads
    }
  }
  return stripInternalReminderTail(normalizeReplyText(text));
}

function buildReplyRepairPrompt(
  db: Db,
  runId: string,
  replyContractError: string,
): string | null {
  const replyRows = db.prepare(
    `SELECT content, created_at
     FROM channel_messages
     WHERE run_id = ?
       AND sender_type = 'agent'
     ORDER BY created_at DESC`,
  ).all(runId) as Array<{ content: string; created_at: number }>;

  const lastReply = replyRows[0];
  const draftText = lastReply
    ? collectRunOutputText(db, runId, lastReply.created_at)
    : collectRunOutputText(db, runId);
  if (!draftText) return null;

  return [
    '[System: Repair the previous run\'s reply contract violation.]',
    `The previous run ended with: ${replyContractError}`,
    'Send exactly one final user-visible reply for the current conversation via mcp__chat__send_message(content="...", kind="final").',
    'Do not do any new work. Do not call check_messages. Do not send progress updates. Do not mention this repair step.',
    '',
    '[Draft reply to send]',
    draftText,
  ].join('\n');
}

function buildTrailingFinalRepairPrompt(db: Db, runId: string): string | null {
  const finalRow = db.prepare(
    `SELECT content, created_at
     FROM channel_messages
     WHERE run_id = ?
       AND sender_type = 'agent'
       AND message_kind = 'final'
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(runId) as { content: string; created_at: number } | undefined;
  if (!finalRow) return null;

  const trailingOutput = collectRunOutputText(db, runId, finalRow.created_at);
  if (!trailingOutput || trailingOutput.length < 32) return null;

  return [
    '[System: Repair the previous run\'s final reply with the additional trailing output.]',
    'The previous run already sent a final reply, but then continued outputting more user-visible text.',
    'Send exactly one updated final user-visible reply for the current conversation via mcp__chat__send_message(content="...", kind="final").',
    'Use only the trailing output below as the content to send. Do not do any new work. Do not call check_messages. Do not send progress updates. Do not mention this repair step.',
    '',
    '[Trailing output to send]',
    trailingOutput,
  ].join('\n');
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
  void params.manager.onConversationSettled(params.conversationId);
}

export function handleNodeWebSocket(
  socket: WebSocket,
  registry: NodeRegistry,
  broadcast: EventBroadcaster,
  db: Db,
  manager: ConversationManager,
  workspaceBroker?: AgentWorkspaceBroker,
): void {
  let nodeId: string | null = null;
  // Sequence counter per runId for node/event persistence
  const runSeq = new Map<string, number>();
  const pendingRepairs = new Map<string, PendingRepair>();

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

        const existing = db.prepare('SELECT node_id, status FROM nodes WHERE node_id = ?').get(msg.nodeId) as { node_id: string; status: string } | undefined;
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
          db.prepare(
            `INSERT INTO nodes(node_id, hostname, agent_types_json, version, status, last_seen, created_at, provisioned_at, display_name, env_var_keys)
             VALUES(?,?,?,?,'online',?,?,0,NULL,'[]')`
          ).run(msg.nodeId, msg.hostname, agentTypesJson, msg.version, now, now);
        }

        socket.send(JSON.stringify({ type: 'node.ack', nodeId: msg.nodeId }));
        log.info(`[node-ws] registered: ${msg.nodeId} (${msg.hostname})`);
        break;
      }

      case 'node.heartbeat': {
        registry.heartbeat(msg.nodeId);
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
        const replyContractError = getReplyContractError(msg, db, msg.conversationId, msg.runId);
        const runEndError = getRunEndError(msg, db, msg.conversationId, msg.runId);
        const trailingFinalNeedsRepair = shouldRepairTrailingDeltaAfterFinal(msg, db, msg.conversationId, msg.runId);
        const pendingRepair = pendingRepairs.get(msg.conversationId);
        const isRepairRun = Boolean(pendingRepair && pendingRepair.sourceRunId !== msg.runId);

        if (!msg.error && !isCancelStopReason(msg.stopReason) && replyContractError && !isRepairRun) {
          const repairPrompt = buildReplyRepairPrompt(db, msg.runId, replyContractError);
          if (repairPrompt) {
            log.info('[node-ws] scheduling reply-contract repair run', {
              conversationId: msg.conversationId,
              sourceRunId: msg.runId,
              replyContractError,
            });
            const endedAt = Date.now();
            finishRun(db, { runId: msg.runId, stopReason: msg.stopReason ?? 'end_turn' });
            broadcast(msg.conversationId, {
              type: 'turn.end',
              turnId: msg.runId,
              stopReason: msg.stopReason ?? 'end_turn',
              endedAt,
            });
            updateConversationStatus(db, broadcast, msg.conversationId, 'recovering');
            pendingRepairs.set(msg.conversationId, { sourceRunId: msg.runId });
            void manager.submitPrompt(msg.conversationId, repairPrompt, { recordAsUserMessage: false })
              .then((result) => {
                const state = pendingRepairs.get(msg.conversationId);
                if (!state || state.sourceRunId !== msg.runId) return;
                if (result.runId) {
                  log.info('[node-ws] reply-contract repair dispatched', {
                    conversationId: msg.conversationId,
                    sourceRunId: msg.runId,
                    repairRunId: result.runId,
                    queued: result.queued,
                  });
                  pendingRepairs.set(msg.conversationId, { ...state, repairRunId: result.runId });
                }
                if (result.queued) {
                  updateConversationStatus(db, broadcast, msg.conversationId, 'queued');
                }
              })
              .catch((error: any) => {
                const state = pendingRepairs.get(msg.conversationId);
                if (!state || state.sourceRunId !== msg.runId) return;
                log.warn('[node-ws] reply-contract repair failed to dispatch', {
                  conversationId: msg.conversationId,
                  sourceRunId: msg.runId,
                  error: String(error?.message ?? error),
                });
                pendingRepairs.delete(msg.conversationId);
                updateConversationStatus(db, broadcast, msg.conversationId, 'failed');
                broadcast(msg.conversationId, {
                  type: 'error',
                  message: String(error?.message ?? replyContractError),
                });
                void manager.onConversationSettled(msg.conversationId);
              });
            break;
          }
        }

        if (!msg.error && !isCancelStopReason(msg.stopReason) && !replyContractError && trailingFinalNeedsRepair && !isRepairRun) {
          const repairPrompt = buildTrailingFinalRepairPrompt(db, msg.runId);
          if (repairPrompt) {
            log.info('[node-ws] scheduling trailing-final repair run', {
              conversationId: msg.conversationId,
              sourceRunId: msg.runId,
            });
            const endedAt = Date.now();
            finishRun(db, { runId: msg.runId, stopReason: msg.stopReason ?? 'end_turn' });
            broadcast(msg.conversationId, {
              type: 'turn.end',
              turnId: msg.runId,
              stopReason: msg.stopReason ?? 'end_turn',
              endedAt,
            });
            updateConversationStatus(db, broadcast, msg.conversationId, 'recovering');
            pendingRepairs.set(msg.conversationId, { sourceRunId: msg.runId });
            void manager.submitPrompt(msg.conversationId, repairPrompt, { recordAsUserMessage: false })
              .then((result) => {
                const state = pendingRepairs.get(msg.conversationId);
                if (!state || state.sourceRunId !== msg.runId) return;
                if (result.runId) {
                  log.info('[node-ws] trailing-final repair dispatched', {
                    conversationId: msg.conversationId,
                    sourceRunId: msg.runId,
                    repairRunId: result.runId,
                    queued: result.queued,
                  });
                  pendingRepairs.set(msg.conversationId, { ...state, repairRunId: result.runId });
                }
                if (result.queued) {
                  updateConversationStatus(db, broadcast, msg.conversationId, 'queued');
                }
              })
              .catch((error: any) => {
                const state = pendingRepairs.get(msg.conversationId);
                if (!state || state.sourceRunId !== msg.runId) return;
                log.warn('[node-ws] trailing-final repair failed to dispatch', {
                  conversationId: msg.conversationId,
                  sourceRunId: msg.runId,
                  error: String(error?.message ?? error),
                });
                pendingRepairs.delete(msg.conversationId);
                updateConversationStatus(db, broadcast, msg.conversationId, 'failed');
                broadcast(msg.conversationId, {
                  type: 'error',
                  message: String(error?.message ?? 'Agent final reply was stale and repair dispatch failed'),
                });
                void manager.onConversationSettled(msg.conversationId);
              });
            break;
          }
        }

        if (pendingRepair && (!pendingRepair.repairRunId || pendingRepair.repairRunId === msg.runId || isRepairRun)) {
          pendingRepairs.delete(msg.conversationId);
        }

        finishConversationRun({
          db,
          broadcast,
          manager,
          conversationId: msg.conversationId,
          runId: msg.runId,
          stopReason: msg.stopReason,
          error: runEndError ?? undefined,
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

      default: {
        log.warn('[node-ws] unknown message type', (msg as any).type);
      }
    }
  });

  socket.on('close', () => {
    if (nodeId) {
      workspaceBroker?.rejectPendingForNode(nodeId);
      registry.unregister(nodeId);
      manager.clearQueuedPromptsForNode(nodeId);
      db.prepare(`UPDATE nodes SET status='offline', last_seen=? WHERE node_id=?`)
        .run(Date.now(), nodeId);
      const affected = db.prepare(
        `SELECT id FROM conversations WHERE node_id = ? AND status != 'idle'`
      ).all(nodeId) as Array<{ id: string }>;
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
          message: `Agent node disconnected: ${nodeId}`,
        });
      }
      log.info(`[node-ws] disconnected: ${nodeId}`);
    }
  });

  socket.on('error', (err) => {
    log.warn('[node-ws] socket error', err);
  });
}
