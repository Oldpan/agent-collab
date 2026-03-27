import type { AgentInfo } from '@agent-collab/protocol';
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
    `- Live chat history for #${channelName} was cleared at ${new Date(clearedAt).toISOString()}.`,
    '- Treat older notes in this file as durable memory, not as the currently visible channel transcript.',
    '- If asked what is currently visible in the channel, rely on current chat history or read_history rather than older notes from before this reset.',
  ].join('\n');
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
    `- Live chat history was cleared at ${new Date(clearedAt).toISOString()}.`,
    '- Earlier bullets in this file are durable summaries, not necessarily the currently visible transcript.',
  ].join('\n');
}

function isNotFoundError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return message.startsWith('not_found:');
}

async function appendMarkerFile(params: {
  broker: WorkspaceNoteWriter;
  agent: AgentInfo;
  relativePath: string;
  marker: string;
  header: string;
}): Promise<void> {
  const { broker, agent, relativePath, marker, header } = params;
  if (!agent.nodeId || !agent.workspacePath) return;

  try {
    const existing = await broker.readFile(agent.nodeId, agent.workspacePath, relativePath);
    const separator = existing.content.trim().length > 0 ? '\n\n' : '';
    await broker.writeFile(
      agent.nodeId,
      agent.workspacePath,
      relativePath,
      `${separator}${marker}\n`,
      'append',
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
    await appendMarkerFile({
      broker,
      agent,
      relativePath: notePath,
      marker: channelMarker,
      header: buildChannelNoteHeader(channelName),
    });
    await appendMarkerFile({
      broker,
      agent,
      relativePath: LEGACY_CHANNELS_NOTE_PATH,
      marker: legacyMarker,
      header: buildLegacyChannelsHeader(),
    });
  }
}
