import type { Db } from './db.js';

const LATEST_VERSION = 9;

export function migrate(db: Db): void {
  db.exec(
    `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    INSERT INTO schema_version(version)
    SELECT 0
    WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    `,
  );

  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;

  if (current > LATEST_VERSION) {
    throw new Error(`DB schema version ${current} is newer than app`);
  }

  if (current < 1) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        agent_command TEXT NOT NULL,
        agent_args_json TEXT NOT NULL,
        acp_session_id TEXT,
        load_supported INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bindings (
        binding_key TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_key) REFERENCES sessions(session_key)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        stop_reason TEXT,
        error TEXT,
        FOREIGN KEY(session_key) REFERENCES sessions(session_key)
      );

      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq),
        FOREIGN KEY(run_id) REFERENCES runs(run_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        binding_key TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key)
      );

      UPDATE schema_version SET version = 1;
      `,
    );
  }

  if (current < 2) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS tool_policies (
        binding_key TEXT NOT NULL,
        tool_kind TEXT NOT NULL,
        policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(binding_key, tool_kind),
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key)
      );

      UPDATE schema_version SET version = 2;
      `,
    );
  }

  if (current < 3) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS delivery_checkpoints (
        binding_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,
        text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(binding_key, run_id),
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key),
        FOREIGN KEY(run_id) REFERENCES runs(run_id)
      );

      UPDATE schema_version SET version = 3;
      `,
    );
  }

  if (current < 4) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS ui_prefs (
        binding_key TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(binding_key),
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key)
      );

      UPDATE schema_version SET version = 4;
      `,
    );
  }

  if (current < 5) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS tool_allow_prefixes (
        binding_key TEXT NOT NULL,
        tool_kind TEXT NOT NULL,
        arg_prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(binding_key, tool_kind, arg_prefix),
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_allow_prefixes_binding_kind
      ON tool_allow_prefixes(binding_key, tool_kind);

      UPDATE schema_version SET version = 5;
      `,
    );
  }

  if (current < 6) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        agent_type TEXT NOT NULL DEFAULT 'claude_acp',
        workspace_path TEXT,
        session_key TEXT REFERENCES sessions(session_key),
        status TEXT NOT NULL DEFAULT 'idle',
        env_vars TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

      UPDATE schema_version SET version = 6;
      `,
    );
  }

  if (current < 7) {
    // env_vars 列已在 v6 建表中包含（新DB），仅对旧DB做 ALTER
    const cols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    const hasEnvVars = cols.some((c) => c.name === 'env_vars');
    if (!hasEnvVars) {
      db.exec(`ALTER TABLE conversations ADD COLUMN env_vars TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 7;`);
  }

  if (current < 8) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL,
        agent_types_json TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online',
        last_seen INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      UPDATE schema_version SET version = 8;
      `,
    );
  }

  if (current < 9) {
    const nowMs = Date.now();

    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id     TEXT PRIMARY KEY,
        name           TEXT NOT NULL UNIQUE,
        workspace_path TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
    `);

    db.prepare(
      `INSERT OR IGNORE INTO channels(channel_id, name, workspace_path, created_at, updated_at)
       VALUES(?, ?, NULL, ?, ?)`,
    ).run('default', 'default', nowMs, nowMs);

    // Add channel_id to conversations; back-fill existing rows to 'default'
    const convCols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    if (!convCols.some((c) => c.name === 'channel_id')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN channel_id TEXT REFERENCES channels(channel_id);`);
    }
    db.exec(`UPDATE conversations SET channel_id = 'default' WHERE channel_id IS NULL;`);

    // Fix up existing web bindings: old key was web:{convId}:-:web_user
    // new key is web:{channelId}:{convId}:{agentType}
    // Join conversations to bindings via session_key to rebuild the key
    const oldBindings = db.prepare(`
      SELECT b.binding_key, c.id as convId, c.agent_type as agentType
      FROM bindings b
      JOIN conversations c ON c.session_key = b.session_key
      WHERE b.platform = 'web'
    `).all() as Array<{ binding_key: string; convId: string; agentType: string }>;

    const updateBinding = db.prepare(
      `UPDATE bindings SET binding_key = ?, chat_id = ?, thread_id = ?, user_id = ?
       WHERE binding_key = ?`,
    );
    for (const row of oldBindings) {
      const newKey = `web:default:${row.convId}:${row.agentType}`;
      if (newKey !== row.binding_key) {
        updateBinding.run(newKey, 'default', row.convId, row.agentType, row.binding_key);
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_channel
        ON conversations(channel_id, updated_at DESC);

      UPDATE schema_version SET version = 9;
    `);
  }
}
