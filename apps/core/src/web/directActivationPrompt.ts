import type {
  ActivationContextMessage,
  DmActiveTaskThreadSummary,
  DmThreadContextSnapshot,
} from './activationContext.js';
import { buildExactTargetHistoryContextText } from './channelActivationPrompt.js';

type DirectActivationPromptParams = {
  agentName: string;
  senderName: string;
  content: string;
  replyTarget?: string;
};

type DirectActivationContextParams = {
  target: string;
  recentMessages?: ActivationContextMessage[];
  unreadCount?: number;
  oldestVisibleSeq?: number;
  rootMessage?: ActivationContextMessage;
  dmContextSnapshot?: DmThreadContextSnapshot;
  dmActiveTaskThreads?: DmActiveTaskThreadSummary[];
};

export function buildDirectActivationPrompt(params: DirectActivationPromptParams): string {
  const replyTarget = params.replyTarget ?? `dm:@${params.senderName}`;
  const lines = [
    `[System: ${params.senderName} sent you a direct message.]`,
    '',
    '[Current conversation target]',
    `reply_target: ${replyTarget}`,
    '',
  ];

  lines.push(
    '[Triggered message metadata]',
    `recipient: @${params.agentName}`,
    `sender: @${params.senderName}`,
    '',
    '[Triggered message body]',
    params.content,
  );

  return lines.join('\n');
}

export function buildDirectActivationContextText(params: DirectActivationContextParams): string {
  const sections: string[] = [];
  if (params.rootMessage) {
    const triggerTag = params.dmContextSnapshot?.triggerMessageId === params.rootMessage.messageId ? ' [Trigger]' : '';
    sections.push(
      [
        '[Thread root message]',
        `@${params.rootMessage.senderName}${triggerTag}: ${params.rootMessage.content}`,
      ].join('\n'),
    );
  }

  const exactHistory = buildExactTargetHistoryContextText(params);
  if (exactHistory.trim()) {
    sections.push(exactHistory);
  }

  if (params.dmContextSnapshot?.messages.length) {
    sections.push(
      [
        '[Context from DM]',
        ...params.dmContextSnapshot.messages.map((message) => {
          const triggerTag = params.dmContextSnapshot?.triggerMessageId === message.messageId ? ' [Trigger]' : '';
          return `@${message.senderName}${triggerTag}: ${message.content}`;
        }),
      ].join('\n'),
    );
  }

  if (params.dmActiveTaskThreads?.length) {
    sections.push(
      [
        '[Active DM task threads]',
        ...params.dmActiveTaskThreads.map((task) => {
          const assignee = task.claimedByName ? ` @${task.claimedByName}` : '';
          return `#${task.taskNumber} [${task.status}]${assignee} -> ${task.threadTarget} — ${task.title}`;
        }),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
