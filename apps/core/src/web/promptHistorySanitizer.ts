type PromptHistorySenderType = 'user' | 'agent' | 'system';

const LOW_SIGNAL_STATUS_LINE_PATTERNS = [
  /^\s*\[(?:plan|task)\]\s*$/i,
  /^\s*\[(?:plan|task)\]\s*(?:plan|task)?\s*updated\s*$/i,
  /^\s*\[(?:plan|task)\s+updated\]\s*$/i,
  /^\s*(?:plan|task)\s+updated\s*$/i,
];

function isLowSignalStatusLine(line: string): boolean {
  return LOW_SIGNAL_STATUS_LINE_PATTERNS.some((pattern) => pattern.test(line.trim()));
}

export function sanitizePromptHistoryContent(
  content: string,
  senderType: PromptHistorySenderType,
): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (senderType === 'user') return trimmed;

  const cleaned = trimmed
    .split('\n')
    .filter((line) => !isLowSignalStatusLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

export function hasVisiblePromptHistoryContent(
  content: string,
  senderType: PromptHistorySenderType,
): boolean {
  return sanitizePromptHistoryContent(content, senderType).length > 0;
}
