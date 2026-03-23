export type AgentType = 'claude_acp' | 'codex_acp';
export type ConversationStatus = 'idle' | 'queued' | 'active' | 'recovering' | 'awaiting_approval' | 'failed';
export type ThreadKind = 'direct' | 'branch';
export type RuntimeDispatchMode = 'cold_start' | 'resume';
export type RuntimeDriverDefinition = {
    agentType: AgentType;
    command: string;
    args: string[];
    supportsResume: boolean;
    supportsPushNotifications: boolean;
    nativeMemoryBackend: 'claude' | 'workspace';
    defaultEnv?: Record<string, string>;
};
export declare const RUNTIME_DRIVERS: Record<AgentType, RuntimeDriverDefinition>;
export declare function getRuntimeDriver(agentType: AgentType): RuntimeDriverDefinition;
export declare function listRuntimeDrivers(): RuntimeDriverDefinition[];
export type ConversationStatusEvent = {
    type: 'conversation.status';
    status: ConversationStatus;
    conversationId: string;
};
export type TurnBeginEvent = {
    type: 'turn.begin';
    turnId: string;
};
export type TurnEndEvent = {
    type: 'turn.end';
    turnId: string;
    stopReason?: string;
};
export type ContentDeltaEvent = {
    type: 'content.delta';
    text: string;
};
export type ThinkingDeltaEvent = {
    type: 'thinking.delta';
    text: string;
};
export type ToolCallEvent = {
    type: 'tool.call';
    toolCallId: string;
    name: string;
    input: unknown;
};
export type ToolResultEvent = {
    type: 'tool.result';
    toolCallId: string;
    output: string;
    error?: boolean;
};
export type ApprovalRequestEvent = {
    type: 'approval.request';
    requestId: string;
    toolName: string;
    toolArgs: unknown;
    toolKind?: string | null;
};
export type ErrorEvent = {
    type: 'error';
    message: string;
};
export type HistoryCompleteEvent = {
    type: 'history.complete';
};
export type HistoryUserMessageEvent = {
    type: 'history.user_message';
    text: string;
};
export type ServerEvent = ConversationStatusEvent | TurnBeginEvent | TurnEndEvent | ContentDeltaEvent | ThinkingDeltaEvent | ToolCallEvent | ToolResultEvent | ApprovalRequestEvent | ErrorEvent | HistoryCompleteEvent | HistoryUserMessageEvent;
export type FileRef = {
    uri: string;
    mimeType?: string;
};
export type PromptEvent = {
    type: 'prompt';
    text: string;
    attachments?: FileRef[];
};
export type ApprovalResponseEvent = {
    type: 'approval.response';
    requestId: string;
    decision: 'allow' | 'deny';
};
export type CancelEvent = {
    type: 'cancel';
};
export type ClientEvent = PromptEvent | ApprovalResponseEvent | CancelEvent;
export type NodeRegisterMsg = {
    type: 'node.register';
    nodeId: string;
    hostname: string;
    agentTypes: string[];
    version: string;
};
export type NodeHeartbeatMsg = {
    type: 'node.heartbeat';
    nodeId: string;
};
/** Agent subprocess event forwarded by node to core */
export type RunEventMsg = {
    type: 'run.event';
    runId: string;
    conversationId: string;
    event: ServerEvent;
};
export type RunEndMsg = {
    type: 'run.end';
    runId: string;
    conversationId: string;
    stopReason?: string;
    error?: string;
};
export type NodePermissionRequestMsg = {
    type: 'permission.request';
    runId: string;
    conversationId: string;
    requestId: string;
    toolName: string;
    toolArgs: unknown;
    toolKind?: string | null;
};
export type WorkspaceErrorCode = 'not_found' | 'not_directory' | 'not_file' | 'path_outside_workspace' | 'binary_file' | 'file_too_large' | 'io_error';
export type AgentWorkspaceEntry = {
    name: string;
    path: string;
    kind: 'directory' | 'file';
    size: number | null;
    modifiedAt: number | null;
};
export type WorkspaceListResponseMsg = {
    type: 'workspace.list.response';
    requestId: string;
    relativePath: string;
    entries?: AgentWorkspaceEntry[];
    error?: string;
    errorCode?: WorkspaceErrorCode;
};
export type WorkspaceReadResponseMsg = {
    type: 'workspace.read.response';
    requestId: string;
    relativePath: string;
    content?: string;
    mimeType?: 'text/markdown' | 'text/plain';
    size?: number;
    modifiedAt?: number | null;
    error?: string;
    errorCode?: WorkspaceErrorCode;
};
export type NodeToCore = NodeRegisterMsg | NodeHeartbeatMsg | RunEventMsg | RunEndMsg | NodePermissionRequestMsg | WorkspaceListResponseMsg | WorkspaceReadResponseMsg;
export type NodeAckMsg = {
    type: 'node.ack';
    nodeId: string;
};
export type RunDispatchMsg = {
    type: 'run.dispatch';
    runId: string;
    conversationId: string;
    agentType: AgentType;
    workspacePath: string | null;
    envVars?: Record<string, string>;
    prompt: string;
    sessionKey: string;
    hostKey: string;
    dispatchMode: RuntimeDispatchMode;
    contextText?: string;
};
export type RunCancelMsg = {
    type: 'run.cancel';
    runId: string;
};
export type NodePermissionResponseMsg = {
    type: 'permission.response';
    requestId: string;
    decision: 'allow' | 'deny';
};
export type WorkspaceListRequestMsg = {
    type: 'workspace.list.request';
    requestId: string;
    workspaceRoot: string;
    relativePath: string;
};
export type WorkspaceReadRequestMsg = {
    type: 'workspace.read.request';
    requestId: string;
    workspaceRoot: string;
    relativePath: string;
};
export type CoreToNode = NodeAckMsg | RunDispatchMsg | RunCancelMsg | NodePermissionResponseMsg | WorkspaceListRequestMsg | WorkspaceReadRequestMsg;
export type ConversationInfo = {
    id: string;
    channelId: string;
    title: string;
    agentType: AgentType;
    threadKind: ThreadKind;
    isPrimaryThread: boolean;
    workspacePath: string | null;
    status: ConversationStatus;
    createdAt: number;
    updatedAt: number;
    nodeId?: string | null;
    agentId?: string | null;
};
export type CreateConversationRequest = {
    agentType?: AgentType;
    workspacePath?: string;
    title?: string;
    channelId?: string;
    threadKind?: ThreadKind;
    isPrimaryThread?: boolean;
    envVars?: Record<string, string>;
    nodeId?: string;
    agentId?: string;
};
export type AgentWorkspaceListResult = {
    path: string;
    entries: AgentWorkspaceEntry[];
};
export type AgentWorkspaceFileResult = {
    path: string;
    content: string;
    mimeType: 'text/markdown' | 'text/plain';
    size: number;
    modifiedAt: number | null;
};
export type AgentInfo = {
    agentId: string;
    name: string;
    agentType: AgentType;
    channelId: string;
    systemPrompt: string;
    envVars?: Record<string, string>;
    nodeId?: string | null;
    workspacePath?: string | null;
    createdAt: number;
    updatedAt: number;
};
export type CreateAgentRequest = {
    name: string;
    agentType?: AgentType;
    channelId?: string;
    systemPrompt?: string;
    envVars?: Record<string, string>;
    nodeId?: string;
    workspacePath?: string;
};
export type UpdateAgentRequest = {
    name?: string;
    systemPrompt?: string;
    envVars?: Record<string, string>;
};
export type ChannelInfo = {
    channelId: string;
    name: string;
    workspacePath: string | null;
    createdAt: number;
    updatedAt: number;
};
export type CreateChannelRequest = {
    name: string;
    workspacePath?: string;
};
export type NodeInfoRest = {
    nodeId: string;
    hostname: string;
    agentTypes: string[];
    version: string;
    lastSeen: number;
};
export type MachineInfo = {
    nodeId: string;
    name: string;
    hostname: string | null;
    agentTypes: string[];
    version: string | null;
    status: 'pending' | 'online' | 'offline';
    envVarKeys: string[];
    lastSeen: number | null;
    provisionedAt: number;
    createdAt: number;
};
export type CreateMachineRequest = {
    name: string;
    envVarKeys?: string[];
};
