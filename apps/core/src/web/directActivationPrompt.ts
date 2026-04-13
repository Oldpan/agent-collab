import type {
  ActivationContextMessage,
  DmActiveTaskThreadSummary,
  DmThreadContextSnapshot,
} from './activationContext.js';
import { buildAttachmentReferenceContextText, buildExactTargetHistoryContextText } from './channelActivationPrompt.js';
import { sanitizePromptHistoryContent } from './promptHistorySanitizer.js';
import { buildWorkspaceMemoryHintSection } from './workspaceMemoryHints.js';

type DirectActivationPromptParams = {
  agentName: string;
  senderName: string;
  content: string;
  replyTarget?: string;
  memoryHints?: string[];
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

type DirectActivationContextOptions = {
  includeDmContextSnapshot?: boolean;
};

export function buildDirectActivationPrompt(params: DirectActivationPromptParams): string {
  const replyTarget = params.replyTarget ?? `dm:@${params.senderName}`;
  const memoryHintSection = buildWorkspaceMemoryHintSection(params.memoryHints);
  const lines = [
    `[System: ${params.senderName} sent you a direct message.]`,
    '',
    '[Current conversation target]',
    `reply_target: ${replyTarget}`,
    '',
    ...(memoryHintSection ? [memoryHintSection, ''] : []),
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

export function buildDirectActivationContextText(
  params: DirectActivationContextParams,
  options?: DirectActivationContextOptions,
): string {
  const sections: string[] = [];
  if (params.rootMessage) {
    const triggerTag = params.dmContextSnapshot?.triggerMessageId === params.rootMessage.messageId ? ' [Trigger]' : '';
    const rootContent = sanitizePromptHistoryContent(params.rootMessage.content, params.rootMessage.senderType);
    if (rootContent) {
      const rootLines = [
        '[Thread root message]',
        `@${params.rootMessage.senderName}${triggerTag}: ${rootContent}`,
      ];
      const attachmentContext = buildAttachmentReferenceContextText(params.rootMessage.attachmentIds);
      if (attachmentContext) {
        rootLines.push('', attachmentContext);
      }
      sections.push(
        rootLines.join('\n'),
      );
    }
  }

  const exactHistory = buildExactTargetHistoryContextText(params);
  if (exactHistory.trim()) {
    sections.push(exactHistory);
  }

  if (options?.includeDmContextSnapshot !== false && params.dmContextSnapshot?.messages.length) {
    const visibleDmMessages = params.dmContextSnapshot.messages
      .map((message) => {
        const content = sanitizePromptHistoryContent(message.content, message.senderType);
        return content
          ? { ...message, content }
          : null;
      })
      .filter((message): message is ActivationContextMessage => Boolean(message));
    if (visibleDmMessages.length) {
      const formattedMessages = visibleDmMessages.map((message) => {
        const triggerTag = params.dmContextSnapshot?.triggerMessageId === message.messageId ? ' [Trigger]' : '';
        const lines = [`@${message.senderName}${triggerTag}: ${message.content}`];
        const attachmentContext = buildAttachmentReferenceContextText(message.attachmentIds);
        if (attachmentContext) {
          lines.push(attachmentContext);
        }
        return lines.join('\n');
      });
      sections.push(
        [
          '[Context from DM]',
          formattedMessages.join('\n\n'),
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
