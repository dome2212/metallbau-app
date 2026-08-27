/**
 * routes/colorsRoutes.js
 * -----------------------
 * Farben-Bibliothek: RAL-Farben mit Hex-Vorschau und optionalem Foto vom
 * echten Muster (z.B. Pulverbeschichtungs-Probe, lackiertes Blechstück).
 */
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { CloudinaryStorage } = require('../utils/cloudinaryStorage');
const { v2: cloudinary }    = require('cloudinary');
const { dbQuery } = require('../utils/db');

const upload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'metallbau-management/ral-farben', allowed_formats: ['jpg', 'jpeg', 'png', 'webp'] }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ==========================================
// FARBEN-BIBLIOTHEK ANZEIGEN
// ==========================================
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let items;
    if (q) {
      const r = await dbQuery(
        `SELECT * FROM ral_colors WHERE LOWER(ral_code) LIKE ? OR LOWER(name) LIKE ?
         ORDER BY favorit DESC, ral_code ASC`,
        [`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`]
      );
      items = r.rows || [];
    } else {
      const r = await dbQuery(`SELECT * FROM ral_colors ORDER BY favorit DESC, ral_code ASC`);
      items = r.rows || [];
    }
    res.render('farben', { items, q });
  } catch (err) {
    console.error('Farben-Bibliothek Fehler:', err);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// FARBE HINZUFÜGEN
// ==========================================
router.post('/add', async (req, res) => {
  const { ral_code, name, hex, notiz } = req.body;
  try {
    if (!ral_code || !hex) return res.status(400).send('RAL-Code und Hex-Wert erforderlich');
    await dbQuery(
      `INSERT INTO ral_colors (ral_code, name, hex, notiz) VALUES (?, ?, ?, ?)`,
      [ral_code.trim(), (name || '').trim() || null, hex.trim(), (notiz || '').trim() || null]
    );
    res.redirect('/farben');
  } catch (err) {
    console.error('Farbe hinzufügen Fehler:', err);
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// FOTO-MUSTER HOCHLADEN
// ==========================================
router.post('/:id/foto', upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Kein Foto hochgeladen');
    await dbQuery(`UPDATE ral_colors SET foto_url = ? WHERE id = ?`, [req.file.path, req.params.id]);
    res.redirect('/farben');
  } catch (err) {
    console.error('Foto-Upload Fehler:', err);
    res.status(500).send('Fehler beim Hochladen: ' + err.message);
  }
});

// ==========================================
// FOTO ENTFERNEN
// ==========================================
router.post('/:id/foto-delete', async (req, res) => {
  try {
    await dbQuery(`UPDATE ral_colors SET foto_url = NULL WHERE id = ?`, [req.params.id]);
    res.redirect('/farben');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// FAVORIT UMSCHALTEN
// ==========================================
router.post('/:id/favorit', async (req, res) => {
  try {
    const r = await dbQuery(`SELECT favorit FROM ral_colors WHERE id = ?`, [req.params.id]);
    const current = r.rows[0]?.favorit ? 1 : 0;
    await dbQuery(`UPDATE ral_colors SET favorit = ? WHERE id = ?`, [current ? 0 : 1, req.params.id]);
    res.redirect('/farben');
  } catch (err) {
    res.status(500).send('Fehler');
  }
});

// ==========================================
// NOTIZ BEARBEITEN
// ==========================================
router.post('/:id/edit', async (req, res) => {
  const { name, notiz } = req.body;
  try {
    await dbQuery(`UPDATE ral_colors SET name = ?, notiz = ? WHERE id = ?`, [(name || '').trim() || null, (notiz || '').trim() || null, req.params.id]);
    res.redirect('/farben');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// FARBE LÖSCHEN
// ==========================================
router.post('/:id/delete', async (req, res) => {
  try {
    await dbQuery(`DELETE FROM ral_colors WHERE id = ?`, [req.params.id]);
    res.redirect('/farben');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

module.exports = router;
