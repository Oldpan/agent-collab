export function buildChannelActivationPrompt(params) {
    const reasonText = params.reason === 'mention'
        ? `You were @mentioned in #${params.channelName} by ${params.senderName}.`
        : `Your message in #${params.channelName} received a reply from ${params.senderName}.`;
    const replyTarget = params.replyTarget ?? params.target;
    const lines = [
        `[System: ${reasonText}]`,
        'The triggering message is included below. Do not call check_messages just to retrieve this same message again.',
        `This execution is bound to reply_target="${replyTarget}". Prefer mcp__chat__send_message(content="...") with no target to reply there.`,
        `If you need more context, call read_history(channel="${params.target}") for this exact conversation target.`,
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
export function buildChannelActivationContextText(params) {
    const parts = [];
    if (params.rootMessage) {
        parts.push(`[Thread root message]\n${formatPromptMessage(params.rootMessage)}`);
    }
    if (params.recentMessages && params.recentMessages.length > 0) {
        parts.push(`[Recent messages on this exact target]\n${params.recentMessages.map(formatPromptMessage).join('\n\n')}`);
    }
    if ((params.unreadCount ?? 0) > 0) {
        const label = params.unreadCount === 1 ? '1 older unread message' : `${params.unreadCount} older unread messages`;
        parts.push(`[Unread summary]\n${label} exist on this exact target before the triggering message. Use read_history(channel="${params.target}") if you need them in full.`);
    }
    return parts.join('\n\n');
}
function formatPromptMessage(message) {
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
