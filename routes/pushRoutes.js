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
const { VAPID_PUBLIC, sendPush } = require('../utils/webpush');

const { dbQuery } = require('../utils/db');   // gemeinsamer Helper (SQLite + PostgreSQL)

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

// Test-Benachrichtigung an die eigenen Geräte
router.post('/test', async (req, res) => {
  if (!VAPID_PUBLIC) return res.json({ ok: false, error: 'Push ist serverseitig nicht konfiguriert (VAPID-Schlüssel fehlen in der .env).' });
  const userId = req.user ? req.user.id : null;
  const r = await sendPush({ title: 'Test', body: 'Push-Benachrichtigungen funktionieren ✅', url: '/' }, userId);
  if (!r.total) return res.json({ ok: false, error: 'Kein Gerät registriert. Bitte Push zuerst aktivieren.' });
  if (!r.sent) return res.json({ ok: false, error: 'Zustellung fehlgeschlagen – Abo war veraltet und wurde entfernt. Push bitte erneut aktivieren.' });
  res.json({ ok: true, sent: r.sent });
});

module.exports = router;
