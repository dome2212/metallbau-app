const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { CloudinaryStorage } = require('../utils/cloudinaryStorage');
const { v2: cloudinary }    = require('cloudinary');
const { dbQuery }           = require('../utils/db');
const { hasPerm }           = require('../middleware/auth');
const { getFirma }          = require('../utils/companySettings');

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
// KUNDE ANLEGEN
// ==========================================
router.post('/add', async (req, res) => {
  const { company_name, contact_person, email, phone, street, zip, city } = req.body;
  try {
    await dbQuery(
      `INSERT INTO customers (company_name, contact_person, email, phone, street, zip, city) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null]
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
  const { id, company_name, contact_person, email, phone, street, zip, city } = req.body;
  try {
    await dbQuery(
      `UPDATE customers SET company_name = ?, contact_person = ?, email = ?, phone = ?, street = ?, zip = ?, city = ? WHERE id = ?`,
      [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null, id]
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

module.exports = router;
