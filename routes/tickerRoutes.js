const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    db.query(pgSql, params, (err, res) => {
      if (err) return reject(err);
      resolve({ rows: res.rows || [] });
    });
  });
};

router.get('/', async (req, res) => {
  const result = await dbQuery(`SELECT tickers.*, TO_CHAR(tickers.created_at, 'DD.MM.YYYY HH24:MI') as formatted_date FROM tickers ORDER BY created_at DESC`);
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
