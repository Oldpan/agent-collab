import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CLAUDE_RUNTIME_DIRNAME = '.claude-runtime';
export function getIsolatedClaudeConfigDir(workspaceRoot) {
    return path.join(path.resolve(workspaceRoot), CLAUDE_RUNTIME_DIRNAME);
}
export function getIsolatedClaudeStatePath(workspaceRoot) {
    return `${getIsolatedClaudeConfigDir(workspaceRoot)}.json`;
}
export function ensureIsolatedClaudeConfig(workspaceRoot) {
    const configDir = getIsolatedClaudeConfigDir(workspaceRoot);
    const statePath = getIsolatedClaudeStatePath(workspaceRoot);
    fs.mkdirSync(configDir, { recursive: true });
    writeJsonIfChanged(path.join(configDir, 'settings.json'), {});
    writeJsonIfChanged(path.join(configDir, 'settings.local.json'), {});
    writeJsonIfChanged(statePath, {});
    // Keep Claude auth working without inheriting the user's full runtime config.
    const defaultCredentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const isolatedCredentialsPath = path.join(configDir, '.credentials.json');
    if (!fs.existsSync(isolatedCredentialsPath) && fs.existsSync(defaultCredentialsPath)) {
        fs.copyFileSync(defaultCredentialsPath, isolatedCredentialsPath);
    }
    return configDir;
}
function writeJsonIfChanged(filePath, value) {
    const next = `${JSON.stringify(value, null, 2)}\n`;
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (current === next)
        return;
    fs.writeFileSync(filePath, next, 'utf8');
}
