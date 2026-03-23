export type DeliveryState = {
    text: string;
    messageId: string | null;
};
export type UiMode = 'verbose' | 'summary';
export type ToolUiStage = 'start' | 'update' | 'complete';
export type PermissionUiRequest = {
    uiMode: UiMode;
    sessionKey: string;
    requestId: string;
    toolTitle: string;
    toolKind: string | null;
    toolName?: string;
    toolArgs?: unknown;
};
export type UiEvent = {
    kind: 'plan' | 'task';
    mode: UiMode;
    title: string;
    detail?: string;
} | {
    kind: 'tool';
    mode: UiMode;
    title: string;
    detail?: string;
    toolCallId?: string;
    stage?: ToolUiStage;
    status?: string;
};
export type OutboundSink = {
    sendAgentText?: (text: string) => Promise<void>;
    sendThinkingText?: (text: string) => Promise<void>;
    sendText: (text: string) => Promise<void>;
    breakTextStream?: () => Promise<void>;
    flush?: () => Promise<void>;
    getDeliveryState?: () => DeliveryState;
    requestPermission?: (req: PermissionUiRequest) => Promise<void>;
    sendUi?: (event: UiEvent) => Promise<void>;
};
