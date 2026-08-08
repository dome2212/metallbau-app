const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { requireAdmin }    = require('../middleware/auth');
const { sendWhatsApp }    = require('../utils/notifier');

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

router.get('/', async (req, res) => {
  const result = await dbQuery(
    `SELECT tickers.*, TO_CHAR(tickers.created_at, 'DD.MM.YYYY HH24:MI') as formatted_date FROM tickers ORDER BY created_at DESC`
  );
  res.render('ticker', { tickers: result.rows, user: req.user });
});

router.post('/add', async (req, res) => {
  const message = req.body.message?.trim();
  if (!message) return res.redirect('/ticker');

  const author = req.user?.username || 'Unbekannt';
  await dbQuery('INSERT INTO tickers (message, author) VALUES (?, ?)', [message, author]);

  // WhatsApp-Benachrichtigung an alle Mitarbeiter mit aktiviertem Notify
  try {
    const users = await dbQuery(
      `SELECT whatsapp_phone, whatsapp_api_key FROM users
       WHERE whatsapp_notify = true
         AND whatsapp_phone  IS NOT NULL
         AND whatsapp_api_key IS NOT NULL`
    );
    const text = `📌 Neue Pinnwand-Meldung von ${author}:\n\n${message}`;
    for (const u of users.rows) {
      sendWhatsApp(u.whatsapp_phone, text, u.whatsapp_api_key).catch(() => {});
    }
  } catch (_) {}

  const back = req.headers.referer || '/ticker';
  res.redirect(back);
});

router.post('/delete', requireAdmin, async (req, res) => {
  await dbQuery('DELETE FROM tickers WHERE id = ?', [req.body.id]);
  const back = req.headers.referer || '/ticker';
  res.redirect(back);
});

module.exports = router;
