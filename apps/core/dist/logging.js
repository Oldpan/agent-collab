const levelOrder = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
const currentLevel = process.env.LOG_LEVEL ?? 'info';
function shouldLog(level) {
    return levelOrder[level] >= levelOrder[currentLevel];
}
export const log = {
    debug: (...args) => {
        if (shouldLog('debug'))
            console.log('[debug]', ...args);
    },
    info: (...args) => {
        if (shouldLog('info'))
            console.log('[info]', ...args);
    },
    warn: (...args) => {
        if (shouldLog('warn'))
            console.warn('[warn]', ...args);
    },
    error: (...args) => {
        if (shouldLog('error'))
            console.error('[error]', ...args);
    },
};
