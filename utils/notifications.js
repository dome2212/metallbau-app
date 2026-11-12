/**
 * utils/notifications.js
 * ─────────────────────────────────────────────────────────────────────────────
 * In-App-Benachrichtigungen (Glocke in der Top-Bar).
 *
 * Jede Meldung, die per sendPush() (utils/webpush.js) verschickt wird, wird
 * zusätzlich hier gespeichert – so erscheinen Aufgaben, Termine, Urlaubsanträge,
 * Pinnwand, neue Aufträge, Lager-Warnungen usw. automatisch in der Glocke,
 * auch bei Mitarbeitern ohne aktiviertes Push.
 *
 * Zeitstempel liegen als Epoch-Millisekunden (created_ms / read_ms) in der DB –
 * das ist in SQLite und PostgreSQL eindeutig und braucht keine Zeitzonen-Logik.
 */

const { dbQuery } = require('./db');

const KEEP_DAYS   = 30;              // ältere Meldungen werden automatisch gelöscht
const MAX_LIST    = 30;              // so viele zeigt die Glocke an
const DEDUPE_MS   = 2 * 60 * 1000;   // identische Meldung an dieselbe Person nur 1x pro 2 Min.

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// Nur interne Pfade zulassen (kein javascript:, keine fremden Domains).
function safeUrl(url) {
  const u = String(url || '').trim();
  return /^\/(?!\/)\S*$/.test(u) ? u.slice(0, 300) : '/';
}

async function recipientIds(userId) {
  if (userId != null && userId !== '') return [Number(userId)];
  const r = await dbQuery('SELECT id FROM users');
  return (r.rows || []).map(row => Number(row.id));
}

/**
 * Meldung speichern.
 * @param {{title?:string, body?:string, url?:string}} payload
 * @param {number|null} userId  null = an alle Benutzer
 * @returns {Promise<number>} Anzahl neu angelegter Meldungen
 */
async function addNotification(payload, userId = null) {
  const p = payload || {};
  const title = clean(p.title, 160) || 'Metallbau-App';
  const body  = clean(p.body, 500);
  const url   = safeUrl(p.url);
  const now   = Date.now();

  let created = 0;
  for (const uid of await recipientIds(userId)) {
    if (!Number.isFinite(uid)) continue;
    const dup = await dbQuery(
      'SELECT id FROM notifications WHERE user_id = ? AND title = ? AND body = ? AND created_ms > ? LIMIT 1',
      [uid, title, body, now - DEDUPE_MS]
    );
    if (dup.rows.length) continue;
    await dbQuery(
      'INSERT INTO notifications (user_id, title, body, url, created_ms) VALUES (?, ?, ?, ?, ?)',
      [uid, title, body, url, now]
    );
    created++;
  }
  return created;
}

async function unreadCount(userId) {
  const r = await dbQuery(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_ms IS NULL',
    [userId]
  );
  return Number(r.rows[0] && r.rows[0].n) || 0;
}

/** Neueste Meldungen + Anzahl ungelesener für die Glocke. */
async function listForUser(userId, limit = MAX_LIST) {
  const r = await dbQuery(
    `SELECT id, title, body, url, created_ms, read_ms
       FROM notifications
      WHERE user_id = ?
      ORDER BY created_ms DESC, id DESC
      LIMIT ?`,
    [userId, Math.min(Math.max(parseInt(limit, 10) || MAX_LIST, 1), 100)]
  );
  return {
    unread: await unreadCount(userId),
    items: (r.rows || []).map(row => ({
      id:        Number(row.id),
      title:     row.title,
      body:      row.body || '',
      url:       row.url || '/',
      createdAt: Number(row.created_ms),
      read:      row.read_ms != null,
    })),
  };
}

async function markRead(userId, id) {
  await dbQuery(
    'UPDATE notifications SET read_ms = ? WHERE id = ? AND user_id = ? AND read_ms IS NULL',
    [Date.now(), Number(id), userId]
  );
}

async function markAllRead(userId) {
  await dbQuery(
    'UPDATE notifications SET read_ms = ? WHERE user_id = ? AND read_ms IS NULL',
    [Date.now(), userId]
  );
}

async function purgeOld() {
  await dbQuery('DELETE FROM notifications WHERE created_ms < ?', [Date.now() - KEEP_DAYS * 86400000]);
}

/** Beim Serverstart aufrufen: räumt sofort und danach alle 6 Stunden auf. */
function startCleanup() {
  const run = () => purgeOld().catch(e => console.error('⚠️ Benachrichtigungen aufräumen:', e.message));
  run();
  const timer = setInterval(run, 6 * 3600 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  addNotification, listForUser, unreadCount, markRead, markAllRead, purgeOld, startCleanup,
  KEEP_DAYS, MAX_LIST,
};
