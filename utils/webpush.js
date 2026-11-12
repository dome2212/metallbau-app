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

const { dbQuery } = require('./db');   // gemeinsamer Helper (SQLite + PostgreSQL)
const { addNotification } = require('./notifications');   // In-App-Glocke

/**
 * Send a push notification to all stored subscriptions.
 * Silently drops expired/invalid subscriptions (410 Gone).
 *
 * Jede Meldung landet zusätzlich in der Glocke (In-App), unabhängig davon, ob
 * Push eingerichtet ist. opts.inApp === false überspringt das (z.B. Fallback-Aufruf).
 *
 * @param {object} payload  { title, body, url }
 * @param {number|null} userId  If set, only notify this user; otherwise all.
 * @param {{inApp?:boolean}} opts
 */
async function sendPush(payload, userId = null, opts = {}) {
  if (!opts || opts.inApp !== false) {
    addNotification(payload, userId).catch(e => console.error('⚠️ In-App-Benachrichtigung:', e.message));
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { sent: 0, failed: 0, total: 0, configured: false };
  const result = { sent: 0, failed: 0, total: 0, configured: true };

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
    return result;
  }
  result.total = subs.length;

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
      result.sent++;
    } catch (err) {
      result.failed++;
      if ([410, 404, 401, 403].includes(err.statusCode)) {
        // Subscription expired – clean up
        try { await dbQuery('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]); } catch (e) { console.error('⚠️ sendPush:', e.message); }
      } else {
        console.error('sendPush error for', sub.endpoint, ':', err.message);
      }
    }
  }
  return result;
}

module.exports = { sendPush, VAPID_PUBLIC };
