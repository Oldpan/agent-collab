export function isRequest(message) {
    return (message &&
        message.jsonrpc === '2.0' &&
        typeof message.method === 'string' &&
        'id' in message);
}
export function isNotification(message) {
    return (message &&
        message.jsonrpc === '2.0' &&
        typeof message.method === 'string' &&
        !('id' in message));
}
export function isResponse(message) {
    return (message &&
        message.jsonrpc === '2.0' &&
        'id' in message &&
        ('result' in message || 'error' in message));
}
