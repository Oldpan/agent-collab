import type {
  ActivationContextMessage,
  DmActiveTaskThreadSummary,
  DmThreadContextSnapshot,
} from './activationContext.js';
import { buildExactTargetHistoryContextText } from './channelActivationPrompt.js';
import { sanitizePromptHistoryContent } from './promptHistorySanitizer.js';

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
    const rootContent = sanitizePromptHistoryContent(params.rootMessage.content, params.rootMessage.senderType);
    if (rootContent) {
      sections.push(
        [
          '[Thread root message]',
          `@${params.rootMessage.senderName}${triggerTag}: ${rootContent}`,
        ].join('\n'),
      );
    }
  }

  const exactHistory = buildExactTargetHistoryContextText(params);
  if (exactHistory.trim()) {
    sections.push(exactHistory);
  }

  if (params.dmContextSnapshot?.messages.length) {
    const visibleDmMessages = params.dmContextSnapshot.messages
      .map((message) => {
        const content = sanitizePromptHistoryContent(message.content, message.senderType);
        return content
          ? { ...message, content }
          : null;
      })
      .filter((message): message is ActivationContextMessage => Boolean(message));
    if (visibleDmMessages.length) {
      sections.push(
        [
          '[Context from DM]',
          ...visibleDmMessages.map((message) => {
            const triggerTag = params.dmContextSnapshot?.triggerMessageId === message.messageId ? ' [Trigger]' : '';
            return `@${message.senderName}${triggerTag}: ${message.content}`;
          }),
        ].join('\n'),
      );
    }
  }

  if (params.dmActiveTaskThreads?.length) {
    sections.push(
      [
        '[Active DM task threads]',
        ...params.dmActiveTaskThreads.map((task) => {
          const assignee = task.claimedByName ? ` @${task.claimedByName}` : '';
          const identity = task.agentTaskRef ? `${task.agentTaskRef} · #${task.taskNumber}` : `#${task.taskNumber}`;
          return `${identity} [${task.status}]${assignee} -> ${task.threadTarget} — ${task.title}`;
        }),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
