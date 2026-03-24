export type AgentSystemPromptConfig = {
    name: string;
    displayName?: string;
    /** The agent's role description — shown as "Initial role" at the end of the prompt. */
    description?: string;
};
export type AgentSystemPromptOpts = {
    /** Tool name prefix. For Claude ACP + channel-bridge: "mcp__chat__". */
    toolPrefix: string;
    workspacePath: string;
    includeStdinNotification?: boolean;
    extraCriticalRules?: string[];
};
/**
 * Builds the agent system prompt dynamically, mirroring Slock's buildBaseSystemPrompt()
 * structure but adapted for the Agent Collab platform and its ACP runtime.
 */
export declare function buildAgentSystemPrompt(config: AgentSystemPromptConfig, opts: AgentSystemPromptOpts): string;
