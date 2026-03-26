import type { Db } from '../db/db.js';
import type { OutboundSink, UiMode } from './types.js';
export interface RuntimeConfig {
    acpAgentCommand: string;
    acpAgentArgs: string[];
    uiJsonMaxChars: number;
}
import { type PermissionRequest } from '../acp/client.js';
import type { InitializeResult, McpServerEntry } from '../acp/types.js';
import { ToolAuth, type ToolKind } from './toolAuth.js';
export declare class BindingRuntime {
    private readonly db;
    private readonly config;
    private readonly toolAuth;
    private readonly sessionKey;
    private readonly bindingKey;
    private readonly client;
    private init;
    private acpSessionId;
    private queue;
    private activeSink;
    private pendingPermission;
    private pendingPermissionActorUserId;
    private currentRunId;
    private currentRunLastSeq;
    private currentUiMode;
    private currentActorUserId;
    private sinkWriteQueue;
    private toolCallTitles;
    private toolCallTextBreaks;
    private readonly workspaceRoot;
    private readonly agentCommand;
    private readonly agentArgs;
    private readonly env?;
    private readonly disabledToolKinds;
    private readonly channelBridgeMcpEntry?;
    constructor(params: {
        db: Db;
        config: RuntimeConfig;
        toolAuth: ToolAuth;
        sessionKey: string;
        bindingKey: string;
        workspaceRoot: string;
        agentCommand?: string;
        agentArgs?: string[];
        env?: Record<string, string>;
        disabledToolKinds?: ToolKind[];
        acpRpc?: import('../acp/stdio.js').StdioProcess;
        channelBridgeMcpEntry?: McpServerEntry;
    });
    close(): void;
    private enqueueSinkWrite;
    private flushSinkWriteQueue;
    ensureInitialized(): Promise<InitializeResult>;
    ensureSessionId(): Promise<string>;
    getLoadSupported(): boolean;
    getPendingPermission(): PermissionRequest | null;
    selectPermissionOption(idx: number, sink: OutboundSink, actorUserId?: string): Promise<void>;
    hasSessionId(): boolean;
    decidePermission(params: {
        decision: 'allow' | 'deny';
        requestId?: string;
        actorUserId?: string;
    }): Promise<{
        ok: boolean;
        message: string;
    }>;
    denyPermission(sink: OutboundSink, actorUserId?: string): Promise<void>;
    respondToPermission(requestId: string, decision: 'allow' | 'deny', actorUserId?: string): Promise<boolean>;
    hasPendingPermission(): boolean;
    cancelCurrentRun(runId?: string): Promise<boolean>;
    private resetAcpSession;
    private promptOnce;
    prompt(params: {
        runId: string;
        promptText: string;
        promptResources?: Array<{
            uri: string;
            mimeType?: string;
        }>;
        sink: OutboundSink;
        uiMode: UiMode;
        contextText?: string;
        actorUserId?: string;
    }): Promise<{
        stopReason: string;
        lastSeq: number;
    }>;
    private isPermissionActorAuthorized;
    private buildToolUiEvent;
    private shouldBreakTextStreamForToolUpdate;
}
