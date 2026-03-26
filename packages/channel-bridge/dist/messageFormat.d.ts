export type IncomingMessageItem = {
    message_id: string;
    target: string;
    timestamp: string;
    sender_name: string;
    sender_type: string;
    content: string;
};
export type HistoryMessageItem = {
    seq: number;
    createdAt: string;
    senderName: string;
    senderType: string;
    content: string;
};
export declare function formatMessages(messages: IncomingMessageItem[]): string;
export declare function formatHistoryMessages(messages: HistoryMessageItem[]): string;
//# sourceMappingURL=messageFormat.d.ts.map