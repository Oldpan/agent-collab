function formatMetadataBlock(lines) {
    return ['[Message metadata]', ...lines].join('\n');
}
function formatBodyBlock(label, body) {
    return `${label}\n${body}`;
}
export function formatMessages(messages) {
    return messages
        .map((m) => {
        const metadata = formatMetadataBlock([
            `target: ${m.target}`,
            `msg: ${m.message_id.slice(0, 8)}`,
            `time: ${m.timestamp}`,
            `sender: @${m.sender_name}`,
            ...(m.sender_type === 'agent' ? ['sender_type: agent'] : []),
        ]);
        const body = formatBodyBlock('[Message body]', m.content);
        return `${metadata}\n\n${body}`;
    })
        .join('\n\n---\n\n');
}
export function formatHistoryMessages(messages) {
    return messages
        .map((m) => {
        const metadata = formatMetadataBlock([
            `seq: ${m.seq}`,
            `time: ${m.createdAt}`,
            `sender: @${m.senderName}`,
            ...(m.senderType === 'agent' ? ['sender_type: agent'] : []),
        ]);
        const body = formatBodyBlock('[Message body]', m.content);
        return `${metadata}\n\n${body}`;
    })
        .join('\n\n---\n\n');
}
//# sourceMappingURL=messageFormat.js.map