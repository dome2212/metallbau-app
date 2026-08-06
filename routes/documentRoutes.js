const express = require('express');
const router  = require('express').Router();
const { dbQuery }          = require('../utils/db');
const { requireAdmin, hasPerm } = require('../middleware/auth');
const { getFirma }         = require('../utils/companySettings');

// ══════════════════════════════════════════════════════════════
// ANGEBOTE
// ══════════════════════════════════════════════════════════════

// GET: Angebots-Übersicht
router.get('/offers', requireAdmin, async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'documents', firma, true, false)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
  try {
    const [offersRes, customersRes, articlesRes] = await Promise.all([
      dbQuery(`
        SELECT d.*, c.company_name, c.contact_person
        FROM documents d
        LEFT JOIN customers c ON d.customer_id = c.id
        WHERE d.doc_type = 'OFFER'
        ORDER BY d.created_at DESC`),
      dbQuery(`SELECT id, company_name, contact_person FROM customers ORDER BY company_name ASC`),
      dbQuery(`SELECT id, title, unit, unit_price, description FROM articles ORDER BY title ASC`)
    ]);
    res.render('offers', {
      offers:    offersRes.rows    || [],
      customers: customersRes.rows || [],
      articles:  articlesRes.rows  || []
    });
  } catch (err) {
    console.error('Fehler bei GET /documents/offers:', err.message);
    res.status(500).send('Fehler beim Laden der Angebote.');
  }
});

// POST: Neues Angebot anlegen
router.post('/create-offer', requireAdmin, async (req, res) => {
  const { customer_id, title: titles, quantity: quantities, unit: units, price: prices } = req.body;
  try {
    const firma    = await getFirma();
    const prefix   = (firma.offer_prefix || 'ANG').toUpperCase();
    const taxRate  = parseFloat(firma.default_tax_rate || 19);
    const year     = new Date().getFullYear();
    const countRes = await dbQuery(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'OFFER'`);
    const nextNum  = String((parseInt(countRes.rows[0]?.count || 0, 10)) + 1).padStart(4, '0');
    const docNumber = `${prefix}-${year}-${nextNum}`;

    // Positionen aufbauen
    const titleArr    = Array.isArray(titles)    ? titles    : (titles    ? [titles]    : []);
    const quantityArr = Array.isArray(quantities) ? quantities : (quantities ? [quantities] : []);
    const unitArr     = Array.isArray(units)      ? units      : (units      ? [units]      : []);
    const priceArr    = Array.isArray(prices)     ? prices     : (prices     ? [prices]     : []);

    let subtotal = 0;
    const items = titleArr.map((t, i) => {
      const q = parseFloat(quantityArr[i] || 1);
      const p = parseFloat(priceArr[i]    || 0);
      subtotal += q * p;
      return { description: t, quantity: q, unit: unitArr[i] || 'Stk', price: p };
    });
    const taxAmount   = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;

    const insertRes = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount)
       VALUES ('OFFER', ?, ?, 'OFFEN', ?, ?, ?, ?)`,
      [docNumber, customer_id, taxRate, subtotal, taxAmount, totalAmount]
    );
    const docId = insertRes.lastID || insertRes.rows?.[0]?.id;

    // Positionen speichern
    for (const item of items) {
      if (!item.description?.trim()) continue;
      await dbQuery(
        `INSERT INTO document_items (document_id, description, quantity, unit, price)
         VALUES (?, ?, ?, ?, ?)`,
        [docId, item.description, item.quantity, item.unit, item.price]
      );
    }
    res.redirect('/documents/offers');
  } catch (err) {
    console.error('Fehler bei POST /documents/create-offer:', err.message);
    res.status(500).send('Fehler beim Anlegen des Angebots.');
  }
});

// POST: Angebot löschen
router.post('/offers/delete', requireAdmin, async (req, res) => {
  const { offer_id } = req.body;
  try {
    await dbQuery(`DELETE FROM document_items WHERE document_id = ?`, [offer_id]);
    await dbQuery(`DELETE FROM documents WHERE id = ? AND doc_type = 'OFFER'`, [offer_id]);
    res.redirect('/documents/offers');
  } catch (err) {
    console.error('Fehler beim Löschen des Angebots:', err.message);
    res.status(500).send('Fehler beim Löschen.');
  }
});

// POST: Angebot → Rechnung umwandeln
router.post('/offers/convert-to-invoice', requireAdmin, async (req, res) => {
  const { offer_id } = req.body;
  try {
    const offerRes = await dbQuery(`SELECT * FROM documents WHERE id = ? AND doc_type = 'OFFER'`, [offer_id]);
    const offer    = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');

    const _firmaConv = await getFirma();
    const invPrefix  = (_firmaConv.invoice_prefix || 'RECH').toUpperCase();
    const year     = new Date().getFullYear();
    const countRes = await dbQuery(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'INVOICE'`);
    const nextNum  = String((parseInt(countRes.rows[0]?.count || 0, 10)) + 1).padStart(4, '0');
    const invoiceNumber = `${invPrefix}-${year}-${nextNum}`;

    const today   = new Date();
    const dueDate = new Date(today);
    const _firma1 = await getFirma();
    dueDate.setDate(dueDate.getDate() + (_firma1.zahlungsfrist || 14));

    const insertRes = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount, due_date)
       VALUES ('INVOICE', ?, ?, 'ENTWURF', ?, ?, ?, ?, ?)`,
      [invoiceNumber, offer.customer_id, offer.tax_rate || 19, offer.subtotal || 0,
       offer.tax_amount || 0, offer.total_amount || 0, dueDate.toISOString().split('T')[0]]
    );
    const newDocId = insertRes.lastID || insertRes.rows?.[0]?.id;

    // Positionen kopieren
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ?`, [offer_id]);
    for (const item of (itemsRes.rows || [])) {
      await dbQuery(
        `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)`,
        [newDocId, item.description, item.quantity, item.unit, item.price]
      );
    }

    await dbQuery(`UPDATE documents SET status = 'ANGENOMMEN' WHERE id = ?`, [offer_id]);
    res.redirect('/documents/invoices');
  } catch (err) {
    console.error('Fehler beim Umwandeln Angebot→Rechnung:', err.message);
    res.status(500).send('Fehler beim Umwandeln.');
  }
});

// POST: Angebot → Projekt umwandeln
router.post('/offers/convert-to-project', requireAdmin, async (req, res) => {
  const { offer_id } = req.body;
  try {
    const offerRes = await dbQuery(`SELECT * FROM documents WHERE id = ? AND doc_type = 'OFFER'`, [offer_id]);
    const offer    = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');

    const custRes      = await dbQuery(`SELECT company_name, contact_person FROM customers WHERE id = ?`, [offer.customer_id]);
    const cust         = custRes.rows[0];
    const customerName = (cust && (cust.company_name || cust.contact_person)) || 'Unbekannter Kunde';

    await dbQuery(
      `INSERT INTO projects (customer_id, title, description, total_price, status) VALUES (?, ?, ?, ?, 'In Planung')`,
      [offer.customer_id, `Auftrag aus ${offer.doc_number} – ${customerName}`,
       `Erstellt aus Angebot ${offer.doc_number}`, offer.total_amount || 0]
    );
    await dbQuery(`UPDATE documents SET status = 'ANGENOMMEN' WHERE id = ?`, [offer_id]);
    res.redirect('/projects');
  } catch (err) {
    console.error('Fehler beim Umwandeln Angebot→Projekt:', err.message);
    res.status(500).send('Fehler beim Erstellen des Projekts.');
  }
});

// GET: Angebots-PDF (Browser-Druck)
router.get('/offers/:id/pdf', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const offerRes  = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'OFFER'`, [id]);
    const offer = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');
    offer.invoice_number = offer.doc_number; // invoice-pdf.ejs nutzt invoice_number
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    const firma = await getFirma();
    res.render('invoice-pdf', { invoice: offer, items: itemsRes.rows || [], firma });
  } catch (err) {
    console.error('Fehler beim Angebots-PDF:', err.message);
    res.status(500).send('Fehler beim Laden des Angebots.');
  }
});

// ══════════════════════════════════════════════════════════════
// RECHNUNGEN
// ══════════════════════════════════════════════════════════════

// GET: Rechnungs-Übersicht
router.get('/invoices', requireAdmin, async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'documents', firma, true, false)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
  try {
    const [invoicesRes, customersRes, articlesRes] = await Promise.all([
      dbQuery(`
        SELECT d.*, c.company_name, c.contact_person,
               d.doc_number AS invoice_number
        FROM documents d
        LEFT JOIN customers c ON d.customer_id = c.id
        WHERE d.doc_type = 'INVOICE'
        ORDER BY d.created_at DESC`),
      dbQuery(`SELECT id, company_name, contact_person FROM customers ORDER BY company_name ASC`),
      dbQuery(`SELECT id, title, unit, unit_price, description FROM articles ORDER BY title ASC`)
    ]);
    res.render('invoices', {
      invoices:  invoicesRes.rows  || [],
      customers: customersRes.rows || [],
      articles:  articlesRes.rows  || []
    });
  } catch (err) {
    console.error('Fehler bei GET /documents/invoices:', err.message);
    res.status(500).send('Fehler beim Laden der Rechnungen.');
  }
});

// POST: Neue Rechnung direkt anlegen
router.post('/create-invoice', requireAdmin, async (req, res) => {
  const { customer_id, title: titles, quantity: quantities, unit: units, price: prices } = req.body;
  try {
    const _firma2  = await getFirma();
    const invPfx   = (_firma2.invoice_prefix || 'RECH').toUpperCase();
    const taxRate  = parseFloat(_firma2.default_tax_rate || 19);
    const year     = new Date().getFullYear();
    const countRes = await dbQuery(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'INVOICE'`);
    const nextNum  = String((parseInt(countRes.rows[0]?.count || 0, 10)) + 1).padStart(4, '0');
    const invoiceNumber = `${invPfx}-${year}-${nextNum}`;

    const titleArr    = Array.isArray(titles)    ? titles    : (titles    ? [titles]    : []);
    const quantityArr = Array.isArray(quantities) ? quantities : (quantities ? [quantities] : []);
    const unitArr     = Array.isArray(units)      ? units      : (units      ? [units]      : []);
    const priceArr    = Array.isArray(prices)     ? prices     : (prices     ? [prices]     : []);

    let subtotal = 0;
    const items = titleArr.map((t, i) => {
      const q = parseFloat(quantityArr[i] || 1);
      const p = parseFloat(priceArr[i]    || 0);
      subtotal += q * p;
      return { description: t, quantity: q, unit: unitArr[i] || 'Stk', price: p };
    });
    const taxAmount   = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;

    const today   = new Date();
    const dueDate = new Date(today);
    dueDate.setDate(dueDate.getDate() + (_firma2.zahlungsfrist || 14));

    const insertRes = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount, due_date)
       VALUES ('INVOICE', ?, ?, 'ENTWURF', ?, ?, ?, ?, ?)`,
      [invoiceNumber, customer_id, taxRate, subtotal, taxAmount, totalAmount, dueDate.toISOString().split('T')[0]]
    );
    const docId = insertRes.lastID || insertRes.rows?.[0]?.id;

    for (const item of items) {
      if (!item.description?.trim()) continue;
      await dbQuery(
        `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)`,
        [docId, item.description, item.quantity, item.unit, item.price]
      );
    }
    res.redirect('/documents/invoices');
  } catch (err) {
    console.error('Fehler bei POST /documents/create-invoice:', err.message);
    res.status(500).send('Fehler beim Anlegen der Rechnung.');
  }
});

// POST: Rechnung löschen
router.post('/invoices/delete', requireAdmin, async (req, res) => {
  const { invoice_id } = req.body;
  try {
    await dbQuery(`DELETE FROM document_items WHERE document_id = ?`, [invoice_id]);
    await dbQuery(`DELETE FROM documents WHERE id = ? AND doc_type = 'INVOICE'`, [invoice_id]);
    res.redirect('/documents/invoices');
  } catch (err) {
    console.error('Fehler beim Löschen der Rechnung:', err.message);
    res.status(500).send('Fehler beim Löschen.');
  }
});

// POST: Rechnungs-Status aktualisieren (z.B. → Bezahlt)
router.post('/invoices/update-status', requireAdmin, async (req, res) => {
  const { invoice_id, status, status_note } = req.body;
  try {
    await dbQuery(`UPDATE documents SET status = ?, status_note = ? WHERE id = ?`,
      [status, status_note || null, invoice_id]);
    res.redirect('/documents/invoices');
  } catch (err) {
    console.error('Fehler beim Status-Update:', err.message);
    res.status(500).send('Fehler beim Aktualisieren.');
  }
});

// POST: Rechnungsnummer ändern
router.post('/invoices/update-number', requireAdmin, async (req, res) => {
  const { invoice_id, invoice_number } = req.body;
  try {
    await dbQuery(`UPDATE documents SET doc_number = ? WHERE id = ?`, [invoice_number, invoice_id]);
    res.redirect(`/documents/invoices/${invoice_id}`);
  } catch (err) {
    console.error('Fehler beim Ändern der Rechnungsnummer:', err.message);
    res.status(500).send('Fehler beim Aktualisieren.');
  }
});

// GET: Rechnungs-Detail
router.get('/invoices/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const invoiceRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'INVOICE'`, [id]);
    const invoice = invoiceRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    res.render('invoice-detail', { invoice, items: itemsRes.rows || [] });
  } catch (err) {
    console.error('Fehler bei GET /documents/invoices/:id:', err.message);
    res.status(500).send('Fehler beim Laden der Rechnung.');
  }
});

// GET: Rechnungs-PDF (Browser-Druck)
router.get('/invoices/:id/pdf', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const invoiceRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'INVOICE'`, [id]);
    const invoice = invoiceRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    const firma = await getFirma();
    res.render('invoice-pdf', { invoice, items: itemsRes.rows || [], firma });
  } catch (err) {
    console.error('Fehler beim Rechnungs-PDF:', err.message);
    res.status(500).send('Fehler beim Laden der Rechnung.');
  }
});

// GET: Rechnungs-PDF Download (gleicher Inhalt, Content-Disposition: attachment)
router.get('/invoices/:id/pdf-download', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const invoiceRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'INVOICE'`, [id]);
    const invoice = invoiceRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    res.setHeader('Content-Disposition', `attachment; filename="Rechnung-${invoice.invoice_number}.html"`);
    const firma = await getFirma();
    res.render('invoice-pdf', { invoice, items: itemsRes.rows || [], firma });
  } catch (err) {
    console.error('Fehler beim PDF-Download:', err.message);
    res.status(500).send('Fehler beim Laden der Rechnung.');
  }
});

// ══════════════════════════════════════════════════════════════
// ÄLTERE KOMPATIBILITÄTS-ROUTE (aus altem server.js)
// ══════════════════════════════════════════════════════════════
router.post('/convert-to-invoice/:offerId', requireAdmin, async (req, res) => {
  req.body.offer_id = req.params.offerId;
  // Weiterleitung an interne Logik
  const { offerId } = req.params;
  try {
    const offerRes = await dbQuery(`SELECT * FROM documents WHERE id = ?`, [offerId]);
    const offer    = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');

    const year     = new Date().getFullYear();
    const countRes = await dbQuery(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'INVOICE'`);
    const nextNum  = String((parseInt(countRes.rows[0]?.count || 0, 10)) + 1).padStart(4, '0');
    const invoiceNumber = `RECH-${year}-${nextNum}`;

    await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount)
       VALUES ('INVOICE', ?, ?, 'ENTWURF', ?, ?, ?, ?)`,
      [invoiceNumber, offer.customer_id, offer.tax_rate || 19.0,
       offer.subtotal || 0, offer.tax_amount || 0, offer.total_amount || 0]
    );
    await dbQuery(`UPDATE documents SET status = 'ANGENOMMEN' WHERE id = ?`, [offerId]);
    res.redirect('/documents/invoices');
  } catch (err) {
    console.error('Fehler beim Umwandeln:', err.message);
    res.status(500).send('Datenbankfehler beim Umwandeln des Angebots.');
  }
});

module.exports = router;
