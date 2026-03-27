type ChannelActivationPromptParams = {
  channelName: string;
  target: string;
  senderName: string;
  content: string;
  reason: 'mention' | 'thread_reply';
};

export function buildChannelActivationPrompt(params: ChannelActivationPromptParams): string {
  const reasonText = params.reason === 'mention'
    ? `You were @mentioned in #${params.channelName} by ${params.senderName}.`
    : `Your message in #${params.channelName} received a reply from ${params.senderName}.`;

  return [
    `[System: ${reasonText}]`,
    'The triggering message is included below. Do not call check_messages just to retrieve this same message again.',
    `If you need more context, call read_history(channel="${params.target}") for this exact conversation target.`,
    'If you are doing channel work, ordinary progress updates can be plain channel replies. Only @mention the user when you are done, hit a major blocker, or need a decision.',
    '',
    '[Triggered message metadata]',
    `target: ${params.target}`,
    `sender: @${params.senderName}`,
    '',
    '[Triggered message body]',
    params.content,
  ].join('\n');
}
