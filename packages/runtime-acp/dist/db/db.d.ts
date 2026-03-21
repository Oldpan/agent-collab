import Database from 'better-sqlite3';
export type Db = Database.Database;
export declare function openDb(dbPath: string): Db;
