import type { Db } from '../db/db.js';
import type { ToolAuth, ToolKind } from '../gateway/toolAuth.js';
import { type JsonRpcId } from './jsonrpc.js';
import { type StdioProcess } from './stdio.js';
import type { InitializeResult, NewSessionParams, NewSessionResult, PromptParams, PromptResult, RequestPermissionParams } from './types.js';
export type AcpRun = {
    runId: string;
    sessionKey: string;
    createdAtMs: number;
};
export type PermissionRequest = {
    requestId: JsonRpcId;
    sessionKey: string;
    sessionId: string;
    params: RequestPermissionParams;
    createdAtMs: number;
};
export type PermissionDecision = {
    kind: 'selected';
    optionId: string;
} | {
    kind: 'cancelled';
};
export type ClientToolEvent = {
    phase: 'start' | 'end' | 'error';
    method: string;
    params: unknown;
    result?: unknown;
    error?: string;
};
export type AcpClientEvents = {
    onSessionUpdate?: (run: AcpRun, sessionId: string, update: any, eventSeq: number) => void;
    onPermissionRequest?: (req: PermissionRequest) => void;
    onClientTool?: (run: AcpRun, event: ClientToolEvent) => void;
    onAgentStderr?: (line: string) => void;
};
export declare class AcpClient {
    private readonly db;
    private readonly workspaceRoot;
    private readonly agentCommand;
    private readonly agentArgs;
    private readonly toolAuth;
    private readonly defaultAllowTools;
    private readonly disabledToolKinds;
    private readonly rpc;
    private nextId;
    private readonly pending;
    private currentRun;
    private readonly runSeq;
    private readonly pendingLocalPermissions;
    private readonly events;
    constructor(params: {
        db: Db;
        workspaceRoot: string;
        agentCommand: string;
        agentArgs: string[];
        toolAuth?: ToolAuth;
        defaultAllowTools?: boolean;
        disabledToolKinds?: ToolKind[];
        events?: AcpClientEvents;
        rpc?: StdioProcess;
        env?: Record<string, string>;
    });
    close(): void;
    private initPromise;
    initialize(): Promise<InitializeResult>;
    newSession(params: NewSessionParams): Promise<NewSessionResult>;
    prompt(run: AcpRun, params: PromptParams): Promise<PromptResult>;
    notifyCancel(sessionId: string): void;
    respondPermission(req: PermissionRequest, decision: PermissionDecision): Promise<void>;
    private handleMessage;
    private handleAgentRequest;
    private request;
    private rejectPendingRequest;
    private rejectAllPending;
    private rejectAllLocalPermissions;
    private makeTransportError;
    private respond;
    private respondError;
    private appendEvent;
    private ensureAuthorized;
    private readonly terminals;
    private terminalCreate;
    private terminalOutput;
    private terminalWaitForExit;
    private terminalKill;
    private terminalRelease;
}
