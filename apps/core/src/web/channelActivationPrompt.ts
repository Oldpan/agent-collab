import type { ActivationContextMessage } from './activationContext.js';

type ChannelActivationPromptParams = {
  channelName: string;
  target: string;
  replyTarget?: string;
  senderName: string;
  content: string;
  reason: 'mention' | 'thread_reply';
  recentMessages?: ActivationContextMessage[];
  rootMessage?: ActivationContextMessage;
  unreadCount?: number;
};

export function buildChannelActivationPrompt(params: ChannelActivationPromptParams): string {
  const reasonText = params.reason === 'mention'
    ? `You were @mentioned in #${params.channelName} by ${params.senderName}.`
    : `Your message in #${params.channelName} received a reply from ${params.senderName}.`;

  const replyTarget = params.replyTarget ?? params.target;
  const lines = [
    `[System: ${reasonText}]`,
    'The triggering message is included below. Do not call check_messages just to retrieve this same message again.',
    `This execution is bound to reply_target="${replyTarget}". Prefer mcp__chat__send_message(content="...") with no target to reply there.`,
    `If you need more context, call read_history(channel="${params.target}") for this exact conversation target.`,
    'Reply only via mcp__chat__send_message(...). Do not output text directly.',
    'If you are doing channel work, ordinary progress updates can be plain channel replies. Only @mention the user when you are done, hit a major blocker, or need a decision.',
    '',
    '[Current conversation target]',
    `reply_target: ${replyTarget}`,
    '',
  ];

  if (params.rootMessage) {
    lines.push(
      '[Thread root message]',
      formatPromptMessage(params.rootMessage),
      '',
    );
  }

  if (params.recentMessages && params.recentMessages.length > 0) {
    lines.push(
      '[Recent messages on this exact target]',
      params.recentMessages.map((message) => formatPromptMessage(message)).join('\n\n'),
      '',
    );
  }

  if ((params.unreadCount ?? 0) > 0) {
    const label = params.unreadCount === 1 ? '1 older unread message' : `${params.unreadCount} older unread messages`;
    lines.push(
      '[Unread summary]',
      `${label} exist on this exact target before the triggering message. Use read_history(channel="${params.target}") if you need them in full.`,
      '',
    );
  }

  lines.push(
    '[Triggered message metadata]',
    `target: ${params.target}`,
    `sender: @${params.senderName}`,
    '',
    '[Triggered message body]',
    params.content,
  );

  return lines.join('\n');
}

function formatPromptMessage(message: ActivationContextMessage): string {
  const senderTypeLine = message.senderType === 'agent' ? '\nsender_type: agent' : '';
  return [
    '[Message metadata]',
    `target: ${message.target}`,
    `msg: ${message.messageId.slice(0, 8)}`,
    `time: ${new Date(message.createdAt).toISOString()}`,
    `sender: @${message.senderName}${senderTypeLine}`,
    '',
    '[Message body]',
    message.content,
  ].join('\n');
}
