import type { Db } from '../db/db.js';
export type Platform = 'discord' | 'telegram' | 'feishu' | 'web' | 'node';
export declare const SHARED_CHAT_SCOPE_USER_ID = "__chat_scope__";
export type ConversationKey = {
    platform: Platform;
    chatId: string;
    threadId: string | null;
    userId: string;
    scopeUserId?: string | null;
};
export type SessionBinding = {
    bindingKey: string;
    sessionKey: string;
};
export declare function bindingKeyFromConversationKey(key: ConversationKey): string;
export declare function bindingScopeUserId(key: ConversationKey): string;
export declare function getBinding(db: Db, key: ConversationKey): SessionBinding | null;
export declare function upsertBinding(db: Db, key: ConversationKey, sessionKey: string): SessionBinding;
export declare function deleteBinding(db: Db, key: ConversationKey): void;
export declare function createSession(db: Db, params: {
    sessionKey: string;
    agentCommand: string;
    agentArgs: string[];
    cwd: string;
    loadSupported: boolean;
}): void;
export declare function updateAcpSessionId(db: Db, sessionKey: string, acpSessionId: string): void;
export declare function updateLoadSupported(db: Db, sessionKey: string, loadSupported: boolean): void;
export declare function updateSessionCwd(db: Db, sessionKey: string, cwd: string): void;
export declare function updateSessionAgentConfig(db: Db, params: {
    sessionKey: string;
    agentCommand: string;
    agentArgs: string[];
}): void;
export declare function getSession(db: Db, sessionKey: string): {
    sessionKey: string;
    agentCommand: string;
    agentArgsJson: string;
    acpSessionId: string | null;
    cwd: string;
    loadSupported: number;
} | null;
export declare function createRun(db: Db, params: {
    runId: string;
    sessionKey: string;
    promptText: string;
}): void;
export declare function finishRun(db: Db, params: {
    runId: string;
    stopReason?: string;
    error?: string;
}): void;
