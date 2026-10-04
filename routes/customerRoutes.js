const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { CloudinaryStorage } = require('../utils/cloudinaryStorage');
const { v2: cloudinary }    = require('cloudinary');
const { dbQuery }           = require('../utils/db');
const { hasPerm }           = require('../middleware/auth');
const { getFirma }          = require('../utils/companySettings');
const { parseBuffer, rowsToCustomers, buildTemplateCsv } = require('../utils/customerImport');
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const upload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'metallbau-management', allowed_formats: ['jpg', 'png', 'jpeg', 'pdf', 'webp'] }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// ==========================================
// KUNDENLISTE
// ==========================================
router.get('/', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
  try {
    const result = await dbQuery('SELECT * FROM customers ORDER BY created_at DESC');
    res.render('customers', { customers: result.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// DUBLETTEN-PRÜFUNG (vor dem Anlegen eines Kunden)
// ==========================================
router.get('/check-duplicate', async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    const phoneDigits = (req.query.phone || '').replace(/\D/g, '');
    const companyName = (req.query.company_name || '').trim().toLowerCase();

    if (!email && !phoneDigits && !companyName) return res.json({ duplicates: [] });

    const result = await dbQuery('SELECT id, company_name, contact_person, email, phone FROM customers');
    const rows = result.rows || [];

    const duplicates = rows.filter(c => {
      const cEmail = (c.email || '').trim().toLowerCase();
      const cPhone = (c.phone || '').replace(/\D/g, '');
      const cName  = (c.company_name || '').trim().toLowerCase();
      return (email && cEmail && cEmail === email) ||
             (phoneDigits && cPhone && cPhone === phoneDigits) ||
             (companyName && cName && cName === companyName);
    }).slice(0, 5);

    res.json({ duplicates: duplicates.map(d => ({
      company_name: d.company_name, contact_person: d.contact_person, email: d.email, phone: d.phone
    })) });
  } catch (err) {
    res.json({ duplicates: [] }); // im Zweifel nicht blockieren
  }
});

// ==========================================
// KUNDE ANLEGEN
// ==========================================
router.post('/add', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) return res.status(403).send('Kein Zugriff');
  const { company_name, contact_person, email, phone, street, zip, city, customer_number } = req.body;
  try {
    await dbQuery(
      `INSERT INTO customers (company_name, contact_person, email, phone, street, zip, city, customer_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null, customer_number || null]
    );
    res.redirect('/customers');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// KUNDE BEARBEITEN
// ==========================================
router.post('/edit', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) return res.status(403).send('Kein Zugriff');
  const { id, company_name, contact_person, email, phone, street, zip, city, customer_number, ust_id, leitweg_id, notes } = req.body;
  try {
    await dbQuery(
      `UPDATE customers SET company_name = ?, contact_person = ?, email = ?, phone = ?, street = ?, zip = ?, city = ?, customer_number = ?,
        ust_id = ?, leitweg_id = ?, notes = COALESCE(?, notes) WHERE id = ?`,
      [company_name, contact_person, email, phone, street, zip, city, customer_number, ust_id || null, leitweg_id || null, notes || null, id]
    );
    res.redirect('/customers');
  } catch (err) {
    res.status(500).send('Fehler beim Aktualisieren');
  }
});

// ==========================================
// KUNDE LÖSCHEN
// ==========================================
router.post('/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM customers WHERE id = ?', [id]);
    res.redirect('/customers');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// PROJEKTE EINES KUNDEN
// ==========================================

// ==========================================
// KUNDENAKTE
// ==========================================
router.get('/:id', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/customers">← Zurück</a>');
  }
  const { id } = req.params;
  try {
    const custRes = await dbQuery('SELECT * FROM customers WHERE id = ?', [id]);
    const customer = custRes.rows?.[0];
    if (!customer) return res.status(404).send('Kunde nicht gefunden');

    const [offersRes, invoicesRes, deliveriesRes, projectsRes, filesRes] = await Promise.all([
      dbQuery(`SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'OFFER' ORDER BY created_at DESC`, [id]),
      dbQuery(`SELECT * FROM documents WHERE customer_id = ? AND doc_type IN ('INVOICE','CREDIT') ORDER BY created_at DESC`, [id]),
      dbQuery(`SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'DELIVERY' ORDER BY created_at DESC`, [id]).catch(() => ({ rows: [] })),
      dbQuery(`SELECT * FROM projects WHERE customer_id = ? ORDER BY created_at DESC`, [id]),
      dbQuery(`SELECT * FROM customer_files WHERE customer_id = ? ORDER BY created_at DESC`, [id]).catch(() => ({ rows: [] })),
    ]);

    res.render('customer-detail', {
      customer,
      offers: offersRes.rows || [],
      invoices: invoicesRes.rows || [],
      deliveries: deliveriesRes.rows || [],
      projects: projectsRes.rows || [],
      files: filesRes.rows || [],
      user: req.user,
      currentUser: req.user,
      firma
    });
  } catch (err) {
    console.error('Kundenakte:', err.message);
    res.status(500).send('Fehler beim Laden der Kundenakte: ' + err.message);
  }
});



router.post('/:id/edit', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) return res.status(403).send('403');
  const { id } = req.params;
  const { company_name, contact_person, email, phone, street, zip, city, customer_number, ust_id, leitweg_id, notes } = req.body;
  try {
    await dbQuery(
      `UPDATE customers SET company_name = ?, contact_person = ?, email = ?, phone = ?, street = ?, zip = ?, city = ?, customer_number = ?,
       ust_id = ?, leitweg_id = ?, notes = ? WHERE id = ?`,
      [company_name, contact_person, email, phone, street, zip, city, customer_number || null,
       ust_id || null, leitweg_id || null, notes || null, id]
    );
    res.redirect('/customers/' + id);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Fehler beim Speichern');
  }
});


router.get('/:id/projects', async (req, res) => {
  const { id } = req.params;
  try {
    const custRes  = await dbQuery('SELECT * FROM customers WHERE id = ?', [id]);
    const customer = custRes.rows[0];
    if (!customer) return res.status(404).send('Kunde nicht gefunden');

    const [offersRes, invoicesRes, appointmentsRes, filesRes] = await Promise.all([
      dbQuery("SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'OFFER' ORDER BY created_at DESC", [id]),
      dbQuery("SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'INVOICE' ORDER BY created_at DESC", [id]),
      dbQuery("SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC", [id]),
      dbQuery("SELECT * FROM customer_files WHERE customer_id = ? ORDER BY created_at DESC", [id])
    ]);

    res.render('customer-projects', {
      customer,
      offers:       offersRes.rows   || [],
      invoices:     invoicesRes.rows  || [],
      appointments: appointmentsRes.rows || [],
      files:        filesRes.rows    || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// DATEI-UPLOAD FÜR KUNDEN
// ==========================================
router.post('/:id/upload', upload.single('file'), async (req, res) => {
  const customer_id = req.params.id;
  if (!req.file) return res.redirect(`/customers/${customer_id}/projects`);
  try {
    await dbQuery(
      `INSERT INTO customer_files (customer_id, filename, original_name, file_type, file_url) VALUES (?, ?, ?, ?, ?)`,
      [customer_id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.path]
    );
  } catch (err) {
    console.error('Fehler beim Dateiupload:', err.message);
  }
  res.redirect(`/customers/${customer_id}/projects`);
});

// ==========================================
// DATEI LÖSCHEN
// ==========================================
router.post('/files/delete', async (req, res) => {
  const { file_id, customer_id } = req.body;
  try {
    await dbQuery('DELETE FROM customer_files WHERE id = ?', [file_id]);
  } catch (err) {
    console.error('Fehler beim Löschen der Kundendatei:', err.message);
  }
  res.redirect(`/customers/${customer_id}/projects`);
});



// ==========================================
// KUNDEN-IMPORT (Excel / CSV)
// ==========================================
router.get('/import', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) {
    return res.status(403).send('<h1>403</h1><a href="/customers">← Zurück</a>');
  }
  res.render('customer-import', {
    user: req.user,
    currentUser: req.user,
    firma,
    result: null,
    preview: null,
    error: null,
  });
});

router.get('/import/template', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) return res.status(403).send('403');
  const csv = buildTemplateCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kunden-import-vorlage.csv"');
  // BOM for Excel
  res.send('\uFEFF' + csv);
});

router.post('/import', importUpload.single('file'), async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) {
    return res.status(403).send('403');
  }
  try {
    if (!req.file) {
      return res.render('customer-import', { user: req.user, currentUser: req.user, firma, result: null, preview: null, error: 'Bitte eine Datei auswählen (CSV oder Excel).' });
    }
    const parsed = parseBuffer(req.file.buffer, req.file.originalname);
    const { customers, mapping, headers } = rowsToCustomers(parsed.headers, parsed.rows);

    // Bestehende Kunden für Duplikat-Check
    const existing = await dbQuery('SELECT id, company_name, email, customer_number FROM customers');
    const byNr = {};
    const byEmail = {};
    const byName = {};
    for (const e of (existing.rows || [])) {
      if (e.customer_number) byNr[String(e.customer_number).trim().toLowerCase()] = e;
      if (e.email) byEmail[String(e.email).trim().toLowerCase()] = e;
      if (e.company_name) byName[String(e.company_name).trim().toLowerCase()] = e;
    }

    const preview = customers.map(c => {
      let match = null;
      let matchReason = null;
      if (c.customer_number && byNr[c.customer_number.toLowerCase()]) {
        match = byNr[c.customer_number.toLowerCase()];
        matchReason = 'Kundennummer';
      } else if (c.email && byEmail[c.email.toLowerCase()]) {
        match = byEmail[c.email.toLowerCase()];
        matchReason = 'E-Mail';
      } else if (c.company_name && byName[c.company_name.toLowerCase()]) {
        match = byName[c.company_name.toLowerCase()];
        matchReason = 'Firmenname';
      }
      return { ...c, _matchId: match ? match.id : null, _matchReason: matchReason };
    });

    // Encode payload for confirm form
    const payload = Buffer.from(JSON.stringify(preview), 'utf8').toString('base64');

    res.render('customer-import', {
      user: req.user,
      currentUser: req.user,
      firma,
      result: null,
      preview,
      payload,
      headers,
      mapping,
      error: null,
      filename: req.file.originalname,
    });
  } catch (err) {
    console.error('Kunden-Import:', err.message);
    res.render('customer-import', {
      user: req.user,
      currentUser: req.user,
      firma,
      result: null,
      preview: null,
      error: err.message || 'Import fehlgeschlagen',
    });
  }
});

router.post('/import/confirm', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'customers', firma, true, false)) {
    return res.status(403).send('403');
  }
  try {
    const mode = (req.body.mode || 'skip') === 'update' ? 'update' : 'skip';
    const payload = req.body.payload || '';
    let rows;
    try {
      rows = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch (_) {
      return res.status(400).send('Ungültige Import-Daten. Bitte erneut hochladen.');
    }
    if (!Array.isArray(rows) || !rows.length) {
      return res.redirect('/customers/import');
    }

    let inserted = 0, updated = 0, skipped = 0;

    for (const c of rows) {
      const company_name = (c.company_name || '').trim() || null;
      const contact_person = (c.contact_person || '').trim() || null;
      const email = (c.email || '').trim() || null;
      const phone = (c.phone || '').trim() || null;
      const street = (c.street || '').trim() || null;
      const zip = (c.zip || '').trim() || null;
      const city = (c.city || '').trim() || null;
      const customer_number = (c.customer_number || '').trim() || null;
      const ust_id = (c.ust_id || '').trim() || null;
      const leitweg_id = (c.leitweg_id || '').trim() || null;
      const notes = (c.notes || '').trim() || null;

      if (!company_name && !contact_person && !customer_number) { skipped++; continue; }

      if (c._matchId) {
        if (mode === 'update') {
          await dbQuery(
            `UPDATE customers SET
              company_name = COALESCE(?, company_name),
              contact_person = COALESCE(?, contact_person),
              email = COALESCE(?, email),
              phone = COALESCE(?, phone),
              street = COALESCE(?, street),
              zip = COALESCE(?, zip),
              city = COALESCE(?, city),
              customer_number = COALESCE(?, customer_number),
              ust_id = COALESCE(?, ust_id),
              leitweg_id = COALESCE(?, leitweg_id),
              notes = COALESCE(?, notes)
             WHERE id = ?`,
            [company_name, contact_person, email, phone, street, zip, city, customer_number, ust_id, leitweg_id, notes, c._matchId]
          );
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      await dbQuery(
        `INSERT INTO customers (company_name, contact_person, email, phone, street, zip, city, customer_number, ust_id, leitweg_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_name, contact_person, email, phone, street, zip, city, customer_number, ust_id, leitweg_id, notes]
      );
      inserted++;
    }

    res.render('customer-import', {
      user: req.user,
      currentUser: req.user,
      firma,
      preview: null,
      result: { inserted, updated, skipped, total: rows.length },
      error: null,
    });
  } catch (err) {
    console.error('Kunden-Import confirm:', err.message);
    res.status(500).send('Import-Fehler: ' + err.message);
  }
});


module.exports = router;
