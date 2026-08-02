const express = require('express');
const router = express.Router();
const dbQuery = require('../utils/dbQuery');
const { requireAdmin } = require('../middleware/auth');

router.get('/', async (req, res) => {
  // FIX: Timezone-Konvertierung ergänzt, damit das Datum wie im Rest der App
  // in deutscher Ortszeit statt UTC angezeigt wird.
  const result = await dbQuery(`
    SELECT tickers.*,
           TO_CHAR(tickers.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY HH24:MI') as formatted_date
    FROM tickers ORDER BY created_at DESC
  `);
  res.render('ticker', { tickers: result.rows, user: req.user });
});

router.post('/add', async (req, res) => {
  if (req.body.message?.trim()) {
    await dbQuery('INSERT INTO tickers (message, author) VALUES (?, ?)', [req.body.message.trim(), req.user?.username || 'Unbekannt']);
  }
  res.redirect('/ticker');
});

router.post('/delete', requireAdmin, async (req, res) => {
  await dbQuery('DELETE FROM tickers WHERE id = ?', [req.body.id]);
  res.redirect('/ticker');
});

module.exports = router;
