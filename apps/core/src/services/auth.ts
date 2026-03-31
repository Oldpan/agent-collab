import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { Db } from '@agent-collab/runtime-acp';

// Use bcryptjs for password hashing (pure JS, no native dependencies)
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UserSession {
  id: string;
  userId: string;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface InviteToken {
  id: string;
  token: string;
  used: boolean;
  expiresAt: number;
  createdAt: number;
  usedAt: number | null;
  usedBy: string | null;
}

export interface AuthResult {
  success: boolean;
  user?: User;
  session?: UserSession;
  error?: string;
}

// Generate a secure random token
function generateSecureToken(): string {
  return randomBytes(32).toString('hex');
}

// Hash password using bcrypt
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

// Verify password
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Check if setup is complete (has at least one admin user)
export function hasAdminUser(db: Db): boolean {
  const row = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get() as { count: number };
  return row.count > 0;
}

// Check if any users exist
export function hasAnyUser(db: Db): boolean {
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count > 0;
}

// Create initial admin user during setup
export async function createAdminUser(
  db: Db,
  username: string,
  password: string,
): Promise<AuthResult> {
  const now = Date.now();
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);

  try {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(userId, username, passwordHash, now, now);

    const user: User = {
      id: userId,
      username,
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
    };

    const session = createSession(db, userId);

    return { success: true, user, session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      return { success: false, error: 'Username already exists' };
    }
    return { success: false, error: message };
  }
}

// Create a new user (admin only)
export async function createUser(
  db: Db,
  username: string,
  password: string,
  isAdmin = false,
): Promise<AuthResult> {
  const now = Date.now();
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);

  try {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, username, passwordHash, isAdmin ? 1 : 0, now, now);

    const user: User = {
      id: userId,
      username,
      isAdmin,
      createdAt: now,
      updatedAt: now,
    };

    return { success: true, user };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      return { success: false, error: 'Username already exists' };
    }
    return { success: false, error: message };
  }
}

// Create a session for a user
export function createSession(db: Db, userId: string): UserSession {
  const now = Date.now();
  const sessionId = randomUUID();
  const token = generateSecureToken();
  const expiresAt = now + SESSION_EXPIRY_MS;

  db.prepare(
    `INSERT INTO user_sessions (id, user_id, token, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, userId, token, now, expiresAt, now);

  return {
    id: sessionId,
    userId,
    token,
    createdAt: now,
    expiresAt,
    lastUsedAt: now,
  };
}

// Validate session token
export function validateSession(db: Db, token: string): User | null {
  const now = Date.now();

  const sessionRow = db.prepare(
    `SELECT s.id as sessionId, s.user_id as userId, s.expires_at as expiresAt
     FROM user_sessions s
     WHERE s.token = ?`,
  ).get(token) as { sessionId: string; userId: string; expiresAt: number } | undefined;

  if (!sessionRow) return null;

  // Check if session is expired
  if (sessionRow.expiresAt && now > sessionRow.expiresAt) {
    // Delete expired session
    db.prepare('DELETE FROM user_sessions WHERE id = ?').run(sessionRow.sessionId);
    return null;
  }

  // Update last used time
  db.prepare('UPDATE user_sessions SET last_used_at = ? WHERE id = ?').run(now, sessionRow.sessionId);

  // Get user info
  const userRow = db.prepare(
    `SELECT id, username, is_admin, created_at, updated_at
     FROM users WHERE id = ?`,
  ).get(sessionRow.userId) as { id: string; username: string; is_admin: number; created_at: number; updated_at: number } | undefined;

  if (!userRow) return null;

  return {
    id: userRow.id,
    username: userRow.username,
    isAdmin: userRow.is_admin === 1,
    createdAt: userRow.created_at,
    updatedAt: userRow.updated_at,
  };
}

// Login user
export async function loginUser(
  db: Db,
  username: string,
  password: string,
): Promise<AuthResult> {
  const userRow = db.prepare(
    `SELECT id, username, password_hash, is_admin, created_at, updated_at
     FROM users WHERE username = ?`,
  ).get(username) as { id: string; username: string; password_hash: string; is_admin: number; created_at: number; updated_at: number } | undefined;

  if (!userRow) {
    return { success: false, error: 'Invalid credentials' };
  }

  const passwordValid = await verifyPassword(password, userRow.password_hash);
  if (!passwordValid) {
    return { success: false, error: 'Invalid credentials' };
  }

  const user: User = {
    id: userRow.id,
    username: userRow.username,
    isAdmin: userRow.is_admin === 1,
    createdAt: userRow.created_at,
    updatedAt: userRow.updated_at,
  };

  const session = createSession(db, userRow.id);

  return { success: true, user, session };
}

// Logout user (delete session)
export function logoutUser(db: Db, token: string): boolean {
  const result = db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  return result.changes > 0;
}

// Create an invite token
export function createInviteToken(db: Db): InviteToken {
  const now = Date.now();
  const id = randomUUID();
  const token = generateSecureToken();
  const expiresAt = now + INVITE_EXPIRY_MS;

  db.prepare(
    `INSERT INTO invite_tokens (id, token, used, expires_at, created_at, used_at, used_by)
     VALUES (?, ?, 0, ?, ?, NULL, NULL)`,
  ).run(id, token, expiresAt, now);

  return {
    id,
    token,
    used: false,
    expiresAt,
    createdAt: now,
    usedAt: null,
    usedBy: null,
  };
}

// Validate an invite token
export function validateInviteToken(db: Db, token: string): { valid: boolean; error?: string } {
  const now = Date.now();

  const row = db.prepare(
    `SELECT id, used, expires_at FROM invite_tokens WHERE token = ?`,
  ).get(token) as { id: string; used: number; expires_at: number } | undefined;

  if (!row) {
    return { valid: false, error: 'Invalid invite token' };
  }

  if (row.used === 1) {
    return { valid: false, error: 'Invite token has already been used' };
  }

  if (now > row.expires_at) {
    return { valid: false, error: 'Invite token has expired' };
  }

  return { valid: true };
}

// Mark invite token as used
export function useInviteToken(db: Db, token: string, userId: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE invite_tokens SET used = 1, used_at = ?, used_by = ? WHERE token = ?`,
  ).run(now, userId, token);
}

// Setup with invite token (for first admin)
export async function setupWithInvite(
  db: Db,
  token: string,
  username: string,
  password: string,
): Promise<AuthResult> {
  // Validate invite token
  const validation = validateInviteToken(db, token);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Create admin user
  const result = await createAdminUser(db, username, password);
  if (!result.success) {
    return result;
  }

  // Mark token as used
  if (result.user) {
    useInviteToken(db, token, result.user.id);
  }

  return result;
}

// Get user by ID
export function getUserById(db: Db, userId: string): User | null {
  const row = db.prepare(
    `SELECT id, username, is_admin, created_at, updated_at
     FROM users WHERE id = ?`,
  ).get(userId) as { id: string; username: string; is_admin: number; created_at: number; updated_at: number } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// List all users
export function listUsers(db: Db): User[] {
  const rows = db.prepare(
    `SELECT id, username, is_admin, created_at, updated_at
     FROM users ORDER BY created_at DESC`,
  ).all() as Array<{ id: string; username: string; is_admin: number; created_at: number; updated_at: number }>;

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// Delete user
export function deleteUser(db: Db, userId: string): boolean {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  if (result.changes > 0) {
    // Also delete all sessions for this user
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
    return true;
  }
  return false;
}

// Cleanup expired sessions and invite tokens
export function cleanupExpiredTokens(db: Db): void {
  const now = Date.now();
  db.prepare('DELETE FROM user_sessions WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  db.prepare('DELETE FROM invite_tokens WHERE expires_at < ?').run(now);
}

// Get agent IDs the user has been granted access to
export function getUserAgentAccess(db: Db, userId: string): string[] {
  const rows = db
    .prepare('SELECT agent_id FROM user_agent_access WHERE user_id = ?')
    .all(userId) as Array<{ agent_id: string }>;
  return rows.map((r) => r.agent_id);
}

// Get channel IDs the user has been granted access to
export function getUserChannelAccess(db: Db, userId: string): string[] {
  const rows = db
    .prepare('SELECT channel_id FROM user_channel_access WHERE user_id = ?')
    .all(userId) as Array<{ channel_id: string }>;
  return rows.map((r) => r.channel_id);
}

// Replace all access grants for a user atomically
export function setUserAccess(
  db: Db,
  userId: string,
  agentIds: string[],
  channelIds: string[],
): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_agent_access WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_channel_access WHERE user_id = ?').run(userId);
    const insertAgent = db.prepare(
      'INSERT INTO user_agent_access (user_id, agent_id, granted_at) VALUES (?, ?, ?)',
    );
    for (const agentId of agentIds) {
      insertAgent.run(userId, agentId, now);
    }
    const insertChannel = db.prepare(
      'INSERT INTO user_channel_access (user_id, channel_id, granted_at) VALUES (?, ?, ?)',
    );
    for (const channelId of channelIds) {
      insertChannel.run(userId, channelId, now);
    }
  });
  tx();
}
