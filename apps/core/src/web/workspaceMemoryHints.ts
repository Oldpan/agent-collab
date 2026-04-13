import { channelMemoryNotePath } from './channelMemoryNotes.js';

export type ActivationReason = 'mention' | 'agent_mention' | 'thread_reply' | 'channel_activity';

type WorkspaceMemoryHintParams = {
  channelName?: string;
  includeChannelNote?: boolean;
  includeTaskNotes?: boolean;
  includeWorkLog?: boolean;
};

export function isThreadTarget(target: string): boolean {
  if (target.startsWith('dm:@')) {
    return target.split(':').length >= 3;
  }
  if (target.startsWith('#')) {
    return target.split(':').length >= 2;
  }
  return false;
}

export function buildWorkspaceMemoryHints(params: WorkspaceMemoryHintParams): string[] {
  const hints = ['MEMORY.md'];
  if (params.channelName && params.includeChannelNote !== false) {
    hints.push(channelMemoryNotePath(params.channelName));
  }
  if (params.includeTaskNotes) {
    hints.push('notes/tasks.md');
  }
  if (params.includeWorkLog) {
    hints.push('notes/work-log.md');
  }
  return Array.from(new Set(hints));
}

export function buildWorkspaceMemoryHintSection(memoryHints?: string[]): string {
  const hints = (memoryHints ?? []).map((hint) => hint.trim()).filter(Boolean);
  if (hints.length === 0) return '';
  return [
    '[Workspace memory to check first]',
    ...hints,
  ].join('\n');
}

export function buildWorkspaceMemoryReminder(memoryHints?: string[]): string {
  const hints = (memoryHints ?? []).map((hint) => hint.trim()).filter(Boolean);
  const summary = hints.length > 0 ? hints.join(', ') : 'MEMORY.md';
  return `This work spans multiple turns. Check workspace memory first (${summary}) before deeper history lookup.`;
}

export function combinePromptSections(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

export function shouldIncludeParticipantsInActivationContext(params: {
  target: string;
  participantsCount?: number;
  hasBoundTask?: boolean;
  reason?: ActivationReason;
}): boolean {
  if (params.hasBoundTask) return true;
  if (isThreadTarget(params.target)) return true;
  if (params.reason === 'agent_mention') return true;
  return (params.participantsCount ?? 0) > 1;
}

export function shouldIncludeOpenTaskBoardSummary(params: {
  target: string;
  hasBoundTask?: boolean;
}): boolean {
  return !params.hasBoundTask && !isThreadTarget(params.target);
}

export function shouldIncludeDmContextSnapshot(params: {
  target: string;
  includeRecoverySnapshot?: boolean;
}): boolean {
  return isThreadTarget(params.target) || Boolean(params.includeRecoverySnapshot);
}
