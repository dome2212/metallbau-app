const express = require('express');
const router = express.Router();
const db = require('../config/database');

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
  const result = await dbQuery('SELECT * FROM articles ORDER BY title ASC');
  res.render('articles', { articles: result.rows });
});

router.post('/add', async (req, res) => {
  const { title, unit, unit_price, description } = req.body;
  await dbQuery('INSERT INTO articles (title, unit, unit_price, description) VALUES (?, ?, ?, ?)',
    [title, unit, parseFloat(String(unit_price).replace(',', '.')) || 0, description || null]);
  res.redirect('/articles');
});

router.post('/delete', async (req, res) => {
  await dbQuery('DELETE FROM articles WHERE id = ?', [req.body.id]);
  res.redirect('/articles');
});

module.exports = router;
