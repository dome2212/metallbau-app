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

// Hilfsfunktion: mehrere Felder aus req.body speichern
async function saveFields(body, keys) {
  for (const key of keys) {
    const val = (body[key] ?? '').toString().trim();
    await setFirmaValue(key, val);
  }
}
// Hilfsfunktion: Boolean-Checkboxen speichern (robust gegen Array-Werte durch hidden+checkbox)
async function saveCheckboxes(body, keys) {
  for (const key of keys) {
    const raw = body[key];
    const checked = Array.isArray(raw) ? raw.includes('1') || raw.includes('true') : raw === '1' || raw === 'true';
    await setFirmaValue(key, checked ? 'true' : 'false');
  }
}

// ── POST: Design ─────────────────────────────────────────────────────────────
router.post('/panel/design', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, [
      'color_primary','color_sidebar_bg','color_sidebar_text',
      'color_sidebar_hover','color_topbar_bg','color_page_bg',
      'app_icon','dark_mode_default'
    ]);
    res.redirect('/admin/panel?tab=design&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Features ────────────────────────────────────────────────────────────
router.post('/panel/features', requireAdmin, async (req, res) => {
  try {
    await saveCheckboxes(req.body, ['feature_map','feature_lexikon','feature_treppe','feature_steel_calc','feature_ai']);
    res.redirect('/admin/panel?tab=features&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Sidebar ─────────────────────────────────────────────────────────────
router.post('/panel/sidebar', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, ['nameKurz','app_icon','sidebar_modus','sidebar_logo_height','sidebar_footer_text']);
    res.redirect('/admin/panel?tab=sidebar&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: PDF & Dokumente ─────────────────────────────────────────────────────
router.post('/panel/pdf', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, [
      'invoice_prefix','offer_prefix','default_tax_rate','default_payment_method',
      'pdf_color','pdf_footer_text','pdf_agb_text','pdf_intro_offer','pdf_intro_invoice'
    ]);
    res.redirect('/admin/panel?tab=pdf&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Arbeitszeit ─────────────────────────────────────────────────────────
router.post('/panel/worktime', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, [
      'work_hours_per_day','vacation_days_default',
      'break_auto_minutes','break_trigger_hours','holiday_region'
    ]);
    res.redirect('/admin/panel?tab=worktime&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Aufträge & Projekte ─────────────────────────────────────────────────
router.post('/panel/projects', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, ['project_number_prefix','default_project_status','archive_after_days']);
    res.redirect('/admin/panel?tab=projects&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Sicherheit ──────────────────────────────────────────────────────────
router.post('/panel/security', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, ['session_timeout_minutes','max_login_attempts','min_password_length']);
    res.redirect('/admin/panel?tab=security&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Lokalisierung ───────────────────────────────────────────────────────
router.post('/panel/locale', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, ['currency_symbol','date_format','timezone']);
    res.redirect('/admin/panel?tab=locale&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Dashboard KPI-Schwellen ─────────────────────────────────────────────
router.post('/panel/dashboard', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, ['kpi_overdue_warn','kpi_overdue_danger','kpi_tasks_warn','kpi_tasks_danger']);
    res.redirect('/admin/panel?tab=dashboard&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Stempeluhr ─────────────────────────────────────────────────────────
router.post('/panel/stampclock', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, ['firm_lat','firm_lng','firm_radius']);
    const toggles = ['stamp_require_gps','stamp_allow_project','stamp_geofence_enabled',
                     'stamp_allow_note','stamp_allow_switch','stamp_admin_no_gps'];
    for (const key of toggles) {
      // req.body[key] kann ein Array sein ['false','true'] wenn Checkbox gecheckt ist
      // (hidden field sendet 'false', Checkbox sendet 'true' — beide landen im Body)
      const raw = req.body[key];
      const checked = Array.isArray(raw) ? raw.includes('true') : raw === 'true';
      await setFirmaValue(key, checked ? 'true' : 'false');
    }
    res.redirect('/admin/panel?tab=stampclock&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: Zugriff & Berechtigungen ───────────────────────────────────────────
router.post('/panel/access', requireAdmin, async (req, res) => {
  try {
    const areas = ['projects','calendar','timetracking','vacations','customers',
                   'documents','articles','map','treppe','steel_calc','money'];
    for (const key of areas) {
      for (const role of ['admin','employee']) {
        const fieldName = `perm_${role}_${key}`;
        const raw = req.body[fieldName];
        const checked = Array.isArray(raw) ? raw.includes('true') : raw === 'true';
        await setFirmaValue(fieldName, checked ? 'true' : 'false');
      }
    }
    res.redirect('/admin/panel?tab=access&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── POST: E-Mail / SMTP / Backup-Einstellungen ────────────────────────────────
router.post('/panel/notifications', requireAdmin, async (req, res) => {
  try {
    await saveFields(req.body, ['smtp_backup_email','smtp_host','smtp_port','smtp_user']);
    // Passwort nur speichern wenn ein neuer Wert eingegeben wurde
    const pass = (req.body.smtp_pass || '').trim();
    if (pass) await setFirmaValue('smtp_pass', pass);
    res.redirect('/admin/panel?tab=info&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

module.exports = router;
