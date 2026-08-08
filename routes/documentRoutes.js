const express  = require('express');
const router   = require('express').Router();
const crypto   = require('crypto');
const { dbQuery }                    = require('../utils/db');
const { requireAdmin, hasPerm, canSeeMoney } = require('../middleware/auth');
const { getFirma }                   = require('../utils/companySettings');
const { generateDocumentPDF }        = require('../utils/pdfGenerator');

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
      offers:      offersRes.rows    || [],
      customers:   customersRes.rows || [],
      articles:    articlesRes.rows  || [],
      req,
      canSeeMoney: canSeeMoney(req.user, firma),
      savedMsg:    req.query.saved || null
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

// GET: Angebots-PDF — inline im Browser (echter PDF-Stream)
router.get('/offers/:id/pdf', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const offerRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'OFFER'`, [id]);
    const offer = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    await generateDocumentPDF(offer, itemsRes.rows || [], res, 'inline');
  } catch (err) {
    console.error('Fehler beim Angebots-PDF:', err.message);
    if (!res.headersSent) res.status(500).send('Fehler beim Erstellen des PDFs.');
  }
});

// GET: Angebots-PDF Download — echte PDF-Datei (Content-Disposition: attachment)
router.get('/offers/:id/pdf-download', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const offerRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'OFFER'`, [id]);
    const offer = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    await generateDocumentPDF(offer, itemsRes.rows || [], res, 'attachment');
  } catch (err) {
    console.error('Fehler beim Angebots-PDF-Download:', err.message);
    if (!res.headersSent) res.status(500).send('Fehler beim Erstellen des PDFs.');
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
    const firma      = await getFirma();
    const invoiceRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'INVOICE'`, [id]);
    const invoice = invoiceRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    res.render('invoice-detail', {
      invoice,
      items: itemsRes.rows || [],
      canSeeMoney: canSeeMoney(req.user, firma)
    });
  } catch (err) {
    console.error('Fehler bei GET /documents/invoices/:id:', err.message);
    res.status(500).send('Fehler beim Laden der Rechnung.');
  }
});

// GET: Rechnungs-PDF — inline im Browser (echter PDF-Stream)
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
    await generateDocumentPDF(invoice, itemsRes.rows || [], res, 'inline');
  } catch (err) {
    console.error('Fehler beim Rechnungs-PDF:', err.message);
    if (!res.headersSent) res.status(500).send('Fehler beim Erstellen des PDFs.');
  }
});

// GET: Rechnungs-PDF Download — echte PDF-Datei (Content-Disposition: attachment)
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
    await generateDocumentPDF(invoice, itemsRes.rows || [], res, 'attachment');
  } catch (err) {
    console.error('Fehler beim PDF-Download:', err.message);
    if (!res.headersSent) res.status(500).send('Fehler beim Erstellen des PDFs.');
  }
});

// ══════════════════════════════════════════════════════════════
// KALKULATIONSVORLAGEN
// ══════════════════════════════════════════════════════════════

// GET: Vorlagen-Übersicht (JSON für Modal)
router.get('/templates', requireAdmin, async (req, res) => {
  try {
    const tplRes = await dbQuery(
      `SELECT t.*, COUNT(i.id) as item_count
       FROM offer_templates t
       LEFT JOIN offer_template_items i ON i.template_id = t.id
       GROUP BY t.id ORDER BY t.kategorie ASC, t.name ASC`
    );
    res.json({ templates: tplRes.rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Einzelne Vorlage mit Positionen (für "Übernehmen"-Button)
router.get('/templates/:id', requireAdmin, async (req, res) => {
  try {
    const tRes = await dbQuery(`SELECT * FROM offer_templates WHERE id = ?`, [req.params.id]);
    const t    = tRes.rows[0];
    if (!t) return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
    const iRes = await dbQuery(
      `SELECT * FROM offer_template_items WHERE template_id = ? ORDER BY sort_order ASC, id ASC`,
      [req.params.id]
    );
    res.json({ template: t, items: iRes.rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Neue Vorlage anlegen (name + beschreibung + kategorie + items[])
router.post('/templates/create', requireAdmin, async (req, res) => {
  const { name, beschreibung, kategorie, beschreibung: descs, menge: mengen,
          einheit: einheiten, preis: preise } = req.body;
  try {
    // Vorlage anlegen
    const ins = await dbQuery(
      `INSERT INTO offer_templates (name, beschreibung, kategorie, created_by) VALUES (?, ?, ?, ?)`,
      [name, beschreibung || null, kategorie || 'Allgemein', req.user?.id || null]
    );
    const tplId = ins.lastID || ins.rows?.[0]?.id;

    // Positionen speichern
    const bArr = Array.isArray(req.body.item_beschreibung) ? req.body.item_beschreibung : (req.body.item_beschreibung ? [req.body.item_beschreibung] : []);
    const mArr = Array.isArray(req.body.item_menge)        ? req.body.item_menge        : (req.body.item_menge        ? [req.body.item_menge]        : []);
    const eArr = Array.isArray(req.body.item_einheit)      ? req.body.item_einheit      : (req.body.item_einheit      ? [req.body.item_einheit]      : []);
    const pArr = Array.isArray(req.body.item_preis)        ? req.body.item_preis        : (req.body.item_preis        ? [req.body.item_preis]        : []);

    for (let i = 0; i < bArr.length; i++) {
      if (!bArr[i]?.trim()) continue;
      await dbQuery(
        `INSERT INTO offer_template_items (template_id, beschreibung, menge, einheit, preis, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
        [tplId, bArr[i], parseFloat(mArr[i] || 1), eArr[i] || 'Stk', parseFloat(pArr[i] || 0), i]
      );
    }
    res.redirect('/documents/offers?tab=vorlagen&saved=1');
  } catch (err) {
    console.error('Vorlage anlegen Fehler:', err.message);
    res.status(500).send('Fehler beim Speichern der Vorlage.');
  }
});

// POST: Vorlage löschen
router.post('/templates/delete', requireAdmin, async (req, res) => {
  const { template_id } = req.body;
  try {
    await dbQuery(`DELETE FROM offer_template_items WHERE template_id = ?`, [template_id]);
    await dbQuery(`DELETE FROM offer_templates WHERE id = ?`, [template_id]);
    res.redirect('/documents/offers?tab=vorlagen');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen.');
  }
});

// ══════════════════════════════════════════════════════════════
// NACHTRAGS-MANAGEMENT
// ══════════════════════════════════════════════════════════════

// GET: Nachträge zu einem Angebot (JSON)
router.get('/offers/:id/nachtraege', requireAdmin, async (req, res) => {
  try {
    const nRes = await dbQuery(
      `SELECT n.*, u.username as ersteller
       FROM offer_nachtraege n
       LEFT JOIN users u ON n.created_by = u.id
       WHERE n.document_id = ?
       ORDER BY n.created_at ASC`,
      [req.params.id]
    );
    for (const n of nRes.rows) {
      const iRes = await dbQuery(
        `SELECT * FROM offer_nachtrag_items WHERE nachtrag_id = ? ORDER BY id ASC`, [n.id]
      );
      n.items = iRes.rows || [];
    }
    res.json({ nachtraege: nRes.rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Neuen Nachtrag anlegen
router.post('/offers/:id/nachtraege/create', requireAdmin, async (req, res) => {
  const docId = req.params.id;
  const { titel, beschreibung } = req.body;
  try {
    const bArr = Array.isArray(req.body.item_beschreibung) ? req.body.item_beschreibung : (req.body.item_beschreibung ? [req.body.item_beschreibung] : []);
    const mArr = Array.isArray(req.body.item_menge)        ? req.body.item_menge        : (req.body.item_menge        ? [req.body.item_menge]        : []);
    const eArr = Array.isArray(req.body.item_einheit)      ? req.body.item_einheit      : (req.body.item_einheit      ? [req.body.item_einheit]      : []);
    const pArr = Array.isArray(req.body.item_preis)        ? req.body.item_preis        : (req.body.item_preis        ? [req.body.item_preis]        : []);

    let betrag = 0;
    const positionen = [];
    for (let i = 0; i < bArr.length; i++) {
      if (!bArr[i]?.trim()) continue;
      const q = parseFloat(mArr[i] || 1);
      const p = parseFloat(pArr[i] || 0);
      betrag += q * p;
      positionen.push({ b: bArr[i], q, e: eArr[i] || 'Stk', p });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const ins = await dbQuery(
      `INSERT INTO offer_nachtraege (document_id, titel, beschreibung, betrag_netto, status, freigabe_token, created_by)
       VALUES (?, ?, ?, ?, 'Entwurf', ?, ?)`,
      [docId, titel, beschreibung || null, betrag, token, req.user?.id || null]
    );
    const nId = ins.lastID || ins.rows?.[0]?.id;

    for (const pos of positionen) {
      await dbQuery(
        `INSERT INTO offer_nachtrag_items (nachtrag_id, beschreibung, menge, einheit, preis) VALUES (?, ?, ?, ?, ?)`,
        [nId, pos.b, pos.q, pos.e, pos.p]
      );
    }
    res.redirect(`/documents/offers/${docId}/detail?saved=nachtrag`);
  } catch (err) {
    console.error('Nachtrag anlegen Fehler:', err.message);
    res.status(500).send('Fehler: ' + err.message);
  }
});

// POST: Nachtrag-Status ändern (z.B. Entwurf → Gesendet → Freigegeben)
router.post('/nachtraege/:id/status', requireAdmin, async (req, res) => {
  const { status, document_id } = req.body;
  try {
    await dbQuery(
      `UPDATE offer_nachtraege SET status = ? WHERE id = ?`,
      [status, req.params.id]
    );
    res.redirect(`/documents/offers/${document_id}/detail`);
  } catch (err) {
    res.status(500).send('Fehler beim Status-Update.');
  }
});

// GET: Öffentlicher Freigabe-Link (kein Login nötig)
router.get('/nachtrag/approve/:token', async (req, res) => {
  try {
    const nRes = await dbQuery(
      `SELECT n.*, d.doc_number, c.company_name, c.contact_person
       FROM offer_nachtraege n
       JOIN documents d ON n.document_id = d.id
       LEFT JOIN customers c ON d.customer_id = c.id
       WHERE n.freigabe_token = ?`, [req.params.token]
    );
    const n = nRes.rows[0];
    if (!n) return res.status(404).send('<h2>Link ungültig oder bereits verarbeitet.</h2>');
    if (n.status === 'Freigegeben') {
      return res.send(`<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center"><h2>✅ Nachtrag bereits freigegeben</h2><p>Dieser Nachtrag wurde am ${new Date(n.freigegeben_am).toLocaleDateString('de-DE')} freigegeben.</p></body></html>`);
    }
    // Items laden
    const iRes = await dbQuery(`SELECT * FROM offer_nachtrag_items WHERE nachtrag_id = ?`, [n.id]);
    const items = iRes.rows || [];
    const firma = await getFirma();
    res.send(`<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nachtrag freigeben – ${firma.nameKurz || 'Metallbau'}</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1f2328;background:#f9fafb}
  h1{font-size:1.3rem;margin-bottom:4px}p{color:#57606a;font-size:.9rem}
  table{width:100%;border-collapse:collapse;margin:16px 0;font-size:.87rem}
  th{text-align:left;background:#f3f4f6;padding:8px 10px;font-size:.75rem;text-transform:uppercase;color:#6b7280}
  td{padding:8px 10px;border-bottom:1px solid #e5e7eb}
  .total{font-weight:700;font-size:1rem;text-align:right;padding:12px 10px}
  .btn{display:inline-block;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.95rem;cursor:pointer;border:none;width:100%;text-align:center;margin-top:8px}
  .btn-ok{background:#16a34a;color:#fff} .btn-ab{background:#f3f4f6;color:#374151}
  .badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:.75rem;font-weight:600;background:#fef9c3;color:#92400e}
</style></head>
<body>
  <p style="color:#6b7280;font-size:.8rem;margin-bottom:4px">${firma.nameKurz || 'Metallbau-Betrieb'} · Angebot ${n.doc_number}</p>
  <h1>📋 Nachtrag: ${n.titel}</h1>
  <span class="badge">Ausstehende Freigabe</span>
  ${n.beschreibung ? `<p style="margin-top:12px">${n.beschreibung.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>` : ''}
  <table>
    <thead><tr><th>Beschreibung</th><th style="text-align:right">Menge</th><th style="text-align:right">EP €</th><th style="text-align:right">GP €</th></tr></thead>
    <tbody>
      ${items.map(i=>`<tr><td>${i.beschreibung.replace(/</g,'&lt;')}</td><td style="text-align:right">${Number(i.menge).toLocaleString('de-DE')} ${i.einheit}</td><td style="text-align:right">${Number(i.preis).toFixed(2)}</td><td style="text-align:right">${(Number(i.menge)*Number(i.preis)).toFixed(2)}</td></tr>`).join('')}
    </tbody>
    <tfoot><tr><td colspan="3" class="total">Netto-Summe:</td><td class="total">${Number(n.betrag_netto).toFixed(2)} €</td></tr></tfoot>
  </table>
  <form action="/documents/nachtrag/approve/${req.params.token}" method="POST">
    <button type="submit" class="btn btn-ok">✅ Nachtrag freigeben</button>
  </form>
  <p style="text-align:center;font-size:.75rem;color:#9ca3af;margin-top:8px">Mit dem Klick bestätigen Sie die Ausführung des Nachtrags und erteilen den Auftrag.</p>
</body></html>`);
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// POST: Nachtrag öffentlich freigeben (kein Login nötig)
router.post('/nachtrag/approve/:token', async (req, res) => {
  try {
    const nRes = await dbQuery(
      `SELECT * FROM offer_nachtraege WHERE freigabe_token = ?`, [req.params.token]
    );
    const n = nRes.rows[0];
    if (!n) return res.status(404).send('Link ungültig.');
    if (n.status === 'Freigegeben') return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ Bereits freigegeben.</h2></body></html>');
    await dbQuery(
      `UPDATE offer_nachtraege SET status = 'Freigegeben', freigegeben_am = CURRENT_TIMESTAMP WHERE freigabe_token = ?`,
      [req.params.token]
    );
    const firma = await getFirma();
    res.send(`<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center;padding:0 16px">
      <h1 style="color:#16a34a;font-size:2rem">✅</h1>
      <h2>Nachtrag freigegeben!</h2>
      <p style="color:#6b7280">Vielen Dank. ${firma.nameKurz || 'Wir'} werden uns umgehend um die Ausführung kümmern.</p>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// POST: Nachtrag löschen
router.post('/nachtraege/:id/delete', requireAdmin, async (req, res) => {
  const { document_id } = req.body;
  try {
    await dbQuery(`DELETE FROM offer_nachtrag_items WHERE nachtrag_id = ?`, [req.params.id]);
    await dbQuery(`DELETE FROM offer_nachtraege WHERE id = ?`, [req.params.id]);
    res.redirect(`/documents/offers/${document_id}/detail`);
  } catch (err) {
    res.status(500).send('Fehler beim Löschen.');
  }
});

// GET: Angebots-Detail (mit Nachträgen)
router.get('/offers/:id/detail', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const firma     = await getFirma();
    const offerRes  = await dbQuery(
      `SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email
       FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
       WHERE d.id = ? AND d.doc_type = 'OFFER'`, [id]
    );
    const offer = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');

    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    const nRes     = await dbQuery(
      `SELECT n.*, u.username as ersteller
       FROM offer_nachtraege n LEFT JOIN users u ON n.created_by = u.id
       WHERE n.document_id = ? ORDER BY n.created_at ASC`, [id]
    );
    const nachtraege = nRes.rows || [];
    for (const n of nachtraege) {
      const iR = await dbQuery(`SELECT * FROM offer_nachtrag_items WHERE nachtrag_id = ? ORDER BY id ASC`, [n.id]);
      n.items = iR.rows || [];
    }

    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    res.render('offer-detail', {
      offer,
      items:      itemsRes.rows || [],
      nachtraege,
      baseUrl,
      savedMsg:   req.query.saved || null,
      canSeeMoney: canSeeMoney(req.user, firma)
    });
  } catch (err) {
    console.error('Offer-Detail Fehler:', err.message);
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════
// STAHLPREISE
// ══════════════════════════════════════════════════════════════

// GET: Aktuelle Preise (JSON) – für Frontend-Widget
router.get('/steel-prices', requireAdmin, async (req, res) => {
  try {
    // Jeweils den neuesten Preis pro Material zurückgeben
    const result = await dbQuery(
      `SELECT s1.* FROM steel_prices s1
       INNER JOIN (
         SELECT material, MAX(gueltig_am) as max_date FROM steel_prices GROUP BY material
       ) s2 ON s1.material = s2.material AND s1.gueltig_am = s2.max_date
       ORDER BY s1.material ASC`
    );
    res.json({ prices: result.rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Stahlpreis manuell aktualisieren
router.post('/steel-prices/update', requireAdmin, async (req, res) => {
  const { material, preis_100kg, quelle } = req.body;
  const heute = new Date().toISOString().split('T')[0];
  try {
    // Prüfen ob heute schon ein Eintrag existiert
    const exist = await dbQuery(
      `SELECT id FROM steel_prices WHERE material = ? AND gueltig_am = ?`, [material, heute]
    );
    if (exist.rows.length > 0) {
      await dbQuery(
        `UPDATE steel_prices SET preis_100kg = ?, quelle = ? WHERE material = ? AND gueltig_am = ?`,
        [parseFloat(preis_100kg), quelle || 'manuell', material, heute]
      );
    } else {
      await dbQuery(
        `INSERT INTO steel_prices (material, preis_100kg, quelle, gueltig_am) VALUES (?, ?, ?, ?)`,
        [material, parseFloat(preis_100kg), quelle || 'manuell', heute]
      );
    }
    res.redirect('/documents/offers?tab=preise&saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// GET: Preisverlauf für ein Material (JSON, letzten 30 Tage)
router.get('/steel-prices/history/:material', requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery(
      `SELECT gueltig_am, preis_100kg, quelle FROM steel_prices
       WHERE material = ?
       ORDER BY gueltig_am DESC LIMIT 30`,
      [req.params.material]
    );
    res.json({ history: result.rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
