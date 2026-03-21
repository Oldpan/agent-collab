import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
export function openDb(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}
