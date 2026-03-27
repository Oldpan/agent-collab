export function buildDirectActivationPrompt(params) {
    return [
        `[System: ${params.senderName} sent you a direct message.]`,
        'The triggering message is included below. Do not call check_messages just to retrieve this same message again.',
        `If you need more context, call read_history(channel="dm:@${params.senderName}") for this direct conversation.`,
        '',
        '[Triggered message metadata]',
        `target: dm:@${params.senderName}`,
        `recipient: @${params.agentName}`,
        `sender: @${params.senderName}`,
        '',
        '[Triggered message body]',
        params.content,
    ].join('\n');
}
