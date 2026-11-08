const express  = require('express');
const router   = require('express').Router();
const crypto   = require('crypto');
const isPg = !!process.env.DATABASE_URL;
const { dbQuery, withTransaction }   = require('../utils/db');
const { requireAdmin, requireOffice, hasPerm, canSeeMoney } = require('../middleware/auth');
const { getFirma, setFirmaValue }    = require('../utils/companySettings');
const { sendEmail }                  = require('../utils/notifier');
const { generateDocumentPDF, generateDocumentPDFBuffer } = require('../utils/pdfGenerator');
const { buildXRechnungXml, validateXRechnung } = require('../utils/xrechnung');
const { buildDatevCsv }               = require('../utils/datevExport');
const { parseBankCsv, matchAndBookPayments } = require('../utils/bankImport');
const multer = require('multer');
const htmlText = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bankUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const { nextDocumentNumber, reserveDocumentNumber } = require('../utils/documentNumbers');
// Public supplement approvals retain their existing token access. All internal
// document operations share the same document and amount permissions.
router.use((req, res, next) => {
  if (/^\/nachtrag\/approve\//.test(req.path)) return next();
  requireOffice(req, res, async () => {
    try {
      const firma = await getFirma();
      if (!hasPerm(req.user, 'documents', firma, true, false)) return res.status(403).send('Keine Berechtigung für Belege.');
      const financial = !['GET','HEAD'].includes(req.method) && req.path !== '/wizard/customer' || /\/(pdf|pdf-download|pdf-preview|xrechnung|datev-export)$/.test(req.path);
      if (financial && !canSeeMoney(req.user, firma)) return res.status(403).send('Keine Berechtigung für Beträge.');
      next();
    } catch (error) { next(error); }
  });
});
router.use(require('./billingRoutes'));

// ══════════════════════════════════════════════════════════════
// ANGEBOTE
// ══════════════════════════════════════════════════════════════


// POST: Angebot → Rechnung umwandeln
async function convertOfferToInvoice(req, res) {
  const firma = await bueroGuard(req, res);
  if (!firma) return;
  try {
    const docId = await withTransaction(async tx => {
      const offerRes = await tx.query("SELECT * FROM documents WHERE id = ? AND doc_type = 'OFFER'" + (isPg ? ' FOR UPDATE' : ''), [req.params.offerId || req.body.offer_id]);
      const offer = offerRes.rows[0];
      if (!offer) { const error = Error('Angebot nicht gefunden.'); error.status = 404; throw error; }
      // Acceptance can also mean conversion to a project; track the actual invoice separately.
      const previous = await tx.query("SELECT id FROM documents WHERE doc_type = 'INVOICE' AND related_document_id = ? ORDER BY id LIMIT 1", [offer.id]);
      if (previous.rows.length) return previous.rows[0].id;
      const number = await nextDocumentNumber(tx, 'INVOICE', String(firma.invoice_prefix || 'RECH').toUpperCase(), new Date().getFullYear());
      const due = new Date(); due.setDate(due.getDate() + (parseInt(firma.zahlungsfrist, 10) || 14));
      const returning = isPg ? ' RETURNING id' : '';
      const result = await tx.query(`INSERT INTO documents (doc_type,doc_number,customer_id,status,tax_rate,subtotal,tax_amount,total_amount,due_date,discount_percent,discount_amount,related_document_id) VALUES ('INVOICE',?,?,'ENTWURF',?,?,?,?,?,?,?,?)${returning}`,
        [number,offer.customer_id,offer.tax_rate ?? 19,offer.subtotal || 0,offer.tax_amount || 0,offer.total_amount || 0,due.toISOString().slice(0,10),offer.discount_percent || 0,offer.discount_amount || 0,offer.id]);
      const id = result.lastID || result.rows?.[0]?.id;
      if (!id) throw Error('Rechnungskennung konnte nicht ermittelt werden.');
      const items = await tx.query('SELECT * FROM document_items WHERE document_id = ? ORDER BY id', [offer.id]);
      for (const item of items.rows) await tx.query('INSERT INTO document_items (document_id,description,quantity,unit,price,discount_percent) VALUES (?,?,?,?,?,?)', [id,item.description,item.quantity,item.unit,item.price,item.discount_percent || 0]);
      await tx.query("UPDATE documents SET status = 'ANGENOMMEN' WHERE id = ?", [offer.id]);
      return id;
    });
    res.redirect(req.params.offerId ? '/documents/invoices' : '/documents/invoices/' + docId);
  } catch (err) {
    if (err.status) return res.status(err.status).send(err.message);
    console.error('Fehler beim Umwandeln Angebot→Rechnung:', err.message);
    res.status(500).send('Fehler beim Umwandeln.');
  }
}
router.post('/offers/convert-to-invoice', requireOffice, convertOfferToInvoice);


// POST: Angebot → Projekt umwandeln
router.post('/offers/convert-to-project', requireOffice, async (req,res) => {
  try {
    const id=await withTransaction(async tx=>{
      const offer=(await tx.query("SELECT * FROM documents WHERE id=? AND doc_type='OFFER'"+(isPg?' FOR UPDATE':''),[req.body.offer_id])).rows[0];
      if(!offer)throw Object.assign(Error('Angebot nicht gefunden.'),{status:404});
      const existing=(await tx.query('SELECT id FROM projects WHERE offer_id=? AND deleted_at IS NULL ORDER BY id LIMIT 1',[offer.id])).rows[0];
      if(existing)return existing.id;
      const customer=(await tx.query('SELECT company_name,contact_person FROM customers WHERE id=?',[offer.customer_id])).rows[0];
      const result=await tx.query("INSERT INTO projects(customer_id,title,description,total_price,status,offer_id) VALUES(?,?,?,?,'In Planung',?)"+(isPg?' RETURNING id':''),[offer.customer_id,`Auftrag aus ${offer.doc_number} – ${customer?.company_name||customer?.contact_person||'Kunde'}`,`Erstellt aus Angebot ${offer.doc_number}`,offer.total_amount||0,offer.id]);
      await tx.query("UPDATE documents SET status='ANGENOMMEN' WHERE id=?",[offer.id]);
      return result.lastID||result.rows[0].id;
    });
    res.redirect('/auftragszentrale/'+id);
  } catch(e) { console.error('Angebot → Auftrag:',e.message); res.status(e.status||500).send(e.status?e.message:'Auftrag konnte nicht angelegt werden.'); }
});

// GET: Angebots-PDF — inline im Browser (echter PDF-Stream)
router.get('/offers/:id/pdf', requireOffice, async (req, res) => {
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
router.get('/offers/:id/pdf-download', requireOffice, async (req, res) => {
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


// GET: DATEV-Export (Buchungsstapel) für einen Zeitraum herunterladen
router.get('/invoices/datev-export', requireOffice, async (req, res) => {
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
router.post('/api/save-catalog-items', requireOffice, async (req, res) => {
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


// POST: Mahnung erstellen (Mahnstufe + optionale Mahngebühr + PDF)
router.post('/invoices/:id/create-dunning', requireOffice, async (req, res) => {
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


// POST: Zahlung buchen


// POST: Zahlung löschen


// POST: Rechnung per E-Mail senden (PDF-Anhang)
router.post('/invoices/:id/send-email', requireOffice, async (req, res) => {
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
    const html = `<p>${htmlText(message || `Anbei erhalten Sie ${docLabel} ${docNr} als PDF.`).replace(/\n/g, '<br>')}</p>
      <p>Mit freundlichen Grüßen<br>${htmlText(firma.name || '')}</p>`;
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
    } catch (e) { console.error('⚠️ POST /invoices/:id/send-email:', e.message); }
    res.redirect(`/documents/invoices/${id}?sent=1`);
  } catch (err) {
    console.error('send-email:', err.message);
    res.status(500).send('Fehler beim E-Mail-Versand: ' + err.message);
  }
});

// POST: Rechnung stornieren
router.post('/invoices/:id/storno', requireOffice, async (req, res) => {
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
router.post('/invoices/:id/credit-note', requireOffice, async (req, res) => {
  const { id } = req.params;
  try {
    const firma = await getFirma();
    const invRes = await dbQuery(`SELECT * FROM documents WHERE id = ? AND doc_type = 'INVOICE'`, [id]);
    const inv = invRes.rows?.[0];
    if (!inv) return res.status(404).send('Rechnung nicht gefunden.');
    const year = new Date().getFullYear();
    const prefix = (firma.credit_prefix || 'GS').toUpperCase();
    const docNumber = await reserveDocumentNumber('CREDIT', prefix, year);
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
router.get('/open-items', requireOffice, async (req, res) => {
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


// A successfully generated invoice PDF also issues drafts for postal delivery.
async function invoicePDF(req, res) {
  try {
    const result = await dbQuery(`SELECT d.*, c.company_name,c.contact_person,c.street,c.zip,c.city,c.email,c.phone,
      d.doc_number AS invoice_number FROM documents d LEFT JOIN customers c ON d.customer_id=c.id
      WHERE d.id=? AND d.doc_type IN ('INVOICE','CREDIT')`, [req.params.id]);
    const invoice = result.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden.');
    const items = (await dbQuery('SELECT * FROM document_items WHERE document_id=? ORDER BY id', [invoice.id])).rows;
    const preview = req.path.endsWith('/pdf-preview');
    const buffer = await generateDocumentPDFBuffer(preview ? {...invoice, preview:true} : invoice, items);
    if (req.method === 'GET' && !preview && invoice.doc_type === 'INVOICE') {
      const billing = require('../utils/billingService');
      await billing.issue(invoice.id, billing.revision(invoice, items));
    }
    const label = invoice.doc_type === 'CREDIT' ? 'Gutschrift' : 'Rechnung';
    const name = String(invoice.doc_number || invoice.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`${req.path.endsWith('/pdf-download')?'attachment':'inline'}; filename="${label}-${name}.pdf"`);
    res.setHeader('Cache-Control','no-store');
    res.send(buffer);
  } catch (error) {
    console.error('Rechnungs-PDF:', error.message);
    if (!res.headersSent) res.status(error.status || 500).send(error.status ? error.message : 'PDF konnte nicht erstellt werden.');
  }
}
router.get('/invoices/:id/pdf-preview', requireOffice, invoicePDF);
router.get('/invoices/:id/pdf', requireOffice, invoicePDF);
router.get('/invoices/:id/pdf-download', requireOffice, invoicePDF);

// ══════════════════════════════════════════════════════════════
// KALKULATIONSVORLAGEN
// ══════════════════════════════════════════════════════════════

// GET: Vorlagen-Übersicht (JSON für Modal)
router.get('/templates', requireOffice, async (req, res) => {
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
router.get('/templates/:id', requireOffice, async (req, res) => {
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
router.post('/templates/create', requireOffice, async (req, res) => {
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
router.post('/templates/delete', requireOffice, async (req, res) => {
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
router.get('/offers/:id/nachtraege', requireOffice, async (req, res) => {
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
router.post('/offers/:id/nachtraege/create', requireOffice, async (req, res) => {
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
router.post('/nachtraege/:id/status', requireOffice, async (req, res) => {
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
router.post('/nachtraege/:id/delete', requireOffice, async (req, res) => {
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


// ══════════════════════════════════════════════════════════════
// STAHLPREISE
// ══════════════════════════════════════════════════════════════

// GET: Aktuelle Preise (JSON) – für Frontend-Widget
router.get('/steel-prices', requireOffice, async (req, res) => {
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
router.post('/steel-prices/update', requireOffice, async (req, res) => {
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
router.get('/steel-prices/history/:material', requireOffice, async (req, res) => {
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
router.post('/convert-to-invoice/:offerId', requireOffice, convertOfferToInvoice);


// GET: E-Rechnung XRechnung 3.0 XML
router.get('/invoices/:id/xrechnung', requireOffice, async (req, res) => {
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
    const check = validateXRechnung({
      invoice, items: itemsRes.rows || [], customer, firma
    });
    if (req.query.check === '1' || req.query.validate === '1') {
      return res.json(check);
    }
    if (!check.ok && req.query.force !== '1') {
      return res.status(400).send(
        'E-Rechnung unvollständig:\n- ' + check.errors.join('\n- ') +
        (check.warnings.length ? '\n\nHinweise:\n- ' + check.warnings.join('\n- ') : '') +
        '\n\nKundenakte öffnen und Leitweg-ID pflegen, oder mit ?force=1 trotzdem laden.'
      );
    }
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


// ==========================================
// LIEFERSCHEIN
// ==========================================
router.post('/delivery/create', requireOffice, async (req, res) => {
  try {
    const { customer_id, project_id, related_document_id, note } = req.body;
    if (!customer_id) return res.status(400).send('customer_id erforderlich');
    const year = new Date().getFullYear();
    const docNumber = await reserveDocumentNumber('DELIVERY', 'LS', year);
    const ins = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount, project_id, related_document_id)
       VALUES ('DELIVERY', ?, ?, 'OFFEN', 0, 0, 0, 0, ?, ?)`,
      [docNumber, customer_id, project_id || null, related_document_id || null]
    );
    const newId = ins.lastID || ins.rows?.[0]?.id;
    // optional: copy items from related invoice/offer
    if (related_document_id) {
      const items = await dbQuery(`SELECT * FROM document_items WHERE document_id = ?`, [related_document_id]);
      for (const it of (items.rows || [])) {
        await dbQuery(
          `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)`,
          [newId, it.description, it.quantity, it.unit, 0]
        );
      }
    }
    if (note) {
      await dbQuery(`INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, 1, 'pausch', 0)`,
        [newId, note]);
    }
    res.redirect('/documents/delivery/' + newId);
  } catch (err) {
    console.error('Lieferschein create:', err.message);
    res.status(500).send('Fehler: ' + err.message);
  }
});

router.get('/delivery/:id', requireOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const docRes = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'DELIVERY'`, [id]);
    const doc = docRes.rows?.[0];
    if (!doc) return res.status(404).send('Lieferschein nicht gefunden');
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id`, [id]);
    res.render('delivery-detail', {
      delivery: doc,
      items: itemsRes.rows || [],
      user: req.user,
      currentUser: req.user
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/delivery/:id/items', requireOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const { description, quantity, unit } = req.body;
    if (!description) return res.status(400).send('Beschreibung fehlt');
    await dbQuery(
      `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, 0)`,
      [id, description, quantity || 1, unit || 'Stk']
    );
    res.redirect('/documents/delivery/' + id);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/delivery/:id/status', requireOffice, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await dbQuery(`UPDATE documents SET status = ? WHERE id = ? AND doc_type = 'DELIVERY'`, [status || 'OFFEN', id]);
    res.redirect('/documents/delivery/' + id);
  } catch (err) {
    res.status(500).send(err.message);
  }
});


// ADMIN: Alle Belege zurücksetzen
router.post('/admin/reset-documents', requireAdmin, async (req, res) => {
  try {
    const confirm = (req.body.confirm || '').toString().trim().toUpperCase();
    if (confirm !== 'RESET') {
      return res.status(400).send('Zur Bestätigung muss confirm=RESET gesendet werden.');
    }
    try { await dbQuery(`DELETE FROM invoice_payments`); } catch (e) { console.error('⚠️ POST /admin/reset-documents:', e.message); }
    try { await dbQuery(`DELETE FROM dunning_history`); } catch (e) { console.error('⚠️ POST /admin/reset-documents:', e.message); }
    try { await dbQuery(`DELETE FROM document_items`); } catch (e) { console.error('⚠️ POST /admin/reset-documents:', e.message); }
    try { await dbQuery(`DELETE FROM offer_nachtrag_items`); } catch (e) { console.error('⚠️ POST /admin/reset-documents:', e.message); }
    try { await dbQuery(`DELETE FROM offer_nachtraege`); } catch (e) { console.error('⚠️ POST /admin/reset-documents:', e.message); }
    await dbQuery(`DELETE FROM documents`);
    console.log('[Admin] Alle Belege gelöscht von', req.user && req.user.username);
    res.redirect('/documents/invoices?reset=ok');
  } catch (err) {
    console.error('reset-documents:', err.message);
    res.status(500).send('Reset fehlgeschlagen: ' + err.message);
  }
});


// ══════════════════════════════════════════════════════════════
// BANK-CSV-IMPORT (Zahlungsabgleich)
// ══════════════════════════════════════════════════════════════
router.get('/bank-import', requireOffice, async (req, res) => {
  try {
    const logs = await dbQuery(`SELECT * FROM bank_import_log ORDER BY imported_at DESC LIMIT 20`).catch(() => ({ rows: [] }));
    res.render('bank-import', { logs: logs.rows || [], result: null, firma: await getFirma() });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/bank-import', requireOffice, bankUpload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Keine CSV-Datei hochgeladen.');
    const text = req.file.buffer.toString('utf8');
    const entries = parseBankCsv(text);
    const dryRun = req.body.dry_run === '1' || req.body.dry_run === 'true';
    const result = await matchAndBookPayments(entries, { dryRun });
    if (!dryRun) {
      await dbQuery(
        `INSERT INTO bank_import_log (filename, matched, unmatched, note) VALUES (?, ?, ?, ?)`,
        [req.file.originalname || 'import.csv', result.matched.length, result.unmatched.length, dryRun ? 'Vorschau' : 'Import']
      ).catch(() => {});
    }
    const logs = await dbQuery(`SELECT * FROM bank_import_log ORDER BY imported_at DESC LIMIT 20`).catch(() => ({ rows: [] }));
    res.render('bank-import', {
      logs: logs.rows || [],
      result,
      dryRun,
      firma: await getFirma(),
    });
  } catch (err) {
    console.error('bank-import:', err.message);
    res.status(500).send('Import-Fehler: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════
// TEIL- / SCHLUSSRECHNUNG aus bestehender Rechnung
// ══════════════════════════════════════════════════════════════
router.post('/invoices/:id/create-partial', requireOffice, async (req, res) => {
  const { id } = req.params;
  const percent = parseFloat(req.body.percent) || 30;
  try {
    const invRes = await dbQuery(`SELECT * FROM documents WHERE id = ? AND doc_type = 'INVOICE'`, [id]);
    const inv = invRes.rows?.[0];
    if (!inv) return res.status(404).send('Rechnung nicht gefunden.');

    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ?`, [id]);
    const firma = await getFirma();
    const invPfx = (firma.invoice_prefix || 'RECH').toUpperCase();
    const year = new Date().getFullYear();
    const invoiceNumber = await reserveDocumentNumber('INVOICE', invPfx, year);

    const factor = Math.min(100, Math.max(1, percent)) / 100;
    let subtotal = 0;
    const newItems = (itemsRes.rows || []).map((it) => {
      const q = (parseFloat(it.quantity) || 0) * factor;
      const p = parseFloat(it.price) || 0;
      const d = parseFloat(it.discount_percent) || 0;
      subtotal += q * p * (1 - d / 100);
      return { ...it, quantity: q };
    });
    const taxRate = parseFloat(inv.tax_rate != null ? inv.tax_rate : 19);
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;
    const due = new Date();
    due.setDate(due.getDate() + (firma.zahlungsfrist || 14));

    const ins = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount, due_date, invoice_subtype, related_document_id, parent_document_id, project_id)
       VALUES ('INVOICE', ?, ?, 'ENTWURF', ?, ?, ?, ?, ?, 'PARTIAL', ?, ?, ?)`,
      [invoiceNumber, inv.customer_id, taxRate, subtotal, taxAmount, totalAmount, due.toISOString().slice(0, 10), id, id, inv.project_id || null]
    );
    const newId = ins.lastID || ins.rows?.[0]?.id;
    for (const it of newItems) {
      await dbQuery(
        `INSERT INTO document_items (document_id, description, quantity, unit, price, discount_percent) VALUES (?, ?, ?, ?, ?, ?)`,
        [newId, (it.description || '') + ` (Teil ${percent} %)`, it.quantity, it.unit || 'Stk', it.price, it.discount_percent || 0]
      );
    }
    res.redirect('/documents/invoices/' + newId);
  } catch (err) {
    console.error('create-partial:', err.message);
    res.status(500).send('Teilrechnung fehlgeschlagen: ' + err.message);
  }
});

router.post('/invoices/:id/create-final', requireOffice, async (req, res) => {
  const { id } = req.params;
  try {
    const invRes = await dbQuery(`SELECT * FROM documents WHERE id = ? AND doc_type = 'INVOICE'`, [id]);
    const inv = invRes.rows?.[0];
    if (!inv) return res.status(404).send('Rechnung nicht gefunden.');

    // Summe bisheriger Teilrechnungen (related oder parent)
    const parts = await dbQuery(
      `SELECT COALESCE(SUM(total_amount), 0) AS sum FROM documents
       WHERE doc_type = 'INVOICE' AND invoice_subtype = 'PARTIAL'
         AND (related_document_id = ? OR parent_document_id = ?)
         AND status != 'Storniert'`,
      [id, id]
    );
    const alreadyBilled = parseFloat(parts.rows?.[0]?.sum || 0);
    const fullTotal = parseFloat(inv.total_amount || 0);
    const remaining = Math.max(0, fullTotal - alreadyBilled);

    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ?`, [id]);
    const firma = await getFirma();
    const invPfx = (firma.invoice_prefix || 'RECH').toUpperCase();
    const year = new Date().getFullYear();
    const invoiceNumber = await reserveDocumentNumber('INVOICE', invPfx, year);

    const taxRate = parseFloat(inv.tax_rate != null ? inv.tax_rate : 19);
    // Restbetrag als eine Position
    const netRemaining = taxRate > 0 ? remaining / (1 + taxRate / 100) : remaining;
    const taxAmount = remaining - netRemaining;
    const due = new Date();
    due.setDate(due.getDate() + (firma.zahlungsfrist || 14));

    const ins = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount, due_date, invoice_subtype, related_document_id, parent_document_id, project_id)
       VALUES ('INVOICE', ?, ?, 'ENTWURF', ?, ?, ?, ?, ?, 'FINAL', ?, ?, ?)`,
      [invoiceNumber, inv.customer_id, taxRate, netRemaining, taxAmount, remaining, due.toISOString().slice(0, 10), id, id, inv.project_id || null]
    );
    const newId = ins.lastID || ins.rows?.[0]?.id;
    await dbQuery(
      `INSERT INTO document_items (document_id, description, quantity, unit, price, discount_percent) VALUES (?, ?, ?, ?, ?, ?)`,
      [newId, `Schlussrechnung zu ${inv.doc_number} – Restbetrag (bisher abgerechnet: ${alreadyBilled.toFixed(2)} €)`, 1, 'Psch', netRemaining, 0]
    );
    res.redirect('/documents/invoices/' + newId);
  } catch (err) {
    console.error('create-final:', err.message);
    res.status(500).send('Schlussrechnung fehlgeschlagen: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════
// WIEDERKEHRENDE RECHNUNGEN
// ══════════════════════════════════════════════════════════════
router.get('/recurring', requireOffice, async (req, res) => {
  try {
    const rows = await dbQuery(`
      SELECT r.*, c.company_name, c.contact_person
      FROM recurring_invoices r
      LEFT JOIN customers c ON r.customer_id = c.id
      ORDER BY r.active DESC, r.next_due_date ASC
    `).catch(() => ({ rows: [] }));
    const customers = await dbQuery(`SELECT id, company_name, contact_person FROM customers ORDER BY company_name`).catch(() => ({ rows: [] }));
    res.render('recurring-invoices', {
      items: rows.rows || [],
      customers: customers.rows || [],
      firma: await getFirma(),
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/recurring/create', requireOffice, async (req, res) => {
  try {
    const { customer_id, title, interval_months, next_due_date, tax_rate, line_desc, line_qty, line_price } = req.body;
    const template = JSON.stringify({
      items: [{
        description: line_desc || title || 'Wiederkehrende Leistung',
        quantity: parseFloat(line_qty) || 1,
        unit: 'Stk',
        price: parseFloat(line_price) || 0,
      }],
    });
    await dbQuery(
      `INSERT INTO recurring_invoices (customer_id, title, interval_months, next_due_date, active, tax_rate, template_json)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [customer_id, title || 'Abo', parseInt(interval_months, 10) || 1, next_due_date || new Date().toISOString().slice(0, 10), parseFloat(tax_rate) || 19, template]
    );
    res.redirect('/documents/recurring');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/recurring/:id/toggle', requireOffice, async (req, res) => {
  try {
    const row = (await dbQuery(`SELECT active FROM recurring_invoices WHERE id = ?`, [req.params.id])).rows?.[0];
    if (row) {
      await dbQuery(`UPDATE recurring_invoices SET active = ? WHERE id = ?`, [row.active ? 0 : 1, req.params.id]);
    }
    res.redirect('/documents/recurring');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/recurring/:id/generate', requireOffice, async (req, res) => {
  try {
    const r = (await dbQuery(`SELECT * FROM recurring_invoices WHERE id = ?`, [req.params.id])).rows?.[0];
    if (!r) return res.status(404).send('Nicht gefunden');
    const firma = await getFirma();
    const invPfx = (firma.invoice_prefix || 'RECH').toUpperCase();
    const year = new Date().getFullYear();
    const invoiceNumber = await reserveDocumentNumber('INVOICE', invPfx, year);
    let items = [];
    try { items = JSON.parse(r.template_json || '{}').items || []; } catch (_) {}
    let subtotal = 0;
    items.forEach((it) => { subtotal += (parseFloat(it.quantity) || 0) * (parseFloat(it.price) || 0); });
    const taxRate = parseFloat(r.tax_rate) || 19;
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;
    const due = r.next_due_date || new Date().toISOString().slice(0, 10);

    const ins = await dbQuery(
      `INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount, due_date, recurring_id)
       VALUES ('INVOICE', ?, ?, 'ENTWURF', ?, ?, ?, ?, ?, ?)`,
      [invoiceNumber, r.customer_id, taxRate, subtotal, taxAmount, totalAmount, due, r.id]
    );
    const newId = ins.lastID || ins.rows?.[0]?.id;
    for (const it of items) {
      await dbQuery(
        `INSERT INTO document_items (document_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)`,
        [newId, it.description || r.title, it.quantity || 1, it.unit || 'Stk', it.price || 0]
      );
    }
    // next due
    const next = new Date(due);
    next.setMonth(next.getMonth() + (parseInt(r.interval_months, 10) || 1));
    await dbQuery(
      `UPDATE recurring_invoices SET next_due_date = ?, last_generated_at = ? WHERE id = ?`,
      [next.toISOString().slice(0, 10), new Date().toISOString(), r.id]
    );
    res.redirect('/documents/invoices/' + newId);
  } catch (err) {
    console.error('recurring generate:', err.message);
    res.status(500).send(err.message);
  }
});

router.post('/recurring/:id/delete', requireOffice, async (req, res) => {
  try {
    await dbQuery(`DELETE FROM recurring_invoices WHERE id = ?`, [req.params.id]);
    res.redirect('/documents/recurring');
  } catch (err) {
    res.status(500).send(err.message);
  }
});


// ══════════════════════════════════════════════════════════════
// BÜRO – einfacher Einstieg + Schritt-für-Schritt-Assistent
// ══════════════════════════════════════════════════════════════

async function bueroGuard(req, res) {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'documents', firma, true, false)) {
    res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
    return null;
  }
  return firma;
}





// POST: Angebot per E-Mail senden (PDF im Anhang)
router.post('/offers/:id/send-email', requireOffice, async (req, res) => {
  const { id } = req.params;
  const to      = (req.body.to || '').trim();
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();
  const back = (q) => `/documents/fertig/${id}?${q}`;
  try {
    const firma = await getFirma();
    const r = await dbQuery(`
      SELECT d.*, c.company_name, c.contact_person, c.street, c.zip, c.city, c.email, c.phone,
             d.doc_number AS invoice_number
      FROM documents d LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ? AND d.doc_type = 'OFFER'`, [id]);
    const offer = r.rows?.[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden.');
    const emailTo = to || offer.email;
    if (!emailTo) return res.redirect(back('mailerr=' + encodeURIComponent('Keine E-Mail-Adresse eingetragen.')));
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`, [id]);
    const pdfBuf = await generateDocumentPDFBuffer(offer, itemsRes.rows || []);
    const nr = offer.doc_number || id;
    const html = `<p>${htmlText(message || `Anbei erhalten Sie unser Angebot ${nr} als PDF.`).replace(/\n/g, '<br>')}</p>
      <p>Mit freundlichen Grüßen<br>${htmlText(firma.name || '')}</p>`;
    const result = await sendEmail(emailTo, subject || `Angebot ${nr}`, html,
      [{ filename: `Angebot-${nr}.pdf`, content: pdfBuf, contentType: 'application/pdf' }]);
    if (!result.ok) {
      return res.redirect(back('mailerr=' + encodeURIComponent('E-Mail konnte nicht gesendet werden: ' + (result.error || 'unbekannt'))));
    }
    try { await dbQuery(`UPDATE documents SET sent_at = ? WHERE id = ?`, [new Date().toISOString(), id]); } catch (e) { console.error('⚠️ POST /offers/:id/send-email:', e.message); }
    res.redirect(back('sent=1'));
  } catch (err) {
    console.error('Angebot send-email:', err.message);
    res.redirect(back('mailerr=' + encodeURIComponent('E-Mail-Versand fehlgeschlagen.')));
  }
});


// ── Kunden-Freigabe-Link für Angebot ─────────────────────────────────────────
router.post('/offers/:id/share-link', requireOffice, async (req, res) => {
  try {
    const id = req.params.id;
    const offer = (await dbQuery(`SELECT id, doc_type FROM documents WHERE id = ? AND doc_type = 'OFFER'`, [id])).rows?.[0];
    if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const days = Math.min(90, Math.max(1, parseInt(req.body.expires_days, 10) || 30));
    const expires = new Date(Date.now() + days * 86400000).toISOString();

    await dbQuery(
      `INSERT INTO document_share_tokens (document_id, token_hash, token_hint, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, tokenHash, rawToken.slice(-6), expires, req.user?.id || null]
    );

    const base = (process.env.APP_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    const url = `${base}/angebot-freigabe/${rawToken}`;

    if (req.accepts('html') && !req.xhr && !String(req.headers.accept || '').includes('application/json')) {
      return res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Freigabe-Link</title>
        <style>body{font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 16px}
        input{width:100%;padding:12px;font-size:14px;border:1px solid #cbd5e1;border-radius:8px}
        a{color:#2563eb}</style></head><body>
        <h1>Kunden-Freigabe-Link</h1>
        <p>Gültig ${days} Tage. Link einmal kopieren – der Token wird nicht erneut angezeigt.</p>
        <input readonly value="${url.replace(/"/g, '&quot;')}" onclick="this.select()">
        <p style="margin-top:1.5rem"><a href="/documents/offers/${id}/detail">← Zurück zum Angebot</a></p>
        </body></html>`);
    }
    res.json({ url, expires_at: expires, hint: rawToken.slice(-6) });
  } catch (err) {
    console.error('share-link:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/offers/:id/share-links', requireOffice, async (req, res) => {
  try {
    const rows = (await dbQuery(
      `SELECT id, token_hint, expires_at, approved_at, rejected_at, signer_name, created_at, revoked_at
       FROM document_share_tokens WHERE document_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    )).rows || [];
    res.json({ links: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/offers/:id/share-links/:shareId/revoke', requireOffice, async (req, res) => {
  try {
    await dbQuery(
      `UPDATE document_share_tokens SET revoked_at = ? WHERE id = ? AND document_id = ?`,
      [new Date().toISOString(), req.params.shareId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
