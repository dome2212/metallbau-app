const express = require('express');
const router  = express.Router();
const { dbQuery }  = require('../utils/db');
const { hasPerm }  = require('../middleware/auth');
const { getFirma } = require('../utils/companySettings');

// ==========================================
// ARTIKEL-ÜBERSICHT
// ==========================================
router.get('/', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'articles', firma, true, false)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
  try {
    const result = await dbQuery('SELECT * FROM articles ORDER BY title ASC');
    res.render('articles', { articles: result.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// ARTIKEL HINZUFÜGEN
// ==========================================
router.post('/add', async (req, res) => {
  const { title, unit, unit_price, description } = req.body;
  const parsedPrice = String(unit_price).replace(',', '.');
  try {
    await dbQuery(
      `INSERT INTO articles (title, unit, unit_price, description) VALUES (?, ?, ?, ?)`,
      [title, unit, parseFloat(parsedPrice) || 0, description || null]
    );
    res.redirect('/articles');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// ARTIKEL BEARBEITEN
// ==========================================
router.post('/edit', async (req, res) => {
  const { id, title, unit, unit_price, description } = req.body;
  const parsedPrice = String(unit_price).replace(',', '.');
  try {
    await dbQuery(
      `UPDATE articles SET title = ?, unit = ?, unit_price = ?, description = ? WHERE id = ?`,
      [title, unit, parseFloat(parsedPrice) || 0, description || null, id]
    );
    res.redirect('/articles');
  } catch (err) {
    res.status(500).send('Fehler beim Aktualisieren');
  }
});

// ==========================================
// ARTIKEL LÖSCHEN
// ==========================================
router.post('/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM articles WHERE id = ?', [id]);
    res.redirect('/articles');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

module.exports = router;
