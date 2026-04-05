import type { ActivationContextMessage } from './activationContext.js';
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
  return buildExactTargetHistoryContextText(params);
}
