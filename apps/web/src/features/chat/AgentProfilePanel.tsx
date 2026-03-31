import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AgentInfo } from "@agent-collab/protocol";

type AgentProfilePanelProps = {
  agent: AgentInfo | null;
};

export function AgentProfilePanel({ agent }: AgentProfilePanelProps) {
  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Agent info unavailable for this conversation.
      </div>
    );
  }

  const envKeys = Object.keys(agent.envVars ?? {}).sort((a, b) => a.localeCompare(b));
  const disabledToolKinds = [...(agent.disabledToolKinds ?? [])].sort((a, b) => a.localeCompare(b));
  const skillRoots = [...(agent.skillRoots ?? [])].sort((a, b) => a.localeCompare(b));
  const memoryPath = agent.workspacePath ? `${agent.workspacePath}/MEMORY.md` : null;
  const claudeConfigDir =
    agent.agentType === "claude_acp" && agent.workspacePath
      ? `${agent.workspacePath}/.claude-runtime`
      : null;
  const nativeSkillMountDir = agent.workspacePath
    ? agent.agentType === "claude_acp"
      ? `${agent.workspacePath}/.claude/skills`
      : `${agent.workspacePath}/.agents/skills`
    : null;

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-4 px-4 py-4">
        <ProfileSection title="Identity">
          <InfoRow label="Name" value={agent.name} />
          <InfoRow
            label="Runtime"
            value={agent.agentType === "claude_acp" ? "Claude Code" : "Codex"}
          />
          <InfoRow label="Agent ID" value={agent.agentId} mono />
          <InfoRow label="Channel" value={agent.channelId} mono />
        </ProfileSection>

        <ProfileSection title="Runtime Host">
          <InfoRow label="Node" value={agent.nodeId ?? "Unassigned"} mono />
          <InfoRow label="Workspace" value={agent.workspacePath ?? "Not configured"} mono />
          <InfoRow label="Local Memory" value={memoryPath ?? "Not configured"} mono />
          <InfoRow label="Skill Roots" value={skillRoots.length > 0 ? skillRoots.join("\n") : "Not configured"} mono />
          {nativeSkillMountDir ? <InfoRow label="Native Skill Mount" value={nativeSkillMountDir} mono /> : null}
          {claudeConfigDir ? <InfoRow label="Claude Config Dir" value={claudeConfigDir} mono /> : null}
        </ProfileSection>

        <ProfileSection title="Configured Env Vars">
          {envKeys.length === 0 ? (
            <div className="text-sm text-muted-foreground">No agent-level environment variables.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {envKeys.map((key) => (
                <Badge key={key} variant="outline" className="font-mono text-[11px]">
                  {key}
                </Badge>
              ))}
            </div>
          )}
        </ProfileSection>

        <ProfileSection title="Disabled Permissions">
          {disabledToolKinds.length === 0 ? (
            <div className="text-sm text-muted-foreground">None. This agent currently runs with full tool access.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {disabledToolKinds.map((kind) => (
                <Badge key={kind} variant="outline" className="font-mono text-[11px]">
                  {kind}
                </Badge>
              ))}
            </div>
          )}
        </ProfileSection>
      </div>
    </ScrollArea>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card/50">
      <div className="border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="space-y-3 px-4 py-4">{children}</div>
    </section>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={mono ? "break-all rounded-md bg-muted/40 px-3 py-2 font-mono text-xs" : "text-sm"}>
        {value}
      </div>
    </div>
  );
}
