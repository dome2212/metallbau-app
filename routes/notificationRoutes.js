/**
 * routes/notificationRoutes.js  (eingehängt unter /notifications, Login erforderlich)
 *   GET  /notifications           → { unread, items: [...] } für die Glocke
 *   POST /notifications/read-all  → alle eigenen Meldungen als gelesen markieren
 *   POST /notifications/:id/read  → eine Meldung als gelesen markieren
 * Jeder Benutzer sieht und ändert ausschließlich seine eigenen Meldungen.
 */
const express = require('express');
const router  = express.Router();
const notifications = require('../utils/notifications');

function fail(res, where, err) {
  console.error('notifications ' + where + ':', err && err.message);
  res.status(500).json({ error: 'Benachrichtigungen konnten nicht verarbeitet werden.' });
}

router.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await notifications.listForUser(req.user.id));
  } catch (err) { fail(res, 'laden', err); }
});

router.post('/read-all', async (req, res) => {
  try {
    await notifications.markAllRead(req.user.id);
    res.json({ ok: true });
  } catch (err) { fail(res, 'read-all', err); }
});

router.post('/:id(\\d+)/read', async (req, res) => {
  try {
    await notifications.markRead(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) { fail(res, 'read', err); }
});

module.exports = router;
