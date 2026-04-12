import type { ActivationContextMessage } from './activationContext.js';
import type { TargetParticipant } from './targetParticipants.js';
import { sanitizePromptHistoryContent } from './promptHistorySanitizer.js';

const MESSAGE_SEPARATOR = '\n\n---\n\n';

type ChannelActivationPromptParams = {
  channelName: string;
  target: string;
  replyTarget?: string;
  senderName: string;
  content: string;
  reason: 'mention' | 'agent_mention' | 'thread_reply' | 'channel_activity';
};

type ChannelActivationContextParams = {
  target: string;
  recentMessages?: ActivationContextMessage[];
  rootMessage?: ActivationContextMessage;
  unreadCount?: number;
  oldestVisibleSeq?: number;
  participants?: TargetParticipant[];
  boundTask?: {
    taskNumber: number;
    title: string;
    description?: string | null;
    status: string;
    claimedByName: string | null;
  };
  openTasks?: Array<{ taskNumber: number; title: string; status: string; claimedByName: string | null }>;
};

type ExactTargetHistoryContextParams = {
  target: string;
  recentMessages?: ActivationContextMessage[];
  unreadCount?: number;
  oldestVisibleSeq?: number;
};

export function buildChannelActivationPrompt(params: ChannelActivationPromptParams): string {
  const reasonText = params.reason === 'mention'
    ? `You were @mentioned in #${params.channelName} by ${params.senderName}.`
    : params.reason === 'agent_mention'
      ? `Another agent (@${params.senderName}) explicitly asked for your help in #${params.channelName}.`
    : params.reason === 'thread_reply'
      ? `Your collaborative thread in #${params.channelName} received a reply from ${params.senderName}.`
      : `There is new channel activity in #${params.channelName} from ${params.senderName}.`;

  const replyTarget = params.replyTarget ?? params.target;
  const lines = [
    `[System: ${reasonText}]`,
    '',
    '[Current conversation target]',
    `reply_target: ${replyTarget}`,
    '',
    '[Triggered message metadata]',
    `target: ${params.target}`,
    `sender: @${params.senderName}`,
    '',
    '[Triggered message body]',
    params.content,
  ];

  return lines.join('\n');
}

/**
 * Builds the activation context text (recent messages, thread root, unread summary) to be
 * injected as part of contextText — only on fresh ACP sessions, not on every turn.
 * Returns an empty string if there is nothing to include.
 */
export function buildChannelActivationContextText(params: ChannelActivationContextParams): string {
  const parts: string[] = [];

  if (params.rootMessage) {
    parts.push(`[Thread root message]\n${formatPromptMessage(params.rootMessage)}`);
  }

  const historyContextText = buildExactTargetHistoryContextText(params);
  if (historyContextText) parts.push(historyContextText);

  if (params.participants && params.participants.length > 0) {
    parts.push(
      `[Active participants on this target]\n${params.participants.map((participant) => {
        const role = participant.role === 'owner' ? 'owner' : 'participant';
        return `@${participant.name} (${role})`;
      }).join('\n')}`,
    );
  }

  if (params.boundTask) {
    const assignee = params.boundTask.claimedByName ? ` @${params.boundTask.claimedByName}` : ' unassigned';
    const brief = params.boundTask.description?.trim()
      ? `\nTask brief / goal / done criteria:\n${params.boundTask.description.trim()}`
      : '\nTask brief / goal / done criteria: missing';
    parts.push(
      `[Bound task-message for this thread]\n#${params.boundTask.taskNumber} [${params.boundTask.status}]${assignee} — ${params.boundTask.title}${brief}\nThis thread is the shared work surface for that task-message. If you are not the owner/assignee, default to coordination and discussion unless you explicitly claim or are asked to take over. If you already own this task, do not claim it again in this thread. Send one substantive result, then move it to in_review unless the work is trivial or explicitly approved for done. Do not append a second completion-summary message after the substantive result.`,
    );
  }

  if (params.openTasks && params.openTasks.length > 0) {
    parts.push(
      `[Task-message board summary]\n${params.openTasks.map((task) => {
        const assignee = task.claimedByName ? ` @${task.claimedByName}` : ' unassigned';
        return `#${task.taskNumber} [${task.status}]${assignee} — ${task.title}`;
      }).join('\n')}`,
    );
  }

  return parts.join('\n\n');
}

export function buildExactTargetHistoryContextText(params: ExactTargetHistoryContextParams): string {
  const parts: string[] = [];
  const visibleRecentMessages = (params.recentMessages ?? [])
    .map((message) => {
      const content = sanitizePromptHistoryContent(message.content, message.senderType);
      return content
        ? { ...message, content }
        : null;
    })
    .filter((message): message is ActivationContextMessage => Boolean(message));

  if (visibleRecentMessages.length > 0) {
    parts.push(
      `[Recent messages on this exact target]\n${visibleRecentMessages.map(formatPromptMessage).join(MESSAGE_SEPARATOR)}`,
    );
  }

  if (params.oldestVisibleSeq != null) {
    parts.push(`[History cursor]\noldest_visible_seq: ${params.oldestVisibleSeq}`);
  }

  if ((params.unreadCount ?? 0) > 0) {
    const label = params.unreadCount === 1 ? '1 older unread message' : `${params.unreadCount} older unread messages`;
    const readHint = params.oldestVisibleSeq != null
      ? ` Use read_history(channel="${params.target}", before=${params.oldestVisibleSeq}) if you need them.`
      : ` Use read_history(channel="${params.target}") if you need them.`;
    parts.push(
      `[Unread summary]\n${label} on this exact target were not included above.${readHint}`,
    );
  }

  return parts.join('\n\n');
}

export function buildAttachmentReferenceContextText(attachmentIds?: string[]): string {
  if (!attachmentIds?.length) return '';
  return [
    `[Message attachment${attachmentIds.length > 1 ? 's' : ''}]`,
    ...attachmentIds.map((attachmentId) => `attachment_id: ${attachmentId}`),
    `Use view_file(attachment_id="<one of the IDs above>") to inspect the attached image${attachmentIds.length > 1 ? 's' : ''}.`,
  ].join('\n');
}

function formatPromptMessage(message: ActivationContextMessage): string {
  const visibleContent = sanitizePromptHistoryContent(message.content, message.senderType);
  const firstLine = [
    `target: ${message.target}`,
    `seq: ${message.seq}`,
  ].join('  ');
  const secondLineParts = [
    `time: ${new Date(message.createdAt).toISOString()}`,
    `sender: @${message.senderName}`,
  ];
  if (message.senderType === 'agent') secondLineParts.push('sender_type: agent');
  const parts = [
    '[Message metadata]',
    firstLine,
    secondLineParts.join('  '),
    '',
    '[Message body]',
    visibleContent,
  ];
  const attachmentContext = buildAttachmentReferenceContextText(message.attachmentIds);
  if (attachmentContext) {
    parts.push('', attachmentContext);
  }
  return parts.join('\n');
}
