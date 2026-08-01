const express = require('express');
const router = express.Router();
const db = require('../config/database');

let PDFKit;
try { PDFKit = require('pdfkit'); } catch (e) {}

const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    if (pgSql.trim().toUpperCase().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) pgSql += ' RETURNING id';
    db.query(pgSql, params, (err, res) => {
      if (err) return reject(err);
      resolve({ rows: res.rows || [], lastID: res.rows?.[0]?.id });
    });
  });
};

// Offers
router.get('/offers', async (req, res) => {
  const offersRes = await dbQuery(`SELECT documents.*, customers.company_name, customers.contact_person FROM documents LEFT JOIN customers ON documents.customer_id = customers.id WHERE doc_type = 'OFFER' ORDER BY documents.created_at DESC`);
  const customersRes = await dbQuery('SELECT * FROM customers');
  const articlesRes = await dbQuery('SELECT * FROM articles ORDER BY title ASC');
  res.render('offers', { offers: offersRes.rows, customers: customersRes.rows, articles: articlesRes.rows });
});

router.post('/create-offer', async (req, res) => {
  let { customer_id, title, quantity, unit, price } = req.body;
  const docNumber = 'ANG-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
  const titles = Array.isArray(title) ? title : [title];
  const quantities = Array.isArray(quantity) ? quantity : [quantity];
  const units = Array.isArray(unit) ? unit : [unit];
  const prices = Array.isArray(price) ? price : [price];

  let totalAmount = 0;
  const items = [];
  for (let i = 0; i < titles.length; i++) {
    if (!titles[i]?.trim()) continue;
    const q = parseFloat(String(quantities[i] || '1').replace(',', '.')) || 1;
    const p = parseFloat(String(prices[i] || '0').replace(',', '.')) || 0;
    totalAmount += q * p;
    items.push({ description: titles[i], quantity: q, unit: units[i] || 'Stk', price: p });
  }

  const offerRes = await dbQuery(`INSERT INTO documents (doc_type, doc_number, customer_id, total_amount, status) VALUES ('OFFER', ?, ?, ?, 'GESENDET')`, [docNumber, customer_id, totalAmount]);
  for (const item of items) {
    await dbQuery('INSERT INTO offer_items (offer_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)', [offerRes.lastID, item.description, item.quantity, item.unit, item.price]);
  }
  res.redirect('/documents/offers');
});

router.post('/offers/delete', async (req, res) => {
  await dbQuery(`DELETE FROM offer_items WHERE offer_id = ?`, [req.body.offer_id]);
  await dbQuery(`DELETE FROM documents WHERE id = ? AND doc_type = 'OFFER'`, [req.body.offer_id]);
  res.redirect('/documents/offers');
});

router.post('/offers/convert-to-invoice', async (req, res) => {
  const offerRes = await dbQuery("SELECT * FROM documents WHERE id = ? AND doc_type = 'OFFER'", [req.body.offer_id]);
  const offer = offerRes.rows[0];
  if (!offer) return res.status(404).send('Nicht gefunden');

  const invoiceNumber = 'RE-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
  const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + 14);

  const invRes = await dbQuery(`INSERT INTO invoices (invoice_number, customer_id, total_amount, status, due_date) VALUES (?, ?, ?, 'Gesendet', ?)`,
    [invoiceNumber, offer.customer_id, offer.total_amount, dueDate.toISOString().split('T')[0]]);
  
  const itemsRes = await dbQuery('SELECT * FROM offer_items WHERE offer_id = ?', [req.body.offer_id]);
  for (const item of (itemsRes.rows.length ? itemsRes.rows : [{ description: 'Angebot #' + offer.doc_number, quantity: 1, unit: 'Psch', price: offer.total_amount }])) {
    await dbQuery('INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)', [invRes.lastID, item.description, item.quantity, item.unit, item.price]);
  }
  await dbQuery("UPDATE documents SET status = 'ANGENOMMEN' WHERE id = ?", [req.body.offer_id]);
  res.redirect('/documents/invoices/' + invRes.lastID);
});

// Invoices
router.get('/invoices', async (req, res) => {
  const statusFilter = req.query.status;
  let sql = `SELECT invoices.*, customers.company_name, customers.contact_person FROM invoices LEFT JOIN customers ON invoices.customer_id = customers.id`;
  let params = [];
  if (statusFilter && statusFilter !== 'Alle') { sql += " WHERE invoices.status = ?"; params.push(statusFilter); }
  sql += " ORDER BY invoices.created_at DESC";

  const [invRes, custRes, artRes] = await Promise.all([dbQuery(sql, params), dbQuery('SELECT * FROM customers ORDER BY company_name ASC'), dbQuery('SELECT * FROM articles ORDER BY title ASC')]);
  res.render('invoices', { invoices: invRes.rows, customers: custRes.rows, articles: artRes.rows, currentStatus: statusFilter || 'Alle' });
});

router.post('/create-invoice', async (req, res) => {
  let { customer_id, title, quantity, unit, price, due_days } = req.body;
  const invoiceNumber = 'RE-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
  const titles = Array.isArray(title) ? title : [title];
  const quantities = Array.isArray(quantity) ? quantity : [quantity];
  const units = Array.isArray(unit) ? unit : [unit];
  const prices = Array.isArray(price) ? price : [price];

  let totalAmount = 0;
  const items = [];
  for (let i = 0; i < titles.length; i++) {
    if (!titles[i]?.trim()) continue;
    const q = parseFloat(String(quantities[i] || '1').replace(',', '.')) || 1;
    const p = parseFloat(String(prices[i] || '0').replace(',', '.')) || 0;
    totalAmount += q * p;
    items.push({ description: titles[i], quantity: q, unit: units[i] || 'Stk', price: p });
  }

  const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + parseInt(due_days || '14', 10));
  const invRes = await dbQuery(`INSERT INTO invoices (invoice_number, customer_id, total_amount, status, due_date) VALUES (?, ?, ?, 'Gesendet', ?)`,
    [invoiceNumber, customer_id, totalAmount, dueDate.toISOString().split('T')[0]]);

  for (const item of items) {
    await dbQuery('INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)', [invRes.lastID, item.description, item.quantity, item.unit, item.price]);
  }
  res.redirect('/documents/invoices');
});

router.get('/invoices/:id', async (req, res) => {
  const invRes = await dbQuery(`SELECT invoices.*, customers.* FROM invoices LEFT JOIN customers ON invoices.customer_id = customers.id WHERE invoices.id = ?`, [req.params.id]);
  const invoice = invRes.rows[0];
  if (!invoice) return res.status(404).send('Nicht gefunden');
  const itemsRes = await dbQuery('SELECT * FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
  res.render('invoice-detail', { invoice, items: itemsRes.rows });
});

router.get('/invoices/:id/pdf', async (req, res) => {
  const invRes = await dbQuery(`SELECT invoices.*, customers.* FROM invoices LEFT JOIN customers ON invoices.customer_id = customers.id WHERE invoices.id = ?`, [req.params.id]);
  const invoice = invRes.rows[0];
  if (!invoice) return res.status(404).send('Nicht gefunden');
  const itemsRes = await dbQuery('SELECT * FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
  res.render('invoice-pdf', { invoice, items: itemsRes.rows });
});

router.post('/invoices/update-status', async (req, res) => {
  await dbQuery(`UPDATE invoices SET status = ?, status_note = ? WHERE id = ?`, [req.body.status, req.body.status_note || null, req.body.invoice_id]);
  res.redirect('/documents/invoices');
});

router.post('/invoices/increase-dunning', async (req, res) => {
  await dbQuery(`UPDATE invoices SET dunning_level = dunning_level + 1, status = 'Überfällig' WHERE id = ?`, [req.body.invoice_id]);
  res.redirect('/documents/invoices');
});

router.post('/invoices/delete', async (req, res) => {
  await dbQuery(`DELETE FROM invoice_items WHERE invoice_id = ?`, [req.body.invoice_id]);
  await dbQuery(`DELETE FROM invoices WHERE id = ?`, [req.body.invoice_id]);
  res.redirect('/documents/invoices');
});

module.exports = router;
