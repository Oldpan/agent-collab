import type { Db } from '../db/db.js';
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type PersistentToolPolicy = 'allow' | 'reject';
export declare const TOOL_KINDS: ToolKind[];
export declare function parseToolKind(value: unknown): ToolKind | null;
export type ToolMatchContext = {
    method?: string;
    params?: unknown;
    toolCall?: unknown;
    workspaceRoot?: string;
};
export type ToolAllowPrefixRule = {
    toolKind: ToolKind;
    argPrefix: string;
};
export declare class ToolAuth {
    private readonly db;
    private readonly onceGrants;
    constructor(db: Db);
    grantOnce(sessionKey: string, toolKind: ToolKind, count?: number): void;
    setPersistentPolicy(bindingKey: string, toolKind: ToolKind, policy: PersistentToolPolicy): void;
    getPersistentPolicy(bindingKey: string, toolKind: ToolKind): PersistentToolPolicy | null;
    listPersistentPolicies(bindingKey: string, policy?: PersistentToolPolicy): Array<{
        toolKind: ToolKind;
        policy: PersistentToolPolicy;
    }>;
    clearPersistentPolicy(bindingKey: string, toolKind: ToolKind, policy?: PersistentToolPolicy): boolean;
    clearPersistentPolicies(bindingKey: string, policy?: PersistentToolPolicy): number;
    setAllowPrefixRule(bindingKey: string, toolKind: ToolKind, argPrefix: string): void;
    listAllowPrefixRules(bindingKey: string, toolKind?: ToolKind): ToolAllowPrefixRule[];
    clearAllowPrefixRule(bindingKey: string, toolKind: ToolKind, argPrefix: string): boolean;
    clearAllowPrefixRules(bindingKey: string, toolKind?: ToolKind): number;
    evaluatePersistentPolicy(bindingKey: string, toolKind: ToolKind, context?: ToolMatchContext): PersistentToolPolicy | null;
    consume(sessionKey: string, toolKind: ToolKind, context?: ToolMatchContext): boolean;
    private matchesAllowPrefixRule;
}
