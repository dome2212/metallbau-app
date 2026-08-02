/**
 * routes/pushRoutes.js
 * Endpoints:
 *   GET  /push/vapid-public-key   → returns the VAPID public key for the client
 *   POST /push/subscribe          → stores a new push subscription
 *   POST /push/unsubscribe        → removes a push subscription
 */
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { VAPID_PUBLIC } = require('../utils/webpush');

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

// Return the VAPID public key so the client can call pushManager.subscribe()
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null });
});

// Save a new subscription (or update if endpoint already exists)
router.post('/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Ungültige Subscription-Daten' });
  }
  const userId = req.user ? req.user.id : null;

  try {
    // Upsert: update keys if endpoint already stored
    const existing = await dbQuery('SELECT id FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    if (existing.rows.length > 0) {
      await dbQuery(
        'UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_id = ? WHERE endpoint = ?',
        [keys.p256dh, keys.auth, userId, endpoint]
      );
    } else {
      await dbQuery(
        'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
        [userId, endpoint, keys.p256dh, keys.auth]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('push/subscribe DB error:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Remove a subscription
router.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    try {
      await dbQuery('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    } catch (e) { /* ignore */ }
  }
  res.json({ ok: true });
});

module.exports = router;
