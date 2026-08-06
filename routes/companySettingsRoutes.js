/**
 * Firmendaten-Einstellungen (Admin-Bereich)
 * GET  /admin/company-settings        → Einstellungsseite
 * POST /admin/company-settings        → Alle Textfelder speichern
 * POST /admin/company-settings/logo   → Logo hochladen (Cloudinary)
 * POST /admin/company-settings/logo-delete → Logo löschen
 */
const express   = require('express');
const router    = express.Router();
const multer    = require('multer');
const { Readable } = require('stream');
const { v2: cloudinary } = require('cloudinary');

const { requireAdmin }          = require('../middleware/auth');
const { getFirma, setFirmaValue, clearCache } = require('../utils/companySettings');

// Multer: nur im Arbeitsspeicher (kein Dateisystem nötig)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // max. 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt (JPG, PNG, SVG, …)'));
  }
});

// ── GET: Einstellungsseite ───────────────────────────────────────────────────
router.get('/company-settings', requireAdmin, async (req, res) => {
  try {
    const firma   = await getFirma();
    const success = req.query.saved === '1';
    res.render('company-settings', { firma, success });
  } catch (err) {
    console.error('Fehler beim Laden der Firmeneinstellungen:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ── POST: Textfelder speichern ───────────────────────────────────────────────
router.post('/company-settings', requireAdmin, async (req, res) => {
  const felder = [
    'name', 'nameKurz', 'slogan',
    'strasse', 'plzOrt',
    'tel', 'email', 'web',
    'iban', 'bic', 'bank', 'steuernr',
    'zahlungsfrist', 'angebotsgueltig',
    'sidebar_modus',       // 'text' oder 'logo'
    'sidebar_logo_height'  // px-Wert 40–200
  ];
  try {
    for (const key of felder) {
      const val = (req.body[key] ?? '').toString().trim();
      await setFirmaValue(key, val);
    }
    res.redirect('/admin/company-settings?saved=1');
  } catch (err) {
    console.error('Fehler beim Speichern der Firmeneinstellungen:', err.message);
    res.status(500).send('Fehler beim Speichern.');
  }
});

// ── POST: Logo hochladen ─────────────────────────────────────────────────────
router.post('/company-settings/logo', requireAdmin, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.redirect('/admin/company-settings?saved=1');

  try {
    // Altes Logo bei Cloudinary löschen
    const firma = await getFirma();
    if (firma.logo_url && firma.logo_url.includes('cloudinary')) {
      try {
        const parts  = firma.logo_url.split('/');
        const fname  = parts[parts.length - 1].split('.')[0];
        const folder = parts[parts.length - 2];
        await cloudinary.uploader.destroy(`${folder}/${fname}`);
      } catch (_) {} // Fehler beim Löschen ignorieren
    }

    // Neues Logo hochladen
    const url = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'firma_logo', resource_type: 'image', transformation: [{ width: 600, crop: 'limit' }] },
        (err, result) => err ? reject(err) : resolve(result.secure_url)
      );
      Readable.from(req.file.buffer).pipe(uploadStream);
    });

    await setFirmaValue('logo_url', url);
    res.redirect('/admin/company-settings?saved=1');
  } catch (err) {
    console.error('Fehler beim Logo-Upload:', err.message);
    res.status(500).send('Fehler beim Logo-Upload: ' + err.message);
  }
});

// ── POST: Sidebar-Logo hochladen ─────────────────────────────────────────────
router.post('/company-settings/sidebar-logo', requireAdmin, upload.single('sidebar_logo'), async (req, res) => {
  if (!req.file) return res.redirect('/admin/company-settings?saved=1');
  try {
    const firma = await getFirma();
    // Altes Sidebar-Logo löschen
    if (firma.sidebar_logo_url && firma.sidebar_logo_url.includes('cloudinary')) {
      const parts = firma.sidebar_logo_url.split('/');
      const fname = parts[parts.length - 1].split('.')[0];
      const folder = parts[parts.length - 2];
      await cloudinary.uploader.destroy(`${folder}/${fname}`).catch(() => {});
    }
    // Neues hochladen
    const url = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'sidebar_logo', resource_type: 'image', transformation: [{ width: 400, crop: 'limit' }] },
        (err, result) => err ? reject(err) : resolve(result.secure_url)
      );
      Readable.from(req.file.buffer).pipe(uploadStream);
    });
    await setFirmaValue('sidebar_logo_url', url);
    res.redirect('/admin/company-settings?saved=1');
  } catch (err) {
    console.error('Fehler beim Sidebar-Logo-Upload:', err.message);
    res.status(500).send('Fehler beim Sidebar-Logo-Upload: ' + err.message);
  }
});

// ── POST: Sidebar-Logo löschen ────────────────────────────────────────────────
router.post('/company-settings/sidebar-logo-delete', requireAdmin, async (req, res) => {
  try {
    const firma = await getFirma();
    if (firma.sidebar_logo_url && firma.sidebar_logo_url.includes('cloudinary')) {
      const parts = firma.sidebar_logo_url.split('/');
      const fname = parts[parts.length - 1].split('.')[0];
      const folder = parts[parts.length - 2];
      await cloudinary.uploader.destroy(`${folder}/${fname}`).catch(() => {});
    }
    await setFirmaValue('sidebar_logo_url', '');
    res.redirect('/admin/company-settings?saved=1');
  } catch (err) {
    console.error('Fehler beim Sidebar-Logo-Löschen:', err.message);
    res.status(500).send('Fehler beim Löschen.');
  }
});

// ── POST: Logo löschen ───────────────────────────────────────────────────────
router.post('/company-settings/logo-delete', requireAdmin, async (req, res) => {
  try {
    const firma = await getFirma();
    if (firma.logo_url && firma.logo_url.includes('cloudinary')) {
      const parts  = firma.logo_url.split('/');
      const fname  = parts[parts.length - 1].split('.')[0];
      const folder = parts[parts.length - 2];
      await cloudinary.uploader.destroy(`${folder}/${fname}`).catch(() => {});
    }
    await setFirmaValue('logo_url', '');
    res.redirect('/admin/company-settings?saved=1');
  } catch (err) {
    console.error('Fehler beim Logo-Löschen:', err.message);
    res.status(500).send('Fehler beim Löschen des Logos.');
  }
});

// ── GET: Admin-Panel ────────────────────────────────────────────────────────
router.get('/panel', requireAdmin, async (req, res) => {
  try {
    const firma   = await getFirma();
    const success = req.query.saved === '1';
    const tab     = req.query.tab || 'design';
    res.render('admin-panel', { firma, success, tab });
  } catch (err) {
    console.error('Fehler beim Laden des Admin-Panels:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ── POST: Admin-Panel Design-Einstellungen speichern ────────────────────────
router.post('/panel/design', requireAdmin, async (req, res) => {
  const felder = [
    'color_primary', 'color_sidebar_bg', 'color_sidebar_text',
    'color_sidebar_hover', 'color_topbar_bg', 'color_page_bg',
    'app_icon', 'dark_mode_default'
  ];
  try {
    for (const key of felder) {
      const val = (req.body[key] ?? '').toString().trim();
      if (val) await setFirmaValue(key, val);
    }
    res.redirect('/admin/panel?tab=design&saved=1');
  } catch (err) {
    console.error('Fehler beim Speichern der Design-Einstellungen:', err.message);
    res.status(500).send('Fehler beim Speichern.');
  }
});

// ── POST: Admin-Panel Feature-Schalter speichern ────────────────────────────
router.post('/panel/features', requireAdmin, async (req, res) => {
  const felder = ['feature_map', 'feature_lexikon', 'feature_treppe', 'feature_steel_calc', 'feature_ai'];
  try {
    for (const key of felder) {
      const val = req.body[key] === '1' ? 'true' : 'false';
      await setFirmaValue(key, val);
    }
    res.redirect('/admin/panel?tab=features&saved=1');
  } catch (err) {
    console.error('Fehler beim Speichern der Feature-Einstellungen:', err.message);
    res.status(500).send('Fehler beim Speichern.');
  }
});

// ── POST: Admin-Panel Sidebar-Einstellungen speichern ───────────────────────
router.post('/panel/sidebar', requireAdmin, async (req, res) => {
  const felder = ['nameKurz', 'app_icon', 'sidebar_modus', 'sidebar_logo_height'];
  try {
    for (const key of felder) {
      const val = (req.body[key] ?? '').toString().trim();
      await setFirmaValue(key, val);
    }
    res.redirect('/admin/panel?tab=sidebar&saved=1');
  } catch (err) {
    console.error('Fehler beim Speichern der Sidebar-Einstellungen:', err.message);
    res.status(500).send('Fehler beim Speichern.');
  }
});

module.exports = router;
