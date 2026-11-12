/**
 * utils/audit.js – Änderungsprotokoll
 * Schreibt wer wann was gemacht hat. Wirft nie: Protokollfehler blockiert die Aktion nicht.
 */
const { dbQuery } = require('./db');

async function logAudit(req, action, entity, entityId, label, details) {
  try {
    const u = (req && req.user) || {};
    const det = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
    await dbQuery(
      `INSERT INTO audit_log (user_id, username, action, entity, entity_id, entity_label, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.id || null, u.username || null, action, entity, entityId || null, label || null, det]
    );
  } catch (e) {
    console.error('⚠️ Audit-Log fehlgeschlagen:', e.message);
  }
}

async function listAudit({ limit = 100, entity = null, action = null } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  let sql = `SELECT * FROM audit_log WHERE 1=1`;
  const params = [];
  if (entity) { sql += ` AND entity = ?`; params.push(entity); }
  if (action) { sql += ` AND action LIKE ?`; params.push('%' + action + '%'); }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ${lim}`;
  const res = await dbQuery(sql, params);
  return res.rows || [];
}

function redirectWith(res, url, type, message) {
  const sep = url.includes('?') ? '&' : '?';
  return res.redirect(`${url}${sep}${type === 'error' ? 'error' : 'success'}=${encodeURIComponent(message)}`);
}

module.exports = { logAudit, listAudit, redirectWith };
