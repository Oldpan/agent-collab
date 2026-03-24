import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { log } from '../logging.js';
export function spawnAcpAgent(command, args, env) {
    const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            // Unset vars that would prevent Claude Code from starting inside an existing Claude session
            CLAUDECODE: undefined,
            CLAUDE_CODE_ENTRYPOINT: undefined,
            ...env,
        },
    });
    const stdoutRl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
    });
    const stderrRl = readline.createInterface({
        input: child.stderr,
        crlfDelay: Infinity,
    });
    const messageHandlers = [];
    const stderrHandlers = [];
    const exitHandlers = [];
    let exitInfo = null;
    stdoutRl.on('line', (line) => {
        if (!line.trim())
            return;
        try {
            const msg = JSON.parse(line);
            messageHandlers.forEach((h) => h(msg));
        }
        catch (error) {
            log.error('ACP stdout non-JSON line (fatal):', line);
            log.error(error);
            child.kill('SIGKILL');
        }
    });
    stderrRl.on('line', (line) => {
        stderrHandlers.forEach((h) => h(line));
    });
    const handleExit = (code, signal) => {
        if (!exitInfo) {
            exitInfo = { code, signal };
        }
        log.warn('ACP agent exited', exitInfo);
        exitHandlers.forEach((h) => h(exitInfo));
    };
    child.on('error', (error) => {
        log.error('ACP agent process error', error);
    });
    child.on('exit', (code, signal) => {
        handleExit(code, signal);
    });
    function write(message) {
        if (exitInfo) {
            throw new Error(`ACP process is not running (code=${String(exitInfo.code)}, signal=${String(exitInfo.signal)})`);
        }
        const payload = JSON.stringify(message);
        if (payload.includes('\n')) {
            // JSON itself must be newline-delimited; embedded newlines here are a bug.
            throw new Error('ACP message serialization produced newline');
        }
        child.stdin.write(payload + '\n');
    }
    return {
        write,
        onMessage: (cb) => {
            messageHandlers.push(cb);
        },
        onStderr: (cb) => {
            stderrHandlers.push(cb);
        },
        onExit: (cb) => {
            exitHandlers.push(cb);
            if (exitInfo)
                cb(exitInfo);
        },
        kill: () => {
            child.kill('SIGTERM');
        },
    };
}
