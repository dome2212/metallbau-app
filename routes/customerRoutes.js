const express = require('express');
const router = express.Router();
const db = require('../config/database');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { v2: cloudinary } = require('cloudinary');

const storage = new CloudinaryStorage({ cloudinary, params: { folder: 'metallbau-management', allowed_formats: ['jpg', 'png', 'jpeg', 'pdf', 'webp'] } });
const upload = multer({ storage });

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
  const result = await dbQuery('SELECT * FROM customers ORDER BY created_at DESC');
  res.render('customers', { customers: result.rows });
});

router.post('/add', async (req, res) => {
  const { company_name, contact_person, email, phone, street, zip, city } = req.body;
  await dbQuery(`INSERT INTO customers (company_name, contact_person, email, phone, street, zip, city) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null]);
  res.redirect('/customers');
});

router.post('/edit', async (req, res) => {
  const { id, company_name, contact_person, email, phone, street, zip, city } = req.body;
  await dbQuery(`UPDATE customers SET company_name = ?, contact_person = ?, email = ?, phone = ?, street = ?, zip = ?, city = ? WHERE id = ?`,
    [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null, id]);
  res.redirect('/customers');
});

router.post('/delete', async (req, res) => {
  await dbQuery('DELETE FROM customers WHERE id = ?', [req.body.id]);
  res.redirect('/customers');
});

router.get('/:id/projects', async (req, res) => {
  const { id } = req.params;
  const custRes = await dbQuery('SELECT * FROM customers WHERE id = ?', [id]);
  const customer = custRes.rows[0];
  if (!customer) return res.status(404).send('Nicht gefunden');

  const [offersRes, invoicesRes, appointmentsRes, filesRes] = await Promise.all([
    dbQuery("SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'OFFER' ORDER BY created_at DESC", [id]),
    dbQuery("SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC", [id]),
    dbQuery("SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC", [id]),
    dbQuery("SELECT * FROM customer_files WHERE customer_id = ? ORDER BY created_at DESC", [id])
  ]);

  res.render('customer-projects', { customer, offers: offersRes.rows, invoices: invoicesRes.rows, appointments: appointmentsRes.rows, files: filesRes.rows });
});

router.post('/:id/upload', upload.single('file'), async (req, res) => {
  if (req.file) {
    await dbQuery(`INSERT INTO customer_files (customer_id, filename, original_name, file_type, file_url) VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.path]);
  }
  res.redirect(`/customers/${req.params.id}/projects`);
});

router.post('/files/delete', async (req, res) => {
  await dbQuery('DELETE FROM customer_files WHERE id = ?', [req.body.file_id]);
  res.redirect(`/customers/${req.body.customer_id}/projects`);
});

module.exports = router;
