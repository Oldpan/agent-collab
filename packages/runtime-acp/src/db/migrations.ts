import type { Db } from './db.js';

const LATEST_VERSION = 43;

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

  if (current < 10) {
    db.exec(`ALTER TABLE conversations ADD COLUMN node_id TEXT NULL;`);
    db.exec(`UPDATE schema_version SET version = 10;`);
  }

  if (current < 11) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id       TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        agent_type     TEXT NOT NULL DEFAULT 'claude_acp',
        system_prompt  TEXT NOT NULL DEFAULT '',
        memory         TEXT NOT NULL DEFAULT '',
        env_vars       TEXT,
        node_id        TEXT,
        workspace_path TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agents_updated ON agents(updated_at DESC);

      UPDATE schema_version SET version = 11;
    `);
    db.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(agent_id);`);
  }

  if (current < 12) {
    db.exec(`ALTER TABLE agents ADD COLUMN channel_id TEXT NOT NULL DEFAULT 'default' REFERENCES channels(channel_id);`);
    db.exec(`UPDATE schema_version SET version = 12;`);
  }

  if (current < 13) {
    db.exec(`ALTER TABLE nodes ADD COLUMN display_name TEXT;`);
    db.exec(`ALTER TABLE nodes ADD COLUMN env_var_keys TEXT;`);
    db.exec(`ALTER TABLE nodes ADD COLUMN provisioned_at INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`UPDATE schema_version SET version = 13;`);
  }

  if (current < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_dispatch_queue (
        run_id          TEXT PRIMARY KEY,
        host_key        TEXT NOT NULL,
        session_key     TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        state           TEXT NOT NULL DEFAULT 'queued',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_node_dispatch_queue_host
        ON node_dispatch_queue(host_key, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_node_dispatch_queue_state
        ON node_dispatch_queue(state, created_at ASC);

      UPDATE schema_version SET version = 14;
    `);
  }

  if (current < 15) {
    const convCols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    if (!convCols.some((c) => c.name === 'thread_kind')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'direct';`);
    }
    if (!convCols.some((c) => c.name === 'is_primary_thread')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN is_primary_thread INTEGER NOT NULL DEFAULT 0;`);
    }

    db.exec(`UPDATE conversations SET thread_kind = 'direct' WHERE thread_kind IS NULL OR thread_kind = '';`);
    db.exec(`UPDATE conversations SET is_primary_thread = 0 WHERE is_primary_thread IS NULL;`);

    const rows = db.prepare(
      `SELECT id, agent_id as agentId
       FROM conversations
       WHERE agent_id IS NOT NULL
       ORDER BY updated_at DESC, created_at DESC`
    ).all() as Array<{ id: string; agentId: string }>;
    const seen = new Set<string>();
    const promote = db.prepare(
      `UPDATE conversations SET thread_kind = 'direct', is_primary_thread = 1 WHERE id = ?`,
    );
    const demote = db.prepare(
      `UPDATE conversations SET thread_kind = 'branch', is_primary_thread = 0 WHERE id = ?`,
    );
    for (const row of rows) {
      if (seen.has(row.agentId)) {
        demote.run(row.id);
      } else {
        promote.run(row.id);
        seen.add(row.agentId);
      }
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_agent_primary ON conversations(agent_id, is_primary_thread, updated_at DESC);`);
    db.exec(`UPDATE schema_version SET version = 15;`);
  }

  if (current < 16) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_prompt_queue (
        queue_id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id         TEXT NOT NULL,
        conversation_id  TEXT NOT NULL,
        prompt_text      TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_prompt_queue_agent
        ON conversation_prompt_queue(agent_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_conversation_prompt_queue_conversation
        ON conversation_prompt_queue(conversation_id, created_at ASC);

      UPDATE schema_version SET version = 16;
    `);
  }

  if (current < 17) {
    const agentCols = db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === 'disabled_tool_kinds')) {
      db.exec(`ALTER TABLE agents ADD COLUMN disabled_tool_kinds TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 17;`);
  }

  if (current < 18) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        message_id   TEXT PRIMARY KEY,
        channel_id   TEXT NOT NULL,
        sender_id    TEXT NOT NULL,
        sender_name  TEXT NOT NULL,
        sender_type  TEXT NOT NULL,
        target       TEXT NOT NULL,
        content      TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, seq);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_target  ON channel_messages(target, seq);
    `);
    db.exec(`UPDATE schema_version SET version = 18;`);
  }

  if (current < 19) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id              TEXT PRIMARY KEY,
        channel_id           TEXT NOT NULL,
        task_number          INTEGER NOT NULL,
        title                TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'todo',
        claimed_by_agent_id  TEXT,
        claimed_by_name      TEXT,
        created_by_agent_id  TEXT,
        created_by_name      TEXT,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        UNIQUE(channel_id, task_number)
      );
    `);
    db.exec(`UPDATE schema_version SET version = 19;`);
  }

  if (current < 20) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_message_checkpoints (
        agent_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_seq   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, channel_id)
      );
    `);
    db.exec(`UPDATE schema_version SET version = 20;`);
  }

  if (current < 21) {
    const channelMessageCols = db.prepare("PRAGMA table_info('channel_messages')").all() as Array<{ name: string }>;
    if (!channelMessageCols.some((c) => c.name === 'run_id')) {
      db.exec(`ALTER TABLE channel_messages ADD COLUMN run_id TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_messages_run ON channel_messages(run_id, created_at);`);
    db.exec(`UPDATE schema_version SET version = 21;`);
  }

  if (current < 22) {
    const cols = db.prepare("PRAGMA table_info('channel_messages')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'thread_root_id')) {
      db.exec(`ALTER TABLE channel_messages ADD COLUMN thread_root_id TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_messages_thread ON channel_messages(channel_id, thread_root_id);`);
    db.exec(`UPDATE schema_version SET version = 22;`);
  }

  if (current < 23) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_channel_memberships (
        agent_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        is_home    INTEGER NOT NULL DEFAULT 0,
        joined_at  INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_channel
        ON agent_channel_memberships(channel_id, joined_at);
    `);
    // Backfill from existing agents.channel_id
    db.exec(`
      INSERT OR IGNORE INTO agent_channel_memberships(agent_id, channel_id, is_home, joined_at)
      SELECT agent_id, channel_id, 1, created_at FROM agents;
    `);
    // Add description to channels
    const channelCols = db.prepare("PRAGMA table_info('channels')").all() as Array<{ name: string }>;
    if (!channelCols.some((c) => c.name === 'description')) {
      db.exec(`ALTER TABLE channels ADD COLUMN description TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 23;`);
  }

  if (current < 24) {
    const queueCols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all() as Array<{ name: string }>;
    if (!queueCols.some((c) => c.name === 'record_as_user_message')) {
      db.exec(`ALTER TABLE conversation_prompt_queue ADD COLUMN record_as_user_message INTEGER NOT NULL DEFAULT 1;`);
    }
    db.exec(`UPDATE schema_version SET version = 24;`);
  }

  if (current < 25) {
    const convCols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    if (!convCols.some((c) => c.name === 'thread_root_id')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN thread_root_id TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_agent_channel_thread ON conversations(agent_id, channel_id, thread_kind, thread_root_id, updated_at DESC);`);
    db.exec(`UPDATE schema_version SET version = 25;`);
  }

  if (current < 26) {
    const checkpointCols = db.prepare("PRAGMA table_info('agent_message_checkpoints')").all() as Array<{ name: string }>;
    const hasThreadRootId = checkpointCols.some((c) => c.name === 'thread_root_id');

    if (!hasThreadRootId) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_message_checkpoints_v2 (
          agent_id       TEXT NOT NULL,
          channel_id     TEXT NOT NULL,
          thread_root_id TEXT NOT NULL DEFAULT '',
          last_seq       INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (agent_id, channel_id, thread_root_id)
        );
      `);
      db.exec(`
        INSERT INTO agent_message_checkpoints_v2(agent_id, channel_id, thread_root_id, last_seq)
        SELECT agent_id, channel_id, '', last_seq
        FROM agent_message_checkpoints;
      `);
      db.exec(`DROP TABLE agent_message_checkpoints;`);
      db.exec(`ALTER TABLE agent_message_checkpoints_v2 RENAME TO agent_message_checkpoints;`);
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_message_checkpoints_v2 (
          agent_id       TEXT NOT NULL,
          channel_id     TEXT NOT NULL,
          thread_root_id TEXT NOT NULL DEFAULT '',
          last_seq       INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (agent_id, channel_id, thread_root_id)
        );
      `);
      db.exec(`
        INSERT OR REPLACE INTO agent_message_checkpoints_v2(agent_id, channel_id, thread_root_id, last_seq)
        SELECT agent_id, channel_id, COALESCE(thread_root_id, ''), last_seq
        FROM agent_message_checkpoints;
      `);
      db.exec(`DROP TABLE agent_message_checkpoints;`);
      db.exec(`ALTER TABLE agent_message_checkpoints_v2 RENAME TO agent_message_checkpoints;`);
    }

    db.exec(`UPDATE schema_version SET version = 26;`);
  }

  if (current < 27) {
    const channelMessageCols = db.prepare("PRAGMA table_info('channel_messages')").all() as Array<{ name: string }>;
    if (!channelMessageCols.some((c) => c.name === 'message_kind')) {
      db.exec(`ALTER TABLE channel_messages ADD COLUMN message_kind TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 27;`);
  }

  if (current < 28) {
    const channelMessageCols = db.prepare("PRAGMA table_info('channel_messages')").all() as Array<{ name: string }>;
    if (!channelMessageCols.some((c) => c.name === 'message_source')) {
      db.exec(`ALTER TABLE channel_messages ADD COLUMN message_source TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 28;`);
  }

  if (current < 29) {
    const conversationCols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    if (!conversationCols.some((c) => c.name === 'reply_target')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN reply_target TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_reply_target ON conversations(reply_target, updated_at DESC);`);
    db.exec(`UPDATE schema_version SET version = 29;`);
  }

  if (current < 30) {
    const queueCols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all() as Array<{ name: string }>;
    if (!queueCols.some((c) => c.name === 'activation_context_text')) {
      db.exec(`ALTER TABLE conversation_prompt_queue ADD COLUMN activation_context_text TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 30;`);
  }

  if (current < 31) {
    const channelCols = db.prepare("PRAGMA table_info('channels')").all() as Array<{ name: string }>;
    if (!channelCols.some((c) => c.name === 'collaboration_mode')) {
      db.exec(`ALTER TABLE channels ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'mention_only';`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS target_participants (
        agent_id       TEXT NOT NULL,
        channel_id     TEXT NOT NULL,
        thread_root_id TEXT NOT NULL DEFAULT '',
        role           TEXT NOT NULL DEFAULT 'participant',
        joined_at      INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id, thread_root_id)
      );

      CREATE INDEX IF NOT EXISTS idx_target_participants_target
        ON target_participants(channel_id, thread_root_id, last_active_at DESC);
    `);

    db.exec(`UPDATE schema_version SET version = 31;`);
  }

  if (current < 32) {
    const taskCols = db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === 'description')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN description TEXT;`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_task_bindings (
        channel_id     TEXT NOT NULL,
        thread_root_id TEXT NOT NULL,
        task_id        TEXT NOT NULL UNIQUE,
        bound_at       INTEGER NOT NULL,
        PRIMARY KEY (channel_id, thread_root_id)
      );

      CREATE INDEX IF NOT EXISTS idx_thread_task_bindings_task
        ON thread_task_bindings(task_id);
    `);

    db.exec(`UPDATE schema_version SET version = 32;`);
  }

  if (current < 33) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_subscriptions (
        channel_id      TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        subscribed_at   INTEGER NOT NULL,
        last_active_at  INTEGER NOT NULL,
        PRIMARY KEY (channel_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_channel
        ON channel_subscriptions(channel_id, last_active_at DESC);
    `);

    db.exec(`UPDATE schema_version SET version = 33;`);
  }

  if (current < 34) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_mention_cooldowns (
        channel_id        TEXT NOT NULL,
        thread_root_id    TEXT NOT NULL,
        from_agent_id     TEXT NOT NULL,
        to_agent_id       TEXT NOT NULL,
        last_notified_at  INTEGER NOT NULL,
        PRIMARY KEY (channel_id, thread_root_id, from_agent_id, to_agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_mention_cooldowns_target
        ON agent_mention_cooldowns(channel_id, thread_root_id, last_notified_at DESC);
    `);

    db.exec(`UPDATE schema_version SET version = 34;`);
  }

  if (current < 36) {
    // Users table for authentication
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    `);

    // Invite tokens for initial setup and new user invitations
    db.exec(`
      CREATE TABLE IF NOT EXISTS invite_tokens (
        id TEXT PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by TEXT REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_expires ON invite_tokens(expires_at);
    `);

    // User sessions for authentication
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    `);

    db.exec(`UPDATE schema_version SET version = 36;`);
  }

  if (current < 37) {
    // Add sender_name to conversation_prompt_queue so queued messages preserve the sender identity
    const cols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'sender_name')) {
      db.exec(`ALTER TABLE conversation_prompt_queue ADD COLUMN sender_name TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 37;`);
  }

  if (current < 38) {
    const agentCols = db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === 'skill_roots')) {
      db.exec(`ALTER TABLE agents ADD COLUMN skill_roots TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 38;`);
  }

  if (current < 39) {
    const agentCols = db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === 'description')) {
      db.exec(`ALTER TABLE agents ADD COLUMN description TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = 39;`);
  }

  if (current < 40) {
    // Per-user access control: which agents/channels each user can see
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_agent_access (
        user_id    TEXT NOT NULL REFERENCES users(id)           ON DELETE CASCADE,
        agent_id   TEXT NOT NULL REFERENCES agents(agent_id)    ON DELETE CASCADE,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS user_channel_access (
        user_id    TEXT NOT NULL REFERENCES users(id)              ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(channel_id)   ON DELETE CASCADE,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );
    `);
    db.exec(`UPDATE schema_version SET version = 40;`);
  }

  if (current < 41) {
    // Per-user DM conversations: each (agent, user) pair gets its own conversation
    db.exec(`
      ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    `);
    db.exec(`UPDATE schema_version SET version = 41;`);
  }

  if (current < 42) {
    // Task-Thread unified: each task links to the channel_messages row that IS its thread root
    db.exec(`
      ALTER TABLE tasks ADD COLUMN message_id TEXT REFERENCES channel_messages(message_id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_message_id ON tasks(message_id);
    `);
    db.exec(`UPDATE schema_version SET version = 42;`);
  }

  if (current < 43) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_message_sequences (
        channel_id TEXT PRIMARY KEY,
        next_seq   INTEGER NOT NULL
      );

      INSERT INTO channel_message_sequences(channel_id, next_seq)
      SELECT channel_id, MAX(seq) + 1
      FROM channel_messages
      GROUP BY channel_id
      ON CONFLICT(channel_id) DO NOTHING;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_channel_seq_unique
        ON channel_messages(channel_id, seq);
    `);
    db.exec(`UPDATE schema_version SET version = 43;`);
  }
}
