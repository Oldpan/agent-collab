import { randomUUID, randomBytes } from 'node:crypto';
// Use bcryptjs for password hashing (pure JS, no native dependencies)
import bcrypt from 'bcryptjs';
const SALT_ROUNDS = 10;
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
// Generate a secure random token
function generateSecureToken() {
    return randomBytes(32).toString('hex');
}
// Hash password using bcrypt
export async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}
// Verify password
export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
// Check if setup is complete (has at least one admin user)
export function hasAdminUser(db) {
    const row = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get();
    return row.count > 0;
}
// Check if any users exist
export function hasAnyUser(db) {
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
    return row.count > 0;
}
// Create initial admin user during setup
export async function createAdminUser(db, username, password) {
    const now = Date.now();
    const userId = randomUUID();
    const passwordHash = await hashPassword(password);
    try {
        db.prepare(`INSERT INTO users (id, username, password_hash, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`).run(userId, username, passwordHash, now, now);
        const user = {
            id: userId,
            username,
            isAdmin: true,
            createdAt: now,
            updatedAt: now,
        };
        const session = createSession(db, userId);
        return { success: true, user, session };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('UNIQUE constraint failed')) {
            return { success: false, error: 'Username already exists' };
        }
        return { success: false, error: message };
    }
}
// Create a new user (admin only)
export async function createUser(db, username, password, isAdmin = false) {
    const now = Date.now();
    const userId = randomUUID();
    const passwordHash = await hashPassword(password);
    try {
        db.prepare(`INSERT INTO users (id, username, password_hash, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`).run(userId, username, passwordHash, isAdmin ? 1 : 0, now, now);
        const user = {
            id: userId,
            username,
            isAdmin,
            createdAt: now,
            updatedAt: now,
        };
        return { success: true, user };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('UNIQUE constraint failed')) {
            return { success: false, error: 'Username already exists' };
        }
        return { success: false, error: message };
    }
}
// Create a session for a user
export function createSession(db, userId) {
    const now = Date.now();
    const sessionId = randomUUID();
    const token = generateSecureToken();
    const expiresAt = now + SESSION_EXPIRY_MS;
    db.prepare(`INSERT INTO user_sessions (id, user_id, token, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, userId, token, now, expiresAt, now);
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
export function validateSession(db, token) {
    const now = Date.now();
    const sessionRow = db.prepare(`SELECT s.id as sessionId, s.user_id as userId, s.expires_at as expiresAt
     FROM user_sessions s
     WHERE s.token = ?`).get(token);
    if (!sessionRow)
        return null;
    // Check if session is expired
    if (sessionRow.expiresAt && now > sessionRow.expiresAt) {
        // Delete expired session
        db.prepare('DELETE FROM user_sessions WHERE id = ?').run(sessionRow.sessionId);
        return null;
    }
    // Update last used time
    db.prepare('UPDATE user_sessions SET last_used_at = ? WHERE id = ?').run(now, sessionRow.sessionId);
    // Get user info
    const userRow = db.prepare(`SELECT id, username, is_admin, created_at, updated_at
     FROM users WHERE id = ?`).get(sessionRow.userId);
    if (!userRow)
        return null;
    return {
        id: userRow.id,
        username: userRow.username,
        isAdmin: userRow.is_admin === 1,
        createdAt: userRow.created_at,
        updatedAt: userRow.updated_at,
    };
}
// Login user
export async function loginUser(db, username, password) {
    const userRow = db.prepare(`SELECT id, username, password_hash, is_admin, created_at, updated_at
     FROM users WHERE username = ?`).get(username);
    if (!userRow) {
        return { success: false, error: 'Invalid credentials' };
    }
    const passwordValid = await verifyPassword(password, userRow.password_hash);
    if (!passwordValid) {
        return { success: false, error: 'Invalid credentials' };
    }
    const user = {
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
export function logoutUser(db, token) {
    const result = db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
    return result.changes > 0;
}
// Create an invite token
export function createInviteToken(db) {
    const now = Date.now();
    const id = randomUUID();
    const token = generateSecureToken();
    const expiresAt = now + INVITE_EXPIRY_MS;
    db.prepare(`INSERT INTO invite_tokens (id, token, used, expires_at, created_at, used_at, used_by)
     VALUES (?, ?, 0, ?, ?, NULL, NULL)`).run(id, token, expiresAt, now);
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
export function validateInviteToken(db, token) {
    const now = Date.now();
    const row = db.prepare(`SELECT id, used, expires_at FROM invite_tokens WHERE token = ?`).get(token);
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
export function useInviteToken(db, token, userId) {
    const now = Date.now();
    db.prepare(`UPDATE invite_tokens SET used = 1, used_at = ?, used_by = ? WHERE token = ?`).run(now, userId, token);
}
// Setup with invite token (for first admin)
export async function setupWithInvite(db, token, username, password) {
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
export function getUserById(db, userId) {
    const row = db.prepare(`SELECT id, username, is_admin, created_at, updated_at
     FROM users WHERE id = ?`).get(userId);
    if (!row)
        return null;
    return {
        id: row.id,
        username: row.username,
        isAdmin: row.is_admin === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
// List all users
export function listUsers(db) {
    const rows = db.prepare(`SELECT id, username, is_admin, created_at, updated_at
     FROM users ORDER BY created_at DESC`).all();
    return rows.map((row) => ({
        id: row.id,
        username: row.username,
        isAdmin: row.is_admin === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}
// Delete user
export function deleteUser(db, userId) {
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    if (result.changes > 0) {
        // Also delete all sessions for this user
        db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
        return true;
    }
    return false;
}
// Cleanup expired sessions and invite tokens
export function cleanupExpiredTokens(db) {
    const now = Date.now();
    db.prepare('DELETE FROM user_sessions WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
    db.prepare('DELETE FROM invite_tokens WHERE expires_at < ?').run(now);
}
