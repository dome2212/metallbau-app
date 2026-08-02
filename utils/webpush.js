/**
 * utils/webpush.js
 * Web-Push helper: VAPID setup + sendPushToAll / sendPushToUser helpers.
 */
const webpush = require('web-push');
const db = require('../config/database');

// ── VAPID ─────────────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@metallbau.local';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('⚠️  Web-Push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY fehlen – Push-Benachrichtigungen deaktiviert.');
}

// ── DB helper ─────────────────────────────────────────────────────────────────
const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    db.query(pgSql, params, (err, res) => {
      if (err) return reject(err);
      resolve({ rows: res.rows || [] });
    });
  });
};

/**
 * Send a push notification to all stored subscriptions.
 * Silently drops expired/invalid subscriptions (410 Gone).
 *
 * @param {object} payload  { title, body, url }
 * @param {number|null} userId  If set, only notify this user; otherwise all.
 */
async function sendPush(payload, userId = null) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  let query = 'SELECT * FROM push_subscriptions';
  const params = [];
  if (userId) {
    query += ' WHERE user_id = ?';
    params.push(userId);
  }

  let subs;
  try {
    subs = (await dbQuery(query, params)).rows;
  } catch (e) {
    console.error('sendPush: DB-Fehler beim Laden der Subscriptions:', e.message);
    return;
  }

  const notification = JSON.stringify({
    title: payload.title || 'Metallbau-App',
    body:  payload.body  || '',
    url:   payload.url   || '/',
    icon:  '/img/icon-192.png'
  });

  for (const sub of subs) {
    let subscription;
    try {
      subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth:   sub.auth
        }
      };
      await webpush.sendNotification(subscription, notification);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired – clean up
        try { await dbQuery('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]); } catch (_) {}
      } else {
        console.error('sendPush error for', sub.endpoint, ':', err.message);
      }
    }
  }
}

module.exports = { sendPush, VAPID_PUBLIC };
