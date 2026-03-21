export function getUiMode(db, bindingKey) {
    const row = db
        .prepare('SELECT mode FROM ui_prefs WHERE binding_key = ?')
        .get(bindingKey);
    if (!row)
        return null;
    return row.mode === 'summary' ? 'summary' : 'verbose';
}
export function setUiMode(db, bindingKey, mode) {
    const now = Date.now();
    db.prepare(`
    INSERT INTO ui_prefs(binding_key, mode, created_at, updated_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(binding_key) DO UPDATE SET
      mode = excluded.mode,
      updated_at = excluded.updated_at
    `).run(bindingKey, mode, now, now);
}
