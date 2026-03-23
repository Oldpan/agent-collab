export type ParsedEnvText = {
  envVars: Record<string, string>;
  ignoredLines: string[];
};

const ENV_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvVarsText(raw: string): ParsedEnvText {
  const envVars: Record<string, string> = {};
  const ignoredLines: string[] = [];

  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(ENV_LINE_RE);
    if (!match) {
      ignoredLines.push(sourceLine);
      continue;
    }

    const key = match[1];
    const valueRaw = match[2] ?? '';
    if (!key) {
      ignoredLines.push(sourceLine);
      continue;
    }
    envVars[key] = unwrapEnvValue(valueRaw.trim());
  }

  return { envVars, ignoredLines };
}

export function formatEnvVarsText(envVars?: Record<string, string>): string {
  if (!envVars || Object.keys(envVars).length === 0) return '';
  return Object.entries(envVars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${quoteEnvValue(value)}`)
    .join('\n');
}

function unwrapEnvValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function quoteEnvValue(value: string): string {
  if (value === '') return '""';
  if (/^[A-Za-z0-9_./:@%-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
