export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type CodexModelOption = {
  value: string;
  label: string;
  reasoningEfforts: CodexReasoningEffort[];
};

export type CodexReasoningOption = {
  value: string;
  label: string;
};

// Codex CLI does not expose a stable non-interactive model catalog.
// Keep a curated list of current supported model/reasoning combinations.
export const CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  { value: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5", label: "GPT-5", reasoningEfforts: ["low", "medium", "high"] },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.1-codex", label: "GPT-5.1 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", reasoningEfforts: ["medium", "high"] },
];

const REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export function getCodexModelOptions(currentModel?: string | null): CodexModelOption[] {
  const normalized = currentModel?.trim();
  if (!normalized) return CODEX_MODEL_OPTIONS;
  if (CODEX_MODEL_OPTIONS.some((option) => option.value === normalized)) {
    return CODEX_MODEL_OPTIONS;
  }
  return [
    { value: normalized, label: `${normalized} (Current)`, reasoningEfforts: [] },
    ...CODEX_MODEL_OPTIONS,
  ];
}

export function getCodexReasoningOptions(model?: string | null, currentReasoningEffort?: string | null): CodexReasoningOption[] {
  const normalizedModel = model?.trim();
  const normalizedEffort = currentReasoningEffort?.trim();
  const option = normalizedModel
    ? CODEX_MODEL_OPTIONS.find((item) => item.value === normalizedModel)
    : null;
  const efforts = option?.reasoningEfforts ?? [];
  const reasoningOptions = efforts.map((effort) => ({
    value: effort,
    label: REASONING_LABELS[effort],
  }));
  if (!normalizedEffort) return reasoningOptions;
  if (reasoningOptions.some((item) => item.value === normalizedEffort)) return reasoningOptions;
  return [
    {
      value: normalizedEffort,
      label: `${normalizedEffort} (Current)`,
    },
    ...reasoningOptions,
  ];
}
