export function buildDirectActivationPrompt(params) {
    const replyTarget = params.replyTarget ?? `dm:@${params.senderName}`;
    const lines = [
        `[System: ${params.senderName} sent you a direct message.]`,
        'The triggering message is included below. Do not call check_messages just to retrieve this same message again.',
        `This execution is bound to reply_target="${replyTarget}". Prefer mcp__chat__send_message(content="...") with no target to reply there.`,
        `If you need more context, call read_history(channel="${replyTarget}") for this direct conversation.`,
        'Reply only via mcp__chat__send_message(...). Do not output text directly.',
        '',
        '[Current conversation target]',
        `reply_target: ${replyTarget}`,
        '',
    ];
    lines.push('[Triggered message metadata]', `target: ${replyTarget}`, `recipient: @${params.agentName}`, `sender: @${params.senderName}`, '', '[Triggered message body]', params.content);
    return lines.join('\n');
}
