import type { Db } from '../db/db.js';
export declare function buildReplayContextFromRecentRuns(db: Db, params: {
    sessionKey: string;
    excludeRunId: string;
    maxRuns: number;
    maxChars: number;
}): string;
