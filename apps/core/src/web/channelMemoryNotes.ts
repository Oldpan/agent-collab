import { formatBeijingPromptTimestamp, type AgentInfo } from '@agent-collab/protocol';
import type { AgentWorkspaceBroker } from '../services/agentWorkspaceBroker.js';

type WorkspaceNoteWriter = Pick<AgentWorkspaceBroker, 'readFile' | 'writeFile'>;

const LEGACY_CHANNELS_NOTE_PATH = 'notes/channels.md';

export function slugifyChannelNoteName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'channel';
}

export function channelMemoryNotePath(channelName: string): string {
  return `notes/channels/${slugifyChannelNoteName(channelName)}.md`;
}

export function buildChannelResetMarker(channelName: string, clearedAt: number): string {
  return [
    '## History Reset',
    `- Live chat history for #${channelName} was cleared at ${formatBeijingPromptTimestamp(clearedAt)}.`,
    '- Treat older notes in this file as durable memory, not as the currently visible channel transcript.',
    '- If asked what is currently visible in the channel, rely on current chat history or read_history rather than older notes from before this reset.',
  ].join('\n');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildChannelNoteHeader(channelName: string): string {
  return [
    `# Channel: #${channelName}`,
    '',
    'Durable notes and reset markers for this channel.',
  ].join('\n');
}

function buildLegacyChannelsHeader(): string {
  return [
    '# Channel Summaries',
    '',
    'Durable summaries and reset markers for joined channels.',
  ].join('\n');
}

function buildLegacyResetEntry(channelName: string, clearedAt: number): string {
  return [
    `## #${channelName}`,
    `- Live chat history was cleared at ${formatBeijingPromptTimestamp(clearedAt)}.`,
    '- Earlier bullets in this file are durable summaries, not necessarily the currently visible transcript.',
  ].join('\n');
}

function isNotFoundError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return message.startsWith('not_found:');
}

function stripLeadingHeader(content: string, header: string): string {
  if (!content.startsWith(header)) return content.trim();
  return content.slice(header.length).trim();
}

function stripManagedChannelResetBlocks(content: string, channelName: string): string {
  const channelPattern = new RegExp(
    String.raw`\n*## History Reset\n- Live chat history for #${escapeRegex(channelName)} was cleared at [^\n]+\.\n- Treat older notes in this file as durable memory, not as the currently visible channel transcript\.\n- If asked what is currently visible in the channel, rely on current chat history or read_history rather than older notes from before this reset\.\n*`,
    'g',
  );
  return content.replace(channelPattern, '\n\n').trim();
}

function stripManagedLegacyResetBlocks(content: string, channelName: string): string {
  const legacyPattern = new RegExp(
    String.raw`\n*## #${escapeRegex(channelName)}\n- Live chat history was cleared at [^\n]+\.\n- Earlier bullets in this file are durable summaries, not necessarily the currently visible transcript\.\n*`,
    'g',
  );
  return content.replace(legacyPattern, '\n\n').trim();
}

function buildManagedNoteContent(params: {
  existingContent: string;
  header: string;
  marker: string;
  stripMarkers: (content: string) => string;
}): string {
  const { existingContent, header, marker, stripMarkers } = params;
  const withoutHeader = stripLeadingHeader(existingContent, header);
  const remaining = stripMarkers(withoutHeader);
  return remaining.length > 0 ? `${header}\n\n${marker}\n\n${remaining}\n` : `${header}\n\n${marker}\n`;
}

async function upsertMarkerFile(params: {
  broker: WorkspaceNoteWriter;
  agent: AgentInfo;
  relativePath: string;
  marker: string;
  header: string;
  stripMarkers: (content: string) => string;
}): Promise<void> {
  const { broker, agent, relativePath, marker, header, stripMarkers } = params;
  if (!agent.nodeId || !agent.workspacePath) return;

  try {
    const existing = await broker.readFile(agent.nodeId, agent.workspacePath, relativePath);
    await broker.writeFile(
      agent.nodeId,
      agent.workspacePath,
      relativePath,
      buildManagedNoteContent({
        existingContent: existing.content,
        header,
        marker,
        stripMarkers,
      }),
      'overwrite',
    );
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    await broker.writeFile(
      agent.nodeId,
      agent.workspacePath,
      relativePath,
      `${header}\n\n${marker}\n`,
      'overwrite',
    );
  }
}

export async function appendChannelResetMarkers(params: {
  broker: WorkspaceNoteWriter;
  agents: AgentInfo[];
  channelName: string;
  clearedAt: number;
}): Promise<void> {
  const { broker, agents, channelName, clearedAt } = params;
  const notePath = channelMemoryNotePath(channelName);
  const channelMarker = buildChannelResetMarker(channelName, clearedAt);
  const legacyMarker = buildLegacyResetEntry(channelName, clearedAt);

  for (const agent of agents) {
    if (!agent.nodeId || !agent.workspacePath) continue;
    await upsertMarkerFile({
      broker,
      agent,
      relativePath: notePath,
      marker: channelMarker,
      header: buildChannelNoteHeader(channelName),
      stripMarkers: (content) => stripManagedChannelResetBlocks(content, channelName),
    });
    await upsertMarkerFile({
      broker,
      agent,
      relativePath: LEGACY_CHANNELS_NOTE_PATH,
      marker: legacyMarker,
      header: buildLegacyChannelsHeader(),
      stripMarkers: (content) => stripManagedLegacyResetBlocks(content, channelName),
    });
  }
}
