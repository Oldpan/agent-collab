import type { Db } from '@agent-collab/runtime-acp';
import {
  buildThreadShortId,
  formatBeijingPromptTimestamp,
  type AgentInfo,
} from '@agent-collab/protocol';
import type { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';
import { channelMemoryNotePath } from './channelMemoryNotes.js';

type WorkspaceNoteWriter = Pick<AgentWorkspaceBroker, 'readFile' | 'writeFile'>;
type TaskMemoryAgent = Pick<AgentInfo, 'agentId' | 'name' | 'nodeId' | 'workspacePath'>;

type TaskMemorySnapshot = {
  taskId: string;
  taskRef: string;
  taskNumber: number;
  title: string;
  description: string | null;
  status: string;
  ownerName: string | null;
  channelId: string;
  channelName: string | null;
  messageId: string | null;
  messageTarget: string | null;
  targetLabel: string;
  updatedAt: number;
  latestResult: string | null;
  residualRisks: string;
};

const TASKS_NOTE_PATH = 'notes/tasks.md';
const WORK_LOG_PATH = 'notes/work-log.md';
const RECENT_DURABLE_OUTCOMES_START = '<!-- recent-durable-outcomes:start -->';
const RECENT_DURABLE_OUTCOMES_END = '<!-- recent-durable-outcomes:end -->';

function isNotFoundError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return message.startsWith('not_found:');
}

function normalizeInlineNoteText(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

function fallbackTaskRef(taskId: string): string {
  return `task_${taskId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 12) || 'unknown'}`;
}

function buildTasksNoteSection(snapshot: TaskMemorySnapshot): string {
  const lines = [
    `<!-- task:${snapshot.taskRef}:start -->`,
    `## ${snapshot.taskRef}`,
    `- task_ref: ${snapshot.taskRef}`,
    `- title: ${normalizeInlineNoteText(snapshot.title, 'Untitled task')}`,
    `- target: ${normalizeInlineNoteText(snapshot.targetLabel, snapshot.channelId)}`,
    `- owner: ${snapshot.ownerName ? `@${snapshot.ownerName}` : 'unassigned'}`,
    `- status: ${snapshot.status}`,
    `- goal / done criteria: ${normalizeInlineNoteText(snapshot.description, 'Not recorded.')}`,
    `- latest result: ${normalizeInlineNoteText(snapshot.latestResult, 'No durable result recorded yet.')}`,
    `- residual risks: ${normalizeInlineNoteText(snapshot.residualRisks, 'None recorded.')}`,
    `- last updated: ${formatBeijingPromptTimestamp(snapshot.updatedAt)}`,
    `<!-- task:${snapshot.taskRef}:end -->`,
  ];
  return lines.join('\n');
}

function buildWorkLogEntry(snapshot: TaskMemorySnapshot): string {
  return [
    `## ${formatBeijingPromptTimestamp(snapshot.updatedAt)} — ${snapshot.taskRef}`,
    `- target: ${normalizeInlineNoteText(snapshot.targetLabel, snapshot.channelId)}`,
    `- result: ${normalizeInlineNoteText(snapshot.latestResult, 'No durable result recorded yet.')}`,
    `- key decision: Task moved to ${snapshot.status}.`,
    `- risk / follow-up: ${normalizeInlineNoteText(snapshot.residualRisks, 'None recorded.')}`,
    '',
  ].join('\n');
}

function upsertManagedTaskSection(existingContent: string, snapshot: TaskMemorySnapshot): string {
  const header = '# Task Notes';
  const content = existingContent.trim();
  const body = content.startsWith(header)
    ? content.slice(header.length).trim()
    : content;
  const section = buildTasksNoteSection(snapshot);
  const pattern = new RegExp(
    `<!-- task:${escapeRegex(snapshot.taskRef)}:start -->[\\s\\S]*?<!-- task:${escapeRegex(snapshot.taskRef)}:end -->\\n*`,
    'g',
  );
  const remainder = body.replace(pattern, '').trim();
  const nextBody = [section, remainder].filter(Boolean).join('\n\n');
  return `${header}\n\nDurable summaries for task goals, latest outcomes, and residual risks.\n\n${nextBody}\n`;
}

function appendWorkLog(existingContent: string, snapshot: TaskMemorySnapshot): string {
  const header = '# Work Log';
  const content = existingContent.trim();
  const body = content.startsWith(header)
    ? content.slice(header.length).trim()
    : content;
  const entry = buildWorkLogEntry(snapshot).trimEnd();
  const nextBody = [body, entry].filter(Boolean).join('\n\n');
  return `${header}\n\nAppend important completed work, decisions, and follow-ups here.\n\n${nextBody}\n`;
}

function upsertChannelOutcomeSection(existingContent: string, channelName: string, snapshot: TaskMemorySnapshot): string {
  const header = [
    `# Channel: #${channelName}`,
    '',
    'Durable notes and reset markers for this channel.',
  ].join('\n');
  const content = existingContent.trim();
  const body = content.startsWith(header)
    ? content.slice(header.length).trim()
    : content;
  const managedPattern = new RegExp(
    `${escapeRegex(RECENT_DURABLE_OUTCOMES_START)}[\\s\\S]*?${escapeRegex(RECENT_DURABLE_OUTCOMES_END)}\\n*`,
    'g',
  );
  const remainder = body.replace(managedPattern, '').trim();
  const entry = `- ${formatBeijingPromptTimestamp(snapshot.updatedAt)} ${snapshot.taskRef} [${snapshot.status}] — ${normalizeInlineNoteText(snapshot.title, 'Untitled task')}`;
  const existingManaged = content.match(new RegExp(
    `${escapeRegex(RECENT_DURABLE_OUTCOMES_START)}([\\s\\S]*?)${escapeRegex(RECENT_DURABLE_OUTCOMES_END)}`,
  ));
  const priorLines = (existingManaged?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .filter((line) => !line.includes(`${snapshot.taskRef} [`));
  const managedLines = [
    '## Recent Durable Outcomes',
    RECENT_DURABLE_OUTCOMES_START,
    entry,
    ...priorLines.slice(0, 4),
    RECENT_DURABLE_OUTCOMES_END,
  ];
  const nextBody = [managedLines.join('\n'), remainder].filter(Boolean).join('\n\n');
  return `${header}\n\n${nextBody}\n`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readOptionalFile(
  broker: WorkspaceNoteWriter,
  agent: TaskMemoryAgent,
  relativePath: string,
): Promise<string> {
  if (!agent.nodeId || !agent.workspacePath) return '';
  try {
    const existing = await broker.readFile(agent.nodeId, agent.workspacePath, relativePath);
    return existing.content;
  } catch (error) {
    if (isNotFoundError(error)) return '';
    throw error;
  }
}

function loadTaskMemorySnapshot(db: Db, taskId: string): TaskMemorySnapshot | null {
  const row = db.prepare(
    `SELECT t.task_id as taskId,
            t.agent_task_ref as taskRef,
            t.task_number as taskNumber,
            t.title,
            t.description,
            t.status,
            t.claimed_by_name as ownerName,
            t.channel_id as channelId,
            t.updated_at as updatedAt,
            t.message_id as messageId,
            cm.target as messageTarget,
            c.name as channelName
     FROM tasks t
     LEFT JOIN channel_messages cm ON cm.message_id = t.message_id
     LEFT JOIN channels c ON c.channel_id = t.channel_id
     WHERE t.task_id = ?
     LIMIT 1`,
  ).get(taskId) as {
    taskId: string;
    taskRef: string | null;
    taskNumber: number;
    title: string;
    description: string | null;
    status: string;
    ownerName: string | null;
    channelId: string;
    updatedAt: number;
    messageId: string | null;
    messageTarget: string | null;
    channelName: string | null;
  } | undefined;
  if (!row) return null;

  const latestMessage = row.messageId
    ? db.prepare(
      `SELECT content
       FROM channel_messages
       WHERE channel_id = ?
         AND (message_id = ? OR thread_root_id = ?)
       ORDER BY seq DESC, created_at DESC
       LIMIT 1`,
    ).get(row.channelId, row.messageId, row.messageId) as { content: string } | undefined
    : undefined;
  const targetLabel = row.messageId && row.messageTarget
    ? `${row.messageTarget}:${buildThreadShortId(row.messageId)}`
    : row.messageTarget ?? (row.channelName ? `#${row.channelName}` : row.channelId);
  return {
    taskId: row.taskId,
    taskRef: row.taskRef ?? fallbackTaskRef(row.taskId),
    taskNumber: row.taskNumber,
    title: row.title,
    description: row.description,
    status: row.status,
    ownerName: row.ownerName,
    channelId: row.channelId,
    channelName: row.channelName,
    messageId: row.messageId,
    messageTarget: row.messageTarget,
    targetLabel,
    updatedAt: row.updatedAt,
    latestResult: latestMessage?.content?.trim() || null,
    residualRisks: row.status === 'in_review' ? 'Awaiting human review or approval.' : 'None recorded.',
  };
}

export async function syncTaskDurableNotesForAgent(params: {
  db: Db;
  broker: WorkspaceNoteWriter;
  agent: TaskMemoryAgent | null | undefined;
  taskId: string;
}): Promise<void> {
  const { db, broker, agent, taskId } = params;
  if (!agent?.nodeId || !agent.workspacePath) return;

  const snapshot = loadTaskMemorySnapshot(db, taskId);
  if (!snapshot) return;

  const tasksContent = await readOptionalFile(broker, agent, TASKS_NOTE_PATH);
  await broker.writeFile(
    agent.nodeId,
    agent.workspacePath,
    TASKS_NOTE_PATH,
    upsertManagedTaskSection(tasksContent, snapshot),
    'overwrite',
  );

  const workLogContent = await readOptionalFile(broker, agent, WORK_LOG_PATH);
  await broker.writeFile(
    agent.nodeId,
    agent.workspacePath,
    WORK_LOG_PATH,
    appendWorkLog(workLogContent, snapshot),
    'overwrite',
  );

  if (snapshot.channelName && !snapshot.channelId.startsWith('dm:')) {
    const channelNotePath = channelMemoryNotePath(snapshot.channelName);
    const channelContent = await readOptionalFile(broker, agent, channelNotePath);
    await broker.writeFile(
      agent.nodeId,
      agent.workspacePath,
      channelNotePath,
      upsertChannelOutcomeSection(channelContent, snapshot.channelName, snapshot),
      'overwrite',
    );
  }
}
