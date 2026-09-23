const express  = require('express');
const router   = require('express').Router();
const crypto   = require('crypto');
const { dbQuery }                    = require('../utils/db');
const { requireAdmin, hasPerm, canSeeMoney } = require('../middleware/auth');
const { getFirma, setFirmaValue }    = require('../utils/companySettings');
const { sendEmail }                  = require('../utils/notifier');
const { generateDocumentPDF, generateDocumentPDFBuffer } = require('../utils/pdfGenerator');
const { buildXRechnungXml } = require('../utils/xrechnung');
const { buildDatevCsv }               = require('../utils/datevExport');

// ══════════════════════════════════════════════════════════════
// ANGEBOTE
// ══════════════════════════════════════════════════════════════

// GET: Angebots-Übersicht

async function recalcInvoicePaid(docId) {
  const payRes = await dbQuery(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM invoice_payments WHERE document_id = ?`,
    [docId]
  );
  const paid = parseFloat(payRes.rows?.[0]?.paid || 0) || 0;
  const invRes = await dbQuery(`SELECT total_amount, status FROM documents WHERE id = ?`, [docId]);
  const inv = invRes.rows?.[0];
  if (!inv) return paid;
  const total = parseFloat(inv.total_amount || 0) || 0;
  let status = inv.status;
  if (status !== 'Storniert' && status !== 'Gutschrift') {
    if (paid <= 0.001) {
      // keep Gemahnt/Überfällig/Offen etc. unless was Bezahlt
      if (status === 'Bezahlt' || status === 'Teilbezahlt') status = 'Offen';
    } else if (paid + 0.01 >= total) {
      status = 'Bezahlt';
    } else {
      status = 'Teilbezahlt';
    }
  }
  try {
    await dbQuery(`UPDATE documents SET paid_amount = ?, status = ? WHERE id = ?`, [paid, status, docId]);
  } catch (_) {
    await dbQuery(`UPDATE documents SET status = ? WHERE id = ?`, [status, docId]);
  }
  return paid;
}

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
      textSnippets: (function(){ try { return JSON.parse(firma.text_snippets||'[]'); } catch(e){ return []; } })(),
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
    // Direkt zur neuen Rechnung statt zur Liste – ein Klick weniger bis zum Ergebnis
    res.redirect('/documents/invoices/' + newDocId);
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
    let textSnippets = [];
    try { textSnippets = JSON.parse(firma.text_snippets || '[]'); } catch (_) {}
    res.render('invoices', {
      invoices:  invoicesRes.rows  || [],
      customers: customersRes.rows || [],
      articles:  articlesRes.rows  || [],
      textSnippets
    });
  } catch (err) {
    console.error('Fehler bei GET /documents/invoices:', err.message);
    res.status(500).send('Fehler beim Laden der Rechnungen.');
  }
});

// GET: DATEV-Export (Buchungsstapel) für einen Zeitraum herunterladen
router.get('/invoices/datev-export', requireAdmin, async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'documents', firma, true, false)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
  try {
    const heute = new Date();
    const ersterDesMonats = new Date(heute.getFullYear(), heute.getMonth(), 1).toISOString().split('T')[0];
    const von = (req.query.von || ersterDesMonats).toString();
    const bis = (req.query.bis || heute.toISOString().split('T')[0]).toString();

    const invoicesRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.customer_number,
             d.doc_number AS invoice_number
      FROM documents d
      LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.doc_type = 'INVOICE'
        AND date(d.created_at) >= date(?)
        AND date(d.created_at) <= date(?)
      ORDER BY d.created_at ASC`, [von, bis]);

    const invoices = invoicesRes.rows || [];
    if (!invoices.length) {
      return res.status(404).send('<h1>Keine Rechnungen im gewählten Zeitraum gefunden.</h1><a href="/documents/invoices">← Zurück</a>');
    }

    const csv = buildDatevCsv(invoices, firma, { von, bis });
    const dateiname = `EXTF_Buchungsstapel_${von.replace(/-/g, '')}_${bis.replace(/-/g, '')}.csv`;

    // DATEV erwartet die Datei in Windows-1252/ISO-8859-1 (nicht UTF-8)
    const buffer = Buffer.from(csv, 'latin1');
    res.setHeader('Content-Type', 'text/csv; charset=windows-1252');
    res.setHeader('Content-Disposition', `attachment; filename="${dateiname}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Fehler bei GET /documents/invoices/datev-export:', err.message);
    res.status(500).send('Fehler beim Erstellen des DATEV-Exports.');
  }
});


// POST: Neue Positionen in Artikelstamm / Textbausteine übernehmen
router.post('/api/save-catalog-items', requireAdmin, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const asArticle = req.body.as_article !== false && req.body.as_article !== '0';
    const asSnippet = req.body.as_snippet === true || req.body.as_snippet === '1' || req.body.as_snippet === 'true';

    let articlesAdded = 0;
    let snippetsAdded = 0;

    if (asArticle) {
      const existing = await dbQuery(`SELECT LOWER(title) AS t FROM articles`);
      const titles = new Set((existing.rows || []).map(r => (r.t || '').trim()));
      for (const it of items) {
        const title = (it.title || it.description || '').trim();
        if (!title) continue;
        const key = title.toLowerCase();
        if (titles.has(key)) continue;
        const unit = (it.unit || 'Stk').trim() || 'Stk';
        const price = parseFloat(it.price) || 0;
        await dbQuery(
          `INSERT INTO articles (title, unit, unit_price, description) VALUES (?, ?, ?, ?)`,
          [title, unit, price, it.description || title]
        );
        titles.add(key);
        articlesAdded++;
      }
    }

    if (asSnippet) {
      const firma = await getFirma();
      let snippets = [];
      try { snippets = JSON.parse(firma.text_snippets || '[]'); } catch (_) { snippets = []; }
      if (!Array.isArray(snippets)) snippets = [];
      const existingKeys = new Set(snippets.map(s => (s.label || s.text || '').toLowerCase().trim()));
      for (const it of items) {
        const title = (it.title || it.description || '').trim();
        if (!title) continue;
        if (existingKeys.has(title.toLowerCase())) continue;
        let key = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        if (!key) key = 'pos_' + Date.now();
        // unique key
        let k = key, n = 1;
        while (snippets.some(s => s.key === k)) { k = key + '_' + n; n++; }
        snippets.push({ key: k, label: title, text: title });
        existingKeys.add(title.toLowerCase());
        snippetsAdded++;
      }
      await setFirmaValue('text_snippets', JSON.stringify(snippets));
    }

    res.json({ ok: true, articlesAdded, snippetsAdded });
  } catch (err) {
    console.error('save-catalog-items:', err.message);
    res.status(500).json({ ok: false, error: err.message });
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
    // Direkt zur neuen Rechnung – sofort sichtbar, PDF/Versand ohne Umweg über die Liste
    res.redirect('/documents/invoices/' + docId);
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

// POST: Mahnung erstellen (Mahnstufe + optionale Mahngebühr + PDF)
router.post('/invoices/:id/create-dunning', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let level = parseInt(req.body.dunning_level, 10);
  if (![1, 2, 3].includes(level)) level = 1;
  const downloadPdf = req.body.download_pdf === '1' || req.body.download_pdf === 'true';
  const applyFee = req.body.apply_fee !== '0' && req.body.apply_fee !== 'false';

  try {
    const firma = await getFirma();
    const invRes = await dbQuery(
      `SELECT id, status, dunning_level, tax_rate FROM documents WHERE id = ? AND doc_type = 'INVOICE'`,
      [id]
    );
    const inv = invRes.rows?.[0];
    if (!inv) return res.status(404).send('Rechnung nicht gefunden.');
    if (inv.status === 'Bezahlt') {
      return res.status(400).send('Für bezahlte Rechnungen kann keine Mahnung erstellt werden.');
    }

    const note = level === 1
      ? '1. Zahlungserinnerung erstellt'
      : level === 2
        ? '2. Mahnung erstellt'
        : '3. Letzte Mahnung erstellt';

    // Alte Mahngebühr-Positionen entfernen
    await dbQuery(
      `DELETE FROM document_items WHERE document_id = ? AND (description LIKE 'Mahngebühr%' OR description LIKE 'Mahngebuehr%')`,
      [id]
    );

    if (applyFee) {
      const feeKey = level === 1 ? 'dunning_fee_1' : level === 2 ? 'dunning_fee_2' : 'dunning_fee_3';
      let fee = parseFloat(
        (req.body.dunning_fee_override !== undefined && req.body.dunning_fee_override !== '')
          ? req.body.dunning_fee_override
          : (firma[feeKey] != null ? firma[feeKey] : 0)
      ) || 0;
      if (fee > 0) {
        const feeLabel = level === 1
          ? 'Mahngebühr (1. Zahlungserinnerung)'
          : level === 2
            ? 'Mahngebühr (2. Mahnung)'
            : 'Mahngebühr (3. Letzte Mahnung)';
        await dbQuery(
          `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, 1, 'Psch', ?)`,
          [id, feeLabel, fee]
        );
      }
    }

    const itemsRes = await dbQuery(`SELECT quantity, price FROM document_items WHERE document_id = ?`, [id]);
    let subtotal = 0;
    for (const it of (itemsRes.rows || [])) {
      subtotal += (parseFloat(it.quantity) || 0) * (parseFloat(it.price) || 0);
    }
    const taxRate = parseFloat(inv.tax_rate || firma.default_tax_rate || 19);
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;

    await dbQuery(
      `UPDATE documents SET dunning_level = ?, status = 'Gemahnt', status_note = ?,
       subtotal = ?, tax_amount = ?, total_amount = ? WHERE id = ?`,
      [level, note, subtotal, taxAmount, totalAmount, id]
    );

    // Mahnungs-Historie speichern
    const feeLogged = applyFee ? (parseFloat(
      (req.body.dunning_fee_override !== undefined && req.body.dunning_fee_override !== '')
        ? req.body.dunning_fee_override
        : (firma[level === 1 ? 'dunning_fee_1' : level === 2 ? 'dunning_fee_2' : 'dunning_fee_3'] || 0)
    ) || 0) : 0;
    try {
      await dbQuery(
        `INSERT INTO dunning_history (document_id, dunning_level, fee_amount, note, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [id, level, feeLogged, note, req.user?.id || null]
      );
    } catch (histErr) {
      console.warn('dunning_history Insert (Migration 15 nötig?):', histErr.message);
    }

    if (downloadPdf) {
      return res.redirect(`/documents/invoices/${id}/pdf-download`);
    }
    res.redirect(`/documents/invoices/${id}?mahnung=1&tab=mahnungen`);
  } catch (err) {
    console.error('Fehler bei POST /invoices/:id/create-dunning:', err.message);
    res.status(500).send('Fehler beim Erstellen der Mahnung.');
  }
});

// POST: Rechnung bearbeiten (Positionen, Fälligkeit, MwSt., Status)
router.post('/invoices/:id/update', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    title: titles, quantity: quantities, unit: units, price: prices,
    due_date, tax_rate, status, status_note
  } = req.body;

  try {
    const invRes = await dbQuery(
      `SELECT id, status FROM documents WHERE id = ? AND doc_type = 'INVOICE'`,
      [id]
    );
    if (!invRes.rows?.[0]) return res.status(404).send('Rechnung nicht gefunden.');

    const titleArr    = Array.isArray(titles)     ? titles     : (titles     ? [titles]     : []);
    const quantityArr = Array.isArray(quantities) ? quantities : (quantities ? [quantities] : []);
    const unitArr     = Array.isArray(units)      ? units      : (units      ? [units]      : []);
    const priceArr    = Array.isArray(prices)     ? prices     : (prices     ? [prices]     : []);

    await dbQuery(`DELETE FROM document_items WHERE document_id = ?`, [id]);

    let subtotal = 0;
    for (let i = 0; i < titleArr.length; i++) {
      const desc = (titleArr[i] || '').trim();
      if (!desc) continue;
      const q = parseFloat(quantityArr[i] || 1);
      const p = parseFloat(priceArr[i] || 0);
      subtotal += q * p;
      await dbQuery(
        `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)`,
        [id, desc, q, unitArr[i] || 'Stk', p]
      );
    }

    const taxRate = parseFloat(tax_rate != null && tax_rate !== '' ? tax_rate : 19);
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;

    const fields = ['subtotal = ?', 'tax_amount = ?', 'total_amount = ?', 'tax_rate = ?'];
    const params = [subtotal, taxAmount, totalAmount, taxRate];

    if (due_date !== undefined) {
      fields.push('due_date = ?');
      params.push(due_date || null);
    }
    if (status) {
      fields.push('status = ?');
      params.push(status);
    }
    if (status_note !== undefined) {
      fields.push('status_note = ?');
      params.push(status_note || null);
    }
    params.push(id);

    await dbQuery(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`, params);
    res.redirect(`/documents/invoices/${id}?saved=1`);
  } catch (err) {

    console.error('Fehler bei POST /invoices/:id/update:', err.message);
    res.status(500).send('Fehler beim Speichern der Rechnung.');
  }
});

// POST: Zahlung buchen
router.post('/invoices/:id/payments', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const amount = parseFloat(req.body.amount);
  const payment_date = req.body.payment_date || new Date().toISOString().slice(0, 10);
  const method = req.body.method || 'Überweisung';
  const note = req.body.note || '';
  try {
    if (!amount || amount <= 0) return res.status(400).send('Betrag ungültig.');
    const inv = (await dbQuery(`SELECT id, status FROM documents WHERE id = ? AND doc_type = 'INVOICE'`, [id])).rows?.[0];
    if (!inv) return res.status(404).send('Rechnung nicht gefunden.');
    if (inv.status === 'Storniert') return res.status(400).send('Stornierte Rechnung.');
    await dbQuery(
      `INSERT INTO invoice_payments (document_id, amount, payment_date, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, amount, payment_date, method, note, req.user?.id || null]
    );
    await recalcInvoicePaid(id);
    res.redirect(`/documents/invoices/${id}?tab=zahlungen&saved=1`);
  } catch (err) {
    console.error('Zahlung buchen:', err.message);
    res.status(500).send('Fehler beim Buchen der Zahlung. (Migration 16?)');
  }
});

// POST: Zahlung löschen
router.post('/invoices/:id/payments/:payId/delete', requireAdmin, async (req, res) => {
  const { id, payId } = req.params;
  try {
    await dbQuery(`DELETE FROM invoice_payments WHERE id = ? AND document_id = ?`, [payId, id]);
    await recalcInvoicePaid(id);
    res.redirect(`/documents/invoices/${id}?tab=zahlungen&saved=1`);
  } catch (err) {
    console.error('Zahlung löschen:', err.message);
    res.status(500).send('Fehler beim Löschen der Zahlung.');
  }
});

// POST: Rechnung per E-Mail senden (PDF-Anhang)
router.post('/invoices/:id/send-email', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const to = (req.body.to || '').trim();
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();
  try {
    const firma = await getFirma();
    const invRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type IN ('INVOICE','CREDIT')`, [id]);
    const invoice = invRes.rows?.[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden.');
    const emailTo = to || invoice.email;
    if (!emailTo) return res.status(400).send('Keine E-Mail-Adresse.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    const pdfBuf = await generateDocumentPDFBuffer(invoice, itemsRes.rows || []);
    const docLabel = invoice.doc_type === 'CREDIT' ? 'Gutschrift' : 'Rechnung';
    const docNr = invoice.invoice_number || invoice.doc_number || id;
    const html = `<p>${(message || `Anbei erhalten Sie ${docLabel} ${docNr} als PDF.`).replace(/\n/g, '<br>')}</p>
      <p>Mit freundlichen Grüßen<br>${firma.name || ''}</p>`;
    const result = await sendEmail(
      emailTo,
      subject || `${docLabel} ${docNr}`,
      html,
      [{ filename: `${docLabel}-${docNr}.pdf`, content: pdfBuf, contentType: 'application/pdf' }]
    );
    if (!result.ok) {
      return res.status(500).send('E-Mail-Versand fehlgeschlagen: ' + (result.error || 'unbekannt') +
        '<br><a href="/documents/invoices/' + id + '">Zurück</a>');
    }
    try {
      await dbQuery(`UPDATE documents SET sent_at = ?, status = CASE WHEN status IN ('ENTWURF','Offen') THEN 'Gesendet' ELSE status END WHERE id = ?`,
        [new Date().toISOString(), id]);
    } catch (_) {}
    res.redirect(`/documents/invoices/${id}?sent=1`);
  } catch (err) {
    console.error('send-email:', err.message);
    res.status(500).send('Fehler beim E-Mail-Versand: ' + err.message);
  }
});

// POST: Rechnung stornieren
router.post('/invoices/:id/storno', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const reason = (req.body.reason || 'Storniert').trim();
  try {
    const inv = (await dbQuery(`SELECT id, status FROM documents WHERE id = ? AND doc_type = 'INVOICE'`, [id])).rows?.[0];
    if (!inv) return res.status(404).send('Rechnung nicht gefunden.');
    if (inv.status === 'Storniert') return res.redirect(`/documents/invoices/${id}`);
    await dbQuery(
      `UPDATE documents SET status = 'Storniert', status_note = ? WHERE id = ?`,
      [reason, id]
    );
    res.redirect(`/documents/invoices/${id}?storno=1`);
  } catch (err) {
    console.error('storno:', err.message);
    res.status(500).send('Fehler beim Stornieren.');
  }
});

// POST: Gutschrift aus Rechnung erzeugen
router.post('/invoices/:id/credit-note', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const firma = await getFirma();
    const invRes = await dbQuery(`SELECT * FROM documents WHERE id = ? AND doc_type = 'INVOICE'`, [id]);
    const inv = invRes.rows?.[0];
    if (!inv) return res.status(404).send('Rechnung nicht gefunden.');
    const year = new Date().getFullYear();
    const countRes = await dbQuery(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'CREDIT'`);
    const nextNum = String((parseInt(countRes.rows[0]?.count || 0, 10)) + 1).padStart(4, '0');
    const prefix = (firma.credit_prefix || 'GS').toUpperCase();
    const docNumber = `${prefix}-${year}-${nextNum}`;
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    const items = itemsRes.rows || [];
    let subtotal = 0;
    for (const it of items) {
      subtotal += (parseFloat(it.quantity) || 0) * (parseFloat(it.price) || 0);
    }
    const taxRate = parseFloat(inv.tax_rate || firma.default_tax_rate || 19);
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;
    const insertRes = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount, related_document_id, status_note)
       VALUES ('CREDIT', ?, ?, 'Gutschrift', ?, ?, ?, ?, ?, ?)`,
      [docNumber, inv.customer_id, taxRate, subtotal, taxAmount, totalAmount, id,
       `Gutschrift zu Rechnung ${inv.doc_number || id}`]
    );
    const newId = insertRes.lastID || insertRes.rows?.[0]?.id;
    for (const it of items) {
      await dbQuery(
        `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)`,
        [newId, it.description, it.quantity, it.unit, it.price]
      );
    }
    res.redirect(`/documents/invoices/${newId}`);
  } catch (err) {
    console.error('credit-note:', err.message);
    res.status(500).send('Fehler beim Erstellen der Gutschrift. (Migration 16 für related_document_id?)');
  }
});

// GET: Offene-Posten-Liste
router.get('/open-items', requireAdmin, async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'documents', firma, true, false)) {
    return res.status(403).send('<h1>403</h1>');
  }
  try {
    const rows = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.email,
             d.doc_number AS invoice_number,
             COALESCE(d.paid_amount, 0) AS paid_amount
      FROM documents d
      LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.doc_type = 'INVOICE'
        AND d.status NOT IN ('Bezahlt', 'Storniert', 'Gutschrift')
      ORDER BY d.due_date ASC, d.created_at DESC
    `);
    // SQLite may not support NULLS LAST - fallback query handled in catch
    let list = (rows.rows || []).map(r => ({ ...r, open_amount: (parseFloat(r.total_amount||0) - parseFloat(r.paid_amount||0)) }));
    const sumOpen = list.reduce((s, r) => s + Math.max(0, r.open_amount), 0);
    const sumOverdue = list.reduce((s, r) => {
      const open = Math.max(0, parseFloat(r.open_amount != null ? r.open_amount : (r.total_amount || 0) - (r.paid_amount || 0)));
      if (r.due_date && new Date(r.due_date) < new Date() && open > 0.01) return s + open;
      return s;
    }, 0);
    res.render('open-items', {
      invoices: list,
      sumOpen,
      sumOverdue,
      canSeeMoney: canSeeMoney(req.user, firma),
      firma
    });
  } catch (err) {
    // SQLite without NULLS LAST
    try {
      const rows = await dbQuery(`
        SELECT d.*, c.company_name, c.contact_person, c.email,
               d.doc_number AS invoice_number,
               COALESCE(d.paid_amount, 0) AS paid_amount
        FROM documents d
        LEFT JOIN customers c ON d.customer_id = c.id
        WHERE d.doc_type = 'INVOICE'
          AND d.status NOT IN ('Bezahlt', 'Storniert', 'Gutschrift')
        ORDER BY d.due_date ASC, d.created_at DESC
      `);
      let list = (rows.rows || []).map(r => ({
        ...r,
        open_amount: (parseFloat(r.total_amount || 0) - parseFloat(r.paid_amount || 0))
      }));
      const sumOpen = list.reduce((s, r) => s + Math.max(0, r.open_amount), 0);
      const sumOverdue = list.reduce((s, r) => {
        if (r.due_date && new Date(r.due_date) < new Date() && r.open_amount > 0.01) return s + r.open_amount;
        return s;
      }, 0);
      res.render('open-items', { invoices: list, sumOpen, sumOverdue, canSeeMoney: canSeeMoney(req.user, firma), firma });
    } catch (err2) {
      console.error('open-items:', err2.message);
      res.status(500).send('Fehler beim Laden der OP-Liste: ' + err2.message);
    }
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
      WHERE d.id = ? AND d.doc_type IN ('INVOICE','CREDIT')`, [id]);
    const invoice = invoiceRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden.');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    let dunningHistory = [];
    try {
      const histRes = await dbQuery(
        `SELECT h.*, u.username AS created_by_name
         FROM dunning_history h
         LEFT JOIN users u ON h.created_by = u.id
         WHERE h.document_id = ?
         ORDER BY h.created_at DESC, h.id DESC`,
        [id]
      );
      dunningHistory = histRes.rows || [];
    } catch (_) {
      dunningHistory = [];
    }
    let payments = [];
    try {
      const payRes = await dbQuery(
        `SELECT p.*, u.username AS created_by_name
         FROM invoice_payments p
         LEFT JOIN users u ON p.created_by = u.id
         WHERE p.document_id = ?
         ORDER BY p.payment_date DESC, p.id DESC`,
        [id]
      );
      payments = payRes.rows || [];
    } catch (_) {
      payments = [];
    }
    const paidSum = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const totalAmt = parseFloat(invoice.total_amount || 0) || 0;
    const openAmt = Math.max(0, totalAmt - paidSum);
    const tabQ = req.query.tab;
    const activeTab = ['mahnungen', 'zahlungen'].includes(tabQ) ? tabQ : 'rechnung';
    res.render('invoice-detail', {
      invoice,
      items: itemsRes.rows || [],
      firma,
      dunningHistory,
      payments,
      paidSum,
      openAmt,
      activeTab,
      canSeeMoney: canSeeMoney(req.user, firma),
      mahnungOk: req.query.mahnung === '1',
      savedOk: req.query.saved === '1',
      sentOk: req.query.sent === '1',
      stornoOk: req.query.storno === '1'
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
      WHERE d.id = ? AND d.doc_type IN ('INVOICE','CREDIT')`, [id]);
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
      WHERE d.id = ? AND d.doc_type IN ('INVOICE','CREDIT')`, [id]);
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
<title>Nachtrag freigeben – ${(firma.nameKurz || 'Metallbau').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</title>
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
  <p style="color:#6b7280;font-size:.8rem;margin-bottom:4px">${(firma.nameKurz || 'Metallbau-Betrieb').replace(/</g,'&lt;').replace(/>/g,'&gt;')} · Angebot ${(n.doc_number||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
  <h1>📋 Nachtrag: ${n.titel.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</h1>
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



// GET: E-Rechnung XRechnung 3.0 XML
router.get('/invoices/:id/xrechnung', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const firma = await getFirma();
    const invRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             c.ust_id, c.leitweg_id, d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type IN ('INVOICE','CREDIT')`, [id]);
    const invoice = invRes.rows?.[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    const customer = {
      company_name: invoice.company_name, contact_person: invoice.contact_person,
      street: invoice.street, zip: invoice.zip, city: invoice.city,
      email: invoice.email, phone: invoice.phone,
      ust_id: invoice.ust_id, leitweg_id: invoice.leitweg_id
    };
    const xml = buildXRechnungXml({ invoice, items: itemsRes.rows || [], customer, firma });
    const filename = `XRechnung-${invoice.invoice_number || id}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch (err) {
    console.error('XRechnung:', err.message);
    res.status(500).send('Fehler E-Rechnung: ' + err.message);
  }
});


module.exports = router;
