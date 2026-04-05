import type { Db } from '../db/db.js';

export function buildReplayContextFromRecentRuns(
  db: Db,
  params: {
    sessionKey: string;
    excludeRunId: string;
    maxRuns: number;
    maxChars: number;
  },
): string {
  const runs = db
    .prepare(
      `
      SELECT run_id as runId,
             prompt_text as promptText,
             stop_reason as stopReason,
             error,
             started_at as startedAt
        FROM runs
       WHERE session_key = ? AND run_id != ?
       ORDER BY started_at DESC
       LIMIT ?
      `,
    )
    .all(params.sessionKey, params.excludeRunId, params.maxRuns) as Array<{
    runId: string;
    promptText: string;
    stopReason: string | null;
    error: string | null;
    startedAt: number;
  }>;

  const chronological = runs.slice().reverse();
  const assistantLabel = getSessionAssistantLabel(db, params.sessionKey) ?? 'Assistant';

  const blocks: string[] = [];

  for (const run of chronological) {
    const rows = db
      .prepare(
        'SELECT payload_json as payloadJson FROM events WHERE run_id = ? AND method = ? ORDER BY seq ASC',
      )
      .all(run.runId, 'session/update') as Array<{ payloadJson: string }>;

    let assistantText = '';
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payloadJson);
        const update = payload?.update;
        if (update?.sessionUpdate !== 'agent_message_chunk') continue;
        assistantText += update?.content?.text ?? '';
      } catch {
        // ignore malformed rows
      }
    }

    const assistantLine = assistantText.trim()
      ? assistantText.trim()
      : run.error
        ? `[error] ${run.error}`
        : run.stopReason
          ? `[stop_reason] ${run.stopReason}`
          : '';

    const normalizedUserText = normalizeReplayUserText(run.promptText);
    if (normalizedUserText) {
      blocks.push(`User: ${normalizedUserText}`);
    }
    if (assistantLine) blocks.push(`${assistantLabel}: ${assistantLine}`);
  }

  const raw = blocks.join('\n');
  if (!raw.trim()) return '';

  const header =
    'Context (previous messages, for continuity after restart/GC):\n';
  const full = header + raw;

  if (full.length <= params.maxChars) return full;
  return header + raw.slice(Math.max(0, raw.length - params.maxChars));
}

function stripReplyContract(promptText: string): string {
  if (!promptText.startsWith('[Reply contract]')) return promptText;
  const splitIndex = promptText.indexOf('\n\n');
  return splitIndex >= 0 ? promptText.slice(splitIndex + 2) : promptText;
}

function extractTriggeredMessageBody(promptText: string): string | null {
  const marker = '[Triggered message body]\n';
  const start = promptText.indexOf(marker);
  if (start < 0) return null;
  return promptText.slice(start + marker.length).trim() || null;
}

function normalizeReplayUserText(promptText: string): string {
  const stripped = stripReplyContract(promptText).trim();
  return extractTriggeredMessageBody(stripped) ?? stripped;
}

function getSessionAssistantLabel(db: Db, sessionKey: string): string | null {
  const row = db.prepare(
    'SELECT system_prompt_text as systemPromptText FROM sessions WHERE session_key = ?',
  ).get(sessionKey) as { systemPromptText: string | null } | undefined;
  const promptText = row?.systemPromptText?.trim();
  if (!promptText) return null;
  const match = /You are "([^"]+)"/.exec(promptText);
  return match?.[1]?.trim() || null;
}
