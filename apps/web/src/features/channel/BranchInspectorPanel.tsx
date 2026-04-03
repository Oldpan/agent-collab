import { useCallback, useEffect, useState } from "react";
import { ActivityIcon, BugIcon, MessageSquareOffIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { useConversationStream } from "@/hooks/useConversationStream";
import { AgentActivityPanel } from "@/features/chat/AgentActivityPanel";
import { CodexDebugPanel } from "@/features/chat/CodexDebugPanel";
import type { AgentInfo, ConversationInfo } from "@agent-collab/protocol";

type BranchInspectorPanelProps = {
  conversation: ConversationInfo;
  agent: AgentInfo | null;
  isAdmin?: boolean;
  onRestart: (conversationId: string) => Promise<void>;
  onClearChat: (conversationId: string) => Promise<void>;
  onClose: () => void;
};

type ControlDialogConfig = {
  title: string;
  message: string;
  confirmText: string;
  variant: "warning" | "info";
  onConfirm: () => Promise<void>;
} | null;

function BranchControlPanel({
  conversation,
  agent,
  busy,
  onRestart,
  onClearChat,
}: {
  conversation: ConversationInfo;
  agent: AgentInfo | null;
  busy: boolean;
  onRestart: () => void;
  onClearChat: () => void;
}) {
  const targetLabel = conversation.replyTarget?.trim() || "(no reply target)";
  const branchLabel = conversation.threadRootId ? "Thread Branch" : "Channel Branch";

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="space-y-4">
        <section className="rounded-md border-2 border-zinc-900 bg-[#fff8d8] px-4 py-4 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Branch Scope</div>
          <div className="mt-2 text-sm font-semibold text-zinc-900">{agent?.name ?? "Agent"} · {branchLabel}</div>
          <div className="mt-1 text-xs text-zinc-600">
            This inspector controls the agent&apos;s private runtime for the current channel target. Public channel and thread messages remain in the channel view.
          </div>
          <div className="mt-3 rounded-sm border border-zinc-900/15 bg-white/70 px-3 py-2 text-xs text-zinc-700">
            <div className="font-semibold text-zinc-500">reply_target</div>
            <div className="mt-1 font-mono break-all text-[11px]">{targetLabel}</div>
          </div>
        </section>

        <section className="rounded-md border-2 border-zinc-900 bg-[#fff8d8] px-4 py-4 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)]">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Actions</div>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#dff0ff] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#c5e4ff]"
              onClick={onRestart}
              disabled={busy}
              title="Restart this branch runtime and keep its history"
            >
              <RefreshCwIcon className="mr-1 size-3.5" />
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 flex-1 rounded-sm border-2 border-zinc-900 bg-[#fff0d0] px-2 text-xs text-zinc-950 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#ffe4b0]"
              onClick={onClearChat}
              disabled={busy}
              title="Clear this branch runtime history and start a fresh session"
            >
              <MessageSquareOffIcon className="mr-1 size-3.5" />
              Clear chat
            </Button>
          </div>
          <div className="mt-3 rounded-sm border border-zinc-900/15 bg-white/70 px-3 py-2 text-xs text-zinc-600">
            Restart and Clear chat only affect this branch conversation. They do not delete public channel or thread messages.
          </div>
        </section>
      </div>
    </div>
  );
}

export function BranchInspectorPanel({
  conversation,
  agent,
  isAdmin = false,
  onRestart,
  onClearChat,
  onClose,
}: BranchInspectorPanelProps) {
  const canShowDebug = isAdmin && conversation.agentType === "codex_acp";
  const [activeTab, setActiveTab] = useState<"debug" | "activity" | "control">(
    canShowDebug ? "debug" : "activity",
  );
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogConfig, setDialogConfig] = useState<ControlDialogConfig>(null);
  const { runs } = useConversationStream({
    conversationId: conversation.id,
    conversationAgentId: conversation.agentId,
  });

  useEffect(() => {
    setActiveTab(canShowDebug ? "debug" : "activity");
  }, [canShowDebug, conversation.id]);

  const openDialog = useCallback((config: ControlDialogConfig) => {
    setDialogConfig(config);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setDialogConfig(null);
  }, []);

  const handleRestart = useCallback(() => {
    openDialog({
      title: "Restart Branch Runtime",
      message: `Restart the current ${agent?.name ?? "agent"} branch runtime?\n\nThis keeps branch history but reconnects the runtime session.`,
      confirmText: "Restart",
      variant: "info",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onRestart(conversation.id);
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent?.name, closeDialog, conversation.id, onRestart, openDialog]);

  const handleClearChat = useCallback(() => {
    openDialog({
      title: "Clear Branch Chat",
      message: `Clear chat history for the current ${agent?.name ?? "agent"} branch?\n\nThis creates a fresh session for this branch only. Public channel and thread messages stay intact.`,
      confirmText: "Clear",
      variant: "warning",
      onConfirm: async () => {
        setBusy(true);
        try {
          await onClearChat(conversation.id);
        } finally {
          setBusy(false);
          closeDialog();
        }
      },
    });
  }, [agent?.name, closeDialog, conversation.id, onClearChat, openDialog]);

  const branchLabel = conversation.threadRootId ? "Thread Branch" : "Channel Branch";

  return (
    <div className="flex h-full min-h-0 flex-col border-l-2 border-black bg-[#fffdf5]">
      <div className="border-b-2 border-black bg-[#fff8d8] px-4 py-3 shadow-[0_2px_0_0_rgba(0,0,0,0.08)]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-zinc-950">{agent?.name ?? "Agent"} · Branch Inspector</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-zinc-500">{branchLabel}</div>
            <div className="mt-2 font-mono text-[11px] text-zinc-600">{conversation.replyTarget}</div>
          </div>
          <Button
            size="icon"
            variant="outline"
            className="size-8 rounded-sm border-2 border-zinc-900 bg-[#fffdf4] text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.08)] hover:bg-[#fff1a9]"
            onClick={onClose}
            aria-label="Close branch inspector"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canShowDebug ? (
            <Button
              size="sm"
              variant={activeTab === "debug" ? "default" : "outline"}
              className={cn(
                "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
                activeTab === "debug" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
              )}
              onClick={() => setActiveTab("debug")}
            >
              <BugIcon className="mr-1.5 size-3" />
              Debug
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={activeTab === "activity" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "activity" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("activity")}
          >
            <ActivityIcon className="mr-1.5 size-3" />
            Activity
          </Button>
          <Button
            size="sm"
            variant={activeTab === "control" ? "default" : "outline"}
            className={cn(
              "h-8 rounded-sm border-2 border-zinc-900 text-xs shadow-[2px_2px_0_0_rgba(0,0,0,0.12)]",
              activeTab === "control" ? "bg-[#ffd54a] text-zinc-950 hover:bg-[#f7ca2e]" : "bg-[#fff9d8] text-zinc-700 hover:bg-[#fff1a9]",
            )}
            onClick={() => setActiveTab("control")}
          >
            Control
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activeTab === "debug" && canShowDebug ? (
          <CodexDebugPanel conversationId={conversation.id} />
        ) : activeTab === "activity" ? (
          <AgentActivityPanel runs={runs} />
        ) : (
          <BranchControlPanel
            conversation={conversation}
            agent={agent}
            busy={busy}
            onRestart={handleRestart}
            onClearChat={handleClearChat}
          />
        )}
      </div>

      <ConfirmDialog
        isOpen={dialogOpen}
        title={dialogConfig?.title ?? ""}
        message={dialogConfig?.message ?? ""}
        confirmText={dialogConfig?.confirmText ?? "Confirm"}
        variant={dialogConfig?.variant ?? "info"}
        onConfirm={() => {
          if (dialogConfig?.onConfirm) {
            void dialogConfig.onConfirm();
          }
        }}
        onCancel={closeDialog}
      />
    </div>
  );
}
