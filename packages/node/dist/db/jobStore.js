import { randomUUID } from 'node:crypto';
export function listJobsForBinding(db, bindingKey) {
    return db
        .prepare(`
      SELECT job_id as jobId,
             binding_key as bindingKey,
             cron_expr as cronExpr,
             prompt_template as promptTemplate,
             enabled,
             created_at as createdAt,
             updated_at as updatedAt
        FROM jobs
       WHERE binding_key = ?
       ORDER BY created_at DESC
      `)
        .all(bindingKey);
}
export function createJob(db, params) {
    const jobId = randomUUID();
    const now = Date.now();
    db.prepare(`
    INSERT INTO jobs(job_id, binding_key, cron_expr, prompt_template, enabled, created_at, updated_at)
    VALUES(?, ?, ?, ?, 1, ?, ?)
    `).run(jobId, params.bindingKey, params.cronExpr, params.promptTemplate, now, now);
    return jobId;
}
export function deleteJob(db, jobId) {
    db.prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId);
}
export function setJobEnabled(db, jobId, enabled) {
    db.prepare('UPDATE jobs SET enabled = ?, updated_at = ? WHERE job_id = ?').run(enabled ? 1 : 0, Date.now(), jobId);
}
