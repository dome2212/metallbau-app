const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { requireOffice }    = require('../middleware/auth');
const { sendWhatsApp }    = require('../utils/notifier');
const { sendPush }        = require('../utils/webpush');

const { dbQuery } = require('../utils/db');   // gemeinsamer Helper (SQLite + PostgreSQL)

router.get('/', async (req, res) => {
  try {
    const result = await dbQuery(`SELECT tickers.* FROM tickers ORDER BY created_at DESC`);
    // Datum in Berlin-Zeit formatieren (SQLite liefert UTC-Text, PostgreSQL ein Date)
    const fmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const rows = result.rows.map(r => {
      const v = r.created_at;
      const d = v instanceof Date ? v : new Date(String(v).includes('T') || /[zZ+]/.test(String(v).slice(10)) ? v : String(v).replace(' ', 'T') + 'Z');
      return { ...r, formatted_date: isNaN(d) ? '' : fmt.format(d).replace(',', '') };
    });
    res.render('ticker', { tickers: rows, user: req.user });
  } catch (err) {
    console.error('Pinnwand laden:', err.message);
    res.status(500).send('Pinnwand konnte nicht geladen werden.');
  }
});

router.post('/add', async (req, res) => {
  const message = req.body.message?.trim();
  if (!message) return res.redirect('/ticker');

  const author = req.user?.username || 'Unbekannt';
  try {
    await dbQuery('INSERT INTO tickers (message, author) VALUES (?, ?)', [message, author]);
  } catch (err) {
    console.error('Pinnwand speichern:', err.message);
    return res.status(500).send('Meldung konnte nicht gespeichert werden.');
  }

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
      sendWhatsApp(u.whatsapp_phone, text, u.whatsapp_api_key).catch(e => console.error('⚠️ Benachrichtigung fehlgeschlagen:', e.message));
    }
  } catch (e) { console.error('⚠️ POST /add:', e.message); }

  // Push-Benachrichtigung an alle Mitarbeiter
  sendPush({
    title: '📌 Neue Pinnwand-Meldung',
    body:  `${author}: ${message}`,
    url:   '/ticker'
  }).catch(() => {});

  const back = req.headers.referer || '/ticker';
  res.redirect(back);
});

router.post('/delete', requireOffice, async (req, res) => {
  try { await dbQuery('DELETE FROM tickers WHERE id = ?', [req.body.id]); }
  catch (err) { console.error('Pinnwand löschen:', err.message); }
  const back = req.headers.referer || '/ticker';
  res.redirect(back);
});

module.exports = router;
