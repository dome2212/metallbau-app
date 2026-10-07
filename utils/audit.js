/**
 * utils/audit.js – Änderungsprotokoll
 * Schreibt wer wann was gemacht hat (Löschen, Wiederherstellen, Material, Stunden …).
 * Wirft nie: ein Protokollfehler darf die eigentliche Aktion nicht kaputt machen.
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

/** Redirect mit Toast-Meldung (nutzt die vorhandenen ?error= / ?success= Parameter der Header-Partial) */
function redirectWith(res, url, type, message) {
  const sep = url.includes('?') ? '&' : '?';
  return res.redirect(`${url}${sep}${type === 'error' ? 'error' : 'success'}=${encodeURIComponent(message)}`);
}

module.exports = { logAudit, redirectWith };
