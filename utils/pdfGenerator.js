const PDFDocument = require('pdfkit');
const { getFirma } = require('./companySettings');

/**
 * Erzeugt ein vollständiges Rechnungs- oder Angebots-PDF mit PDFKit.
 * Streamt das Ergebnis direkt an das Express-Response-Objekt.
 *
 * @param {object} invoice   - Datensatz aus der documents-Tabelle (inkl. customer-Felder)
 * @param {Array}  items     - Positionen aus document_items
 * @param {object} res       - Express Response — Content-Type und Stream werden hier gesetzt
 * @param {'inline'|'attachment'} disposition - inline = Vorschau, attachment = Download
 */
async function generateDocumentPDF(invoice, items, res, disposition = 'attachment') {
  const firma = await getFirma();

  const isOffer   = invoice.doc_type === 'OFFER';
  const isDunning = (invoice.dunning_level || 0) > 0;
  const docLabel  = isOffer ? 'Angebot' : (isDunning ? 'Mahnung' : 'Rechnung');
  const docNr     = invoice.invoice_number || invoice.doc_number || '';

  const taxRate = parseFloat(invoice.tax_rate || firma.default_tax_rate || 19);
  const subtotal = items.reduce(
    (s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.price) || 0), 0
  );
  const tax   = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  const fmt     = n => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const fmtDate = d => { try { return new Date(d).toLocaleDateString('de-DE'); } catch (_) { return ''; } };

  // ── Dokument konfigurieren ──────────────────────────────────────────────────
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

  const safeName = docNr.replace(/[^a-zA-Z0-9_\-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${docLabel}-${safeName}.pdf"`
  );
  doc.pipe(res);

  // ── Farben & Fonts ──────────────────────────────────────────────────────────
  const accentColor = firma.pdf_color || '#1e3a5f';
  const PAGE_W = doc.page.width  - doc.page.margins.left - doc.page.margins.right;

  // ─────────────────────────────────────────────────────────────────────────────
  // BRIEFKOPF
  // ─────────────────────────────────────────────────────────────────────────────

  // Firmenname links
  doc.fontSize(18).fillColor(accentColor).font('Helvetica-Bold')
     .text((firma.name || 'Ihre Firma').toUpperCase(), doc.page.margins.left, 50, { width: PAGE_W * 0.55 });

  if (firma.slogan) {
    doc.fontSize(8).fillColor('#888888').font('Helvetica')
       .text(firma.slogan, doc.page.margins.left, doc.y, { width: PAGE_W * 0.55 });
  }

  // Kontaktdaten rechts
  const contactLines = [
    firma.name,
    firma.strasse,
    firma.plzOrt,
    firma.tel   ? `Tel: ${firma.tel}` : null,
    firma.email,
    firma.web,
    firma.steuernr
  ].filter(Boolean);

  const contactBlockY = 50;
  const contactX      = doc.page.margins.left + PAGE_W * 0.60;
  doc.fontSize(8).fillColor('#555555').font('Helvetica');
  contactLines.forEach((line, i) => {
    doc.text(line, contactX, contactBlockY + i * 12, { width: PAGE_W * 0.40, align: 'right' });
  });

  // Trennlinie
  const lineY = Math.max(doc.y, contactBlockY + contactLines.length * 12) + 8;
  doc.moveTo(doc.page.margins.left, lineY)
     .lineTo(doc.page.margins.left + PAGE_W, lineY)
     .lineWidth(1.5).strokeColor(accentColor).stroke();

  // ─────────────────────────────────────────────────────────────────────────────
  // EMPFÄNGER + DOKUMENT-META
  // ─────────────────────────────────────────────────────────────────────────────
  const sectionY = lineY + 16;
  const metaX    = doc.page.margins.left + PAGE_W * 0.55;

  // Absender-Zeile (Mini)
  doc.fontSize(7).fillColor('#aaaaaa').font('Helvetica')
     .text(
       [firma.name, firma.strasse, firma.plzOrt].filter(Boolean).join(' · '),
       doc.page.margins.left, sectionY, { width: PAGE_W * 0.50 }
     );

  // Empfänger
  const recipientY = sectionY + 14;
  doc.fontSize(11).fillColor('#111111').font('Helvetica-Bold')
     .text(invoice.company_name || invoice.contact_person || '–', doc.page.margins.left, recipientY);
  doc.fontSize(9).fillColor('#444444').font('Helvetica');
  if (invoice.company_name && invoice.contact_person) {
    doc.text(`z. Hd. ${invoice.contact_person}`);
  }
  if (invoice.street) doc.text(invoice.street);
  if (invoice.zip || invoice.city) {
    doc.text([invoice.zip, invoice.city].filter(Boolean).join(' '));
  }

  // Metadaten-Block (rechts)
  const metaRows = [
    ['Dokument:', docLabel],
    [isOffer ? 'Angebots-Nr.:' : 'Rechnungs-Nr.:', docNr],
    ['Datum:', fmtDate(invoice.created_at)],
  ];
  if (!isOffer && invoice.due_date) {
    metaRows.push(['Fällig am:', fmtDate(invoice.due_date)]);
  }
  const metaColW = PAGE_W * 0.45;
  doc.fontSize(8).fillColor('#555555').font('Helvetica');
  metaRows.forEach(([label, value], i) => {
    const rowY = sectionY + i * 14;
    doc.text(label, metaX, rowY, { width: metaColW * 0.48 });
    doc.font('Helvetica-Bold').text(value, metaX + metaColW * 0.50, rowY, { width: metaColW * 0.50 });
    doc.font('Helvetica');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // BETREFF
  // ─────────────────────────────────────────────────────────────────────────────
  const titleY = Math.max(doc.y, sectionY + metaRows.length * 14) + 24;
  doc.fontSize(14).fillColor('#111111').font('Helvetica-Bold')
     .text(`${docLabel} Nr. ${docNr}`, doc.page.margins.left, titleY);

  const introText = isOffer
    ? (firma.pdf_intro_offer  || 'Sehr geehrte Damen und Herren,\nvielen Dank für Ihre Anfrage. Wir unterbreiten Ihnen folgendes Angebot:')
    : (firma.pdf_intro_invoice || 'Sehr geehrte Damen und Herren,\nwir erlauben uns, folgende Leistungen in Rechnung zu stellen:');

  doc.fontSize(9).fillColor('#555555').font('Helvetica')
     .text(introText, doc.page.margins.left, doc.y + 6, { width: PAGE_W });

  // ─────────────────────────────────────────────────────────────────────────────
  // POSITIONSTABELLE
  // ─────────────────────────────────────────────────────────────────────────────
  const tableTop = doc.y + 14;
  const COL = {
    pos:   { x: doc.page.margins.left,           w: 28 },
    desc:  { x: doc.page.margins.left + 28,      w: PAGE_W - 28 - 70 - 80 - 80 },
    qty:   { x: doc.page.margins.left + 28 + (PAGE_W - 28 - 70 - 80 - 80), w: 70 },
    price: { x: doc.page.margins.left + 28 + (PAGE_W - 28 - 70 - 80 - 80) + 70, w: 80 },
    total: { x: doc.page.margins.left + 28 + (PAGE_W - 28 - 70 - 80 - 80) + 70 + 80, w: 80 },
  };

  // Tabellenkopf
  doc.rect(doc.page.margins.left, tableTop, PAGE_W, 16).fill(accentColor);
  const headerTextY = tableTop + 4;
  doc.fontSize(7.5).fillColor('#ffffff').font('Helvetica-Bold');
  doc.text('Pos.',        COL.pos.x   + 2, headerTextY, { width: COL.pos.w   - 4 });
  doc.text('Bezeichnung', COL.desc.x  + 2, headerTextY, { width: COL.desc.w  - 4 });
  doc.text('Menge',       COL.qty.x   + 2, headerTextY, { width: COL.qty.w   - 4, align: 'right' });
  doc.text('Einzelpreis', COL.price.x + 2, headerTextY, { width: COL.price.w - 4, align: 'right' });
  doc.text('Gesamt',      COL.total.x + 2, headerTextY, { width: COL.total.w - 4, align: 'right' });

  // Zeilen
  let rowY = tableTop + 18;
  doc.font('Helvetica').fontSize(8.5);
  (items || []).forEach((item, idx) => {
    const lineTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0);
    const bg = idx % 2 === 0 ? '#f7f8fa' : '#ffffff';
    doc.rect(doc.page.margins.left, rowY - 2, PAGE_W, 16).fill(bg);
    doc.fillColor('#222222');
    doc.text(String(idx + 1), COL.pos.x   + 2, rowY, { width: COL.pos.w   - 4 });
    doc.text(item.description || '', COL.desc.x + 2, rowY, { width: COL.desc.w - 4 });
    doc.text(
      `${Number(item.quantity || 0).toLocaleString('de-DE')} ${item.unit || ''}`.trim(),
      COL.qty.x + 2, rowY, { width: COL.qty.w - 4, align: 'right' }
    );
    doc.text(fmt(item.price),    COL.price.x + 2, rowY, { width: COL.price.w - 4, align: 'right' });
    doc.text(fmt(lineTotal),     COL.total.x + 2, rowY, { width: COL.total.w - 4, align: 'right' });
    rowY += 16;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMENBLOCK
  // ─────────────────────────────────────────────────────────────────────────────
  const sumX  = COL.price.x;
  const sumW  = COL.price.w + COL.total.w;
  rowY += 6;
  doc.moveTo(doc.page.margins.left, rowY).lineTo(doc.page.margins.left + PAGE_W, rowY)
     .lineWidth(0.5).strokeColor('#cccccc').stroke();
  rowY += 6;

  doc.fontSize(8.5).fillColor('#555555').font('Helvetica');
  doc.text('Zwischensumme (Netto):', sumX, rowY, { width: COL.price.w - 4 });
  doc.text(fmt(subtotal), sumX + COL.price.w, rowY - doc.currentLineHeight(), { width: COL.total.w - 4, align: 'right' });
  rowY += 14;
  doc.text(`${taxRate} % MwSt.:`, sumX, rowY, { width: COL.price.w - 4 });
  doc.text(fmt(tax), sumX + COL.price.w, rowY - doc.currentLineHeight(), { width: COL.total.w - 4, align: 'right' });
  rowY += 14;

  doc.moveTo(sumX, rowY).lineTo(sumX + sumW, rowY).lineWidth(1).strokeColor(accentColor).stroke();
  rowY += 5;
  doc.fontSize(10).fillColor('#111111').font('Helvetica-Bold');
  doc.text('Gesamtbetrag (Brutto):', sumX, rowY, { width: COL.price.w - 4 });
  doc.text(fmt(total), sumX + COL.price.w, rowY - doc.currentLineHeight(), { width: COL.total.w - 4, align: 'right' });

  // ─────────────────────────────────────────────────────────────────────────────
  // ZAHLUNGSHINWEIS & BANKDATEN
  // ─────────────────────────────────────────────────────────────────────────────
  rowY = doc.y + 28;
  doc.moveTo(doc.page.margins.left, rowY).lineTo(doc.page.margins.left + PAGE_W, rowY)
     .lineWidth(0.5).strokeColor('#dddddd').stroke();
  rowY += 10;

  const paymentNote = isOffer
    ? `Dieses Angebot ist gültig für ${firma.angebotsgueltig || 30} Tage ab Ausstellungsdatum.`
    : `Zahlbar innerhalb von ${firma.zahlungsfrist || 14} Tagen ohne Abzug per ${firma.default_payment_method || 'Überweisung'}. Verwendungszweck: ${docNr}`;

  doc.fontSize(8.5).fillColor('#444444').font('Helvetica').text(paymentNote, doc.page.margins.left, rowY, { width: PAGE_W });
  rowY = doc.y + 10;

  // Bankdaten
  doc.rect(doc.page.margins.left, rowY, PAGE_W, 44).fill('#f7f8fa');
  const bankColW = PAGE_W / 3;
  doc.fontSize(7.5).fillColor('#111111').font('Helvetica-Bold');
  doc.text('Bankverbindung', doc.page.margins.left + 6, rowY + 5, { width: bankColW - 8 });
  doc.text('Kontakt',        doc.page.margins.left + bankColW + 6, rowY + 5, { width: bankColW - 8 });
  doc.text('Steuer',         doc.page.margins.left + bankColW * 2 + 6, rowY + 5, { width: bankColW - 8 });

  doc.font('Helvetica').fillColor('#555555');
  const bankLines = [firma.bank, firma.iban ? `IBAN: ${firma.iban}` : null, firma.bic ? `BIC: ${firma.bic}` : null].filter(Boolean);
  const contLines = [firma.tel, firma.email, firma.web].filter(Boolean);
  const taxLines  = [firma.steuernr].filter(Boolean);

  bankLines.forEach((l, i) => doc.text(l, doc.page.margins.left + 6,             rowY + 17 + i * 9, { width: bankColW - 8 }));
  contLines.forEach((l, i) => doc.text(l, doc.page.margins.left + bankColW + 6,  rowY + 17 + i * 9, { width: bankColW - 8 }));
  taxLines.forEach ((l, i) => doc.text(l, doc.page.margins.left + bankColW*2 + 6,rowY + 17 + i * 9, { width: bankColW - 8 }));

  // Optionaler Fußzeilentext
  if (firma.pdf_footer_text) {
    doc.moveDown(2);
    doc.fontSize(7.5).fillColor('#aaaaaa').font('Helvetica')
       .text(firma.pdf_footer_text, doc.page.margins.left, doc.y, { width: PAGE_W, align: 'center' });
  }

  doc.end();
}

module.exports = { generateDocumentPDF };
