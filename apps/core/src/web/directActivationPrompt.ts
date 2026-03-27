type DirectActivationPromptParams = {
  agentName: string;
  senderName: string;
  content: string;
};

export function buildDirectActivationPrompt(params: DirectActivationPromptParams): string {
  return [
    `[System: ${params.senderName} sent you a direct message.]`,
    'The triggering message is included below. Do not call check_messages just to retrieve this same message again.',
    'If you need more context, call read_history(channel="dm:@User") for this direct conversation.',
    '',
    '[Triggered message metadata]',
    'target: dm:@User',
    `recipient: @${params.agentName}`,
    `sender: @${params.senderName}`,
    '',
    '[Triggered message body]',
    params.content,
  ].join('\n');
}
