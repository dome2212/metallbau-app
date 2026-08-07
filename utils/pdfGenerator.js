const PDFDocument = require('pdfkit');
const https       = require('https');
const http        = require('http');
const { getFirma } = require('./companySettings');

// ─────────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

/** Lädt eine Bild-URL und gibt einen Buffer zurück. null bei Fehler. */
function fetchImageBuffer(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on('data',  c  => chunks.push(c));
        res.on('end',   () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    } catch (_) {
      resolve(null);
    }
  });
}

/** Hex-Farbe aufhellen für Tabellen-Hintergrund */
function lightenHex(hex, pct = 0.92) {
  const n = parseInt((hex || '#1e3a5f').replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 0xff) + (255 - ((n >> 16) & 0xff)) * pct);
  const g = Math.round(((n >>  8) & 0xff) + (255 - ((n >>  8) & 0xff)) * pct);
  const b = Math.round(( n        & 0xff) + (255 - ( n        & 0xff)) * pct);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Haupt-Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erzeugt ein vollständiges Rechnungs- oder Angebots-PDF mit PDFKit.
 * Streamt das Ergebnis direkt an das Express-Response-Objekt.
 *
 * @param {object} invoice      - Datensatz aus documents-Tabelle (inkl. customer-Felder)
 * @param {Array}  items        - Positionen aus document_items
 * @param {object} res          - Express Response
 * @param {'inline'|'attachment'} disposition
 */
async function generateDocumentPDF(invoice, items, res, disposition = 'attachment') {
  const firma = await getFirma();

  // ── Dokument-Metadaten ────────────────────────────────────────────────────
  const isOffer   = invoice.doc_type === 'OFFER';
  const isDunning = (invoice.dunning_level || 0) > 0;
  const docLabel  = isOffer ? 'Angebot' : (isDunning ? 'Mahnung' : 'Rechnung');
  const docNr     = invoice.invoice_number || invoice.doc_number || '';
  const taxRate   = parseFloat(invoice.tax_rate || firma.default_tax_rate || 19);

  const subtotal = (items || []).reduce(
    (s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.price) || 0), 0
  );
  const tax   = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  const fmt     = n => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const fmtDate = d => { try { return new Date(d).toLocaleDateString('de-DE'); } catch (_) { return ''; } };

  // ── Design-Farben ─────────────────────────────────────────────────────────
  const accent      = firma.pdf_color || '#1e3a5f';
  const accentLight = lightenHex(accent, 0.90);

  // ── Logo vorab laden ──────────────────────────────────────────────────────
  let logoBuffer = null;
  const logoUrl  = firma.logo_url || firma.sidebar_logo_url || null;
  if (logoUrl && (logoUrl.startsWith('http://') || logoUrl.startsWith('https://'))) {
    logoBuffer = await fetchImageBuffer(logoUrl);
  }

  // ── PDFDocument initialisieren ────────────────────────────────────────────
  const doc = new PDFDocument({
    size:        'A4',
    margin:      50,
    bufferPages: true,
    info: {
      Title:   `${docLabel} ${docNr}`,
      Author:  firma.name || 'Metallbau',
      Subject: docLabel,
    }
  });

  const safeName = docNr.replace(/[^a-zA-Z0-9_\-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${docLabel}-${safeName}.pdf"`);
  doc.pipe(res);

  const ML = doc.page.margins.left;    // margin left  = 50
  const MR = doc.page.margins.right;   // margin right = 50
  const MT = doc.page.margins.top;     // margin top   = 50
  const PAGE_W  = doc.page.width  - ML - MR;  // nutzbare Breite = 495
  const PAGE_H  = doc.page.height - MT - doc.page.margins.bottom;

  // ═══════════════════════════════════════════════════════════════════════════
  // BRIEFKOPF
  // ═══════════════════════════════════════════════════════════════════════════

  const HEADER_TOP  = MT;              // y = 50
  const LOGO_MAX_W  = PAGE_W * 0.42;   // ~208 px
  const LOGO_MAX_H  = 72;
  const CONTACT_X   = ML + PAGE_W * 0.58;
  const CONTACT_W   = PAGE_W * 0.42;

  // ── Links: Logo oder Firmenname ───────────────────────────────────────────
  let headerBottomY = HEADER_TOP;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, ML, HEADER_TOP, {
        fit:    [LOGO_MAX_W, LOGO_MAX_H],
        align:  'left',
        valign: 'top',
      });
      headerBottomY = Math.max(headerBottomY, HEADER_TOP + LOGO_MAX_H);
    } catch (_) {
      // Bild-Fehler → Fallback Text
      logoBuffer = null;
    }
  }

  if (!logoBuffer) {
    doc.fontSize(20).fillColor(accent).font('Helvetica-Bold')
       .text((firma.name || 'Ihre Firma').toUpperCase(), ML, HEADER_TOP, { width: LOGO_MAX_W });
    headerBottomY = Math.max(headerBottomY, doc.y);
  }

  // Slogan unter Logo/Name
  if (firma.slogan) {
    const sloganY = (logoBuffer ? HEADER_TOP + LOGO_MAX_H : doc.y) + 4;
    doc.fontSize(7.5).fillColor('#888888').font('Helvetica')
       .text(firma.slogan, ML, sloganY, { width: LOGO_MAX_W });
    headerBottomY = Math.max(headerBottomY, doc.y);
  }

  // ── Rechts: Kontaktdaten ──────────────────────────────────────────────────
  const contactLines = [
    firma.name,
    firma.strasse,
    firma.plzOrt,
    firma.tel   ? `Tel: ${firma.tel}`     : null,
    firma.email,
    firma.web,
    firma.steuernr,
  ].filter(Boolean);

  doc.fontSize(8).fillColor('#444444').font('Helvetica');
  contactLines.forEach((line, i) => {
    const isFirst = i === 0;
    if (isFirst) doc.font('Helvetica-Bold');
    doc.text(line, CONTACT_X, HEADER_TOP + i * 11, { width: CONTACT_W, align: 'right' });
    if (isFirst) doc.font('Helvetica');
  });

  const contactBottomY = HEADER_TOP + contactLines.length * 11;
  headerBottomY = Math.max(headerBottomY, contactBottomY);

  // ── Trennlinie ────────────────────────────────────────────────────────────
  const lineY = headerBottomY + 10;
  doc.moveTo(ML, lineY)
     .lineTo(ML + PAGE_W, lineY)
     .lineWidth(2).strokeColor(accent).stroke();

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPFÄNGER + DOKUMENT-META
  // ═══════════════════════════════════════════════════════════════════════════

  const ADDR_TOP  = lineY + 14;
  const META_X    = ML + PAGE_W * 0.55;
  const META_W    = PAGE_W * 0.45;

  // Mini-Absenderzeile
  doc.fontSize(7).fillColor('#aaaaaa').font('Helvetica')
     .text(
       [firma.name, firma.strasse, firma.plzOrt].filter(Boolean).join('  ·  '),
       ML, ADDR_TOP, { width: PAGE_W * 0.50 }
     );

  // Empfänger-Adresse
  const addrY = ADDR_TOP + 14;
  doc.fontSize(10).fillColor('#111111').font('Helvetica-Bold')
     .text(invoice.company_name || invoice.contact_person || '–', ML, addrY);
  doc.fontSize(9).fillColor('#444444').font('Helvetica');
  if (invoice.company_name && invoice.contact_person) {
    doc.text(`z. Hd. ${invoice.contact_person}`);
  }
  if (invoice.street)            doc.text(invoice.street);
  if (invoice.zip || invoice.city) {
    doc.text([invoice.zip, invoice.city].filter(Boolean).join(' '));
  }
  const addrBottomY = doc.y;

  // Metadaten-Block (rechts neben Adresse)
  const metaRows = [
    [isOffer ? 'Angebots-Nr.:' : 'Rechnungs-Nr.:', docNr],
    ['Datum:',                                       fmtDate(invoice.created_at)],
  ];
  if (!isOffer && invoice.due_date) {
    metaRows.push(['Fällig am:', fmtDate(invoice.due_date)]);
  }
  if (isDunning) {
    metaRows.push(['Mahnstufe:', String(invoice.dunning_level)]);
  }

  doc.fontSize(8).font('Helvetica');
  metaRows.forEach(([label, value], i) => {
    const ry = ADDR_TOP + 14 + i * 15;
    doc.fillColor('#666666').text(label, META_X,          ry, { width: META_W * 0.50 });
    doc.fillColor('#111111').font('Helvetica-Bold')
       .text(value, META_X + META_W * 0.52, ry, { width: META_W * 0.48 });
    doc.font('Helvetica');
  });

  // ── Betreff ───────────────────────────────────────────────────────────────
  const titleY = Math.max(addrBottomY, ADDR_TOP + 14 + metaRows.length * 15) + 22;

  doc.fontSize(14).fillColor(accent).font('Helvetica-Bold')
     .text(`${docLabel} Nr. ${docNr}`, ML, titleY);

  const introText = isOffer
    ? (firma.pdf_intro_offer   || 'Sehr geehrte Damen und Herren,\nvielen Dank für Ihre Anfrage. Wir unterbreiten Ihnen folgendes Angebot:')
    : (firma.pdf_intro_invoice || 'Sehr geehrte Damen und Herren,\nwir erlauben uns, folgende Leistungen in Rechnung zu stellen:');

  doc.fontSize(9).fillColor('#555555').font('Helvetica')
     .text(introText, ML, doc.y + 6, { width: PAGE_W });

  // ═══════════════════════════════════════════════════════════════════════════
  // POSITIONSTABELLE
  // ═══════════════════════════════════════════════════════════════════════════

  const tableTop = doc.y + 16;

  // Spalten-Layout
  const C = {
    pos:   { x: ML,                                              w: 28  },
    desc:  { x: ML + 28,                                         w: PAGE_W - 28 - 68 - 80 - 78 },
    qty:   { x: ML + 28 + (PAGE_W - 28 - 68 - 80 - 78),         w: 68  },
    price: { x: ML + 28 + (PAGE_W - 28 - 68 - 80 - 78) + 68,    w: 80  },
    total: { x: ML + 28 + (PAGE_W - 28 - 68 - 80 - 78) + 68 + 80, w: 78 },
  };

  // Tabellenkopf
  const TH = 18;
  doc.rect(ML, tableTop, PAGE_W, TH).fill(accent);
  const thY = tableTop + 5;
  doc.fontSize(7.5).fillColor('#ffffff').font('Helvetica-Bold');
  doc.text('Pos.',        C.pos.x   + 2, thY, { width: C.pos.w   - 4 });
  doc.text('Bezeichnung', C.desc.x  + 2, thY, { width: C.desc.w  - 4 });
  doc.text('Menge',       C.qty.x   + 2, thY, { width: C.qty.w   - 4, align: 'right' });
  doc.text('Einzelpreis', C.price.x + 2, thY, { width: C.price.w - 4, align: 'right' });
  doc.text('Gesamt',      C.total.x + 2, thY, { width: C.total.w - 4, align: 'right' });

  // Zeilen
  const ROW_H  = 18;
  const ROW_PAD = 5;
  let rowY = tableTop + TH;

  doc.font('Helvetica').fontSize(8.5);

  (items || []).forEach((item, idx) => {
    const lineTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0);
    const bg        = idx % 2 === 0 ? accentLight : '#ffffff';

    // Mehrzeiligen Beschreibungstext abschätzen
    const descLines  = Math.ceil((doc.widthOfString(item.description || '') || 1) / (C.desc.w - 4));
    const rowHeight  = Math.max(ROW_H, descLines * 11 + ROW_PAD * 2);

    // Seitenumbruch prüfen
    if (rowY + rowHeight > doc.page.height - doc.page.margins.bottom - 120) {
      doc.addPage();
      rowY = doc.page.margins.top;
    }

    doc.rect(ML, rowY, PAGE_W, rowHeight).fill(bg);
    doc.fillColor('#222222');

    const cellY = rowY + ROW_PAD;
    doc.text(String(idx + 1),       C.pos.x   + 2, cellY, { width: C.pos.w   - 4 });
    doc.text(item.description || '', C.desc.x  + 2, cellY, { width: C.desc.w  - 4 });
    doc.text(
      `${Number(item.quantity || 0).toLocaleString('de-DE')} ${item.unit || ''}`.trim(),
      C.qty.x + 2, cellY, { width: C.qty.w - 4, align: 'right' }
    );
    doc.text(fmt(item.price),  C.price.x + 2, cellY, { width: C.price.w - 4, align: 'right' });
    doc.text(fmt(lineTotal),   C.total.x + 2, cellY, { width: C.total.w - 4, align: 'right' });

    rowY += rowHeight;
  });

  // Tabellenrahmen (untere Linie)
  doc.moveTo(ML, rowY).lineTo(ML + PAGE_W, rowY)
     .lineWidth(0.5).strokeColor('#cccccc').stroke();

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMENBLOCK
  // ═══════════════════════════════════════════════════════════════════════════

  const SUM_LABEL_X = C.price.x;
  const SUM_VALUE_X = C.total.x;
  const SUM_LABEL_W = C.price.w - 4;
  const SUM_VALUE_W = C.total.w - 4;

  rowY += 10;

  // Netto
  doc.fontSize(8.5).fillColor('#555555').font('Helvetica');
  doc.text('Zwischensumme (Netto):',   SUM_LABEL_X, rowY, { width: SUM_LABEL_W });
  doc.text(fmt(subtotal), SUM_VALUE_X, rowY, { width: SUM_VALUE_W, align: 'right' });
  rowY += 14;

  // MwSt.
  doc.text(`${taxRate} % MwSt.:`,      SUM_LABEL_X, rowY, { width: SUM_LABEL_W });
  doc.text(fmt(tax),      SUM_VALUE_X, rowY, { width: SUM_VALUE_W, align: 'right' });
  rowY += 10;

  // Trennlinie vor Gesamt
  doc.moveTo(SUM_LABEL_X, rowY)
     .lineTo(SUM_VALUE_X + SUM_VALUE_W, rowY)
     .lineWidth(1.5).strokeColor(accent).stroke();
  rowY += 6;

  // Gesamt-Betrag
  doc.fontSize(11).fillColor('#111111').font('Helvetica-Bold');
  doc.text('Gesamtbetrag (Brutto):', SUM_LABEL_X, rowY, { width: SUM_LABEL_W });
  doc.text(fmt(total), SUM_VALUE_X, rowY, { width: SUM_VALUE_W, align: 'right' });
  rowY = doc.y + 26;

  // ═══════════════════════════════════════════════════════════════════════════
  // ZAHLUNGSHINWEIS
  // ═══════════════════════════════════════════════════════════════════════════

  doc.moveTo(ML, rowY).lineTo(ML + PAGE_W, rowY)
     .lineWidth(0.5).strokeColor('#dddddd').stroke();
  rowY += 10;

  const paymentNote = isOffer
    ? `Dieses Angebot ist gültig für ${firma.angebotsgueltig || 30} Tage ab Ausstellungsdatum.`
    : `Zahlbar innerhalb von ${firma.zahlungsfrist || 14} Tagen ohne Abzug per ${firma.default_payment_method || 'Überweisung'}. Verwendungszweck: ${docNr}`;

  doc.fontSize(8.5).fillColor('#444444').font('Helvetica')
     .text(paymentNote, ML, rowY, { width: PAGE_W });
  rowY = doc.y + 12;

  // ═══════════════════════════════════════════════════════════════════════════
  // BANKDATEN-BOX
  // ═══════════════════════════════════════════════════════════════════════════

  const BOX_H     = 52;
  const bankColW  = PAGE_W / 3;

  // Hintergrund
  doc.rect(ML, rowY, PAGE_W, BOX_H).fill('#f7f8fa');

  // Spaltenköpfe
  doc.fontSize(7.5).fillColor(accent).font('Helvetica-Bold');
  doc.text('Bankverbindung', ML + 8,              rowY + 6, { width: bankColW - 12 });
  doc.text('Kontakt',        ML + bankColW + 8,   rowY + 6, { width: bankColW - 12 });
  doc.text('Steuer',         ML + bankColW * 2 + 8, rowY + 6, { width: bankColW - 12 });

  // Trennstriche zwischen Spalten
  doc.moveTo(ML + bankColW,     rowY + 4).lineTo(ML + bankColW,     rowY + BOX_H - 4)
     .lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  doc.moveTo(ML + bankColW * 2, rowY + 4).lineTo(ML + bankColW * 2, rowY + BOX_H - 4)
     .lineWidth(0.5).strokeColor('#e2e8f0').stroke();

  // Inhalt
  doc.font('Helvetica').fillColor('#555555').fontSize(7.5);

  const bankLines = [
    firma.bank,
    firma.iban ? `IBAN: ${firma.iban}` : null,
    firma.bic  ? `BIC: ${firma.bic}`   : null,
  ].filter(Boolean);

  const contLines = [
    firma.tel   ? `Tel: ${firma.tel}`   : null,
    firma.email,
    firma.web,
  ].filter(Boolean);

  const taxLines = [firma.steuernr].filter(Boolean);

  bankLines.forEach((l, i) => doc.text(l, ML + 8,              rowY + 20 + i * 10, { width: bankColW - 12 }));
  contLines.forEach((l, i) => doc.text(l, ML + bankColW + 8,   rowY + 20 + i * 10, { width: bankColW - 12 }));
  taxLines.forEach ((l, i) => doc.text(l, ML + bankColW*2 + 8, rowY + 20 + i * 10, { width: bankColW - 12 }));

  // ═══════════════════════════════════════════════════════════════════════════
  // OPTIONALE AGB / FUSSNOTENTEXT
  // ═══════════════════════════════════════════════════════════════════════════

  if (firma.pdf_agb_text) {
    rowY += BOX_H + 14;
    doc.fontSize(7.5).fillColor('#888888').font('Helvetica')
       .text(firma.pdf_agb_text, ML, rowY, { width: PAGE_W });
  }

  if (firma.pdf_footer_text) {
    doc.fontSize(7.5).fillColor('#aaaaaa').font('Helvetica')
       .text(firma.pdf_footer_text, ML, doc.y + 10, { width: PAGE_W, align: 'center' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEITENZAHLEN (auf allen Seiten)
  // ═══════════════════════════════════════════════════════════════════════════

  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).fillColor('#aaaaaa').font('Helvetica')
       .text(
         `Seite ${i + 1} von ${totalPages}  ·  ${docLabel} ${docNr}  ·  ${firma.name || ''}`,
         ML, doc.page.height - doc.page.margins.bottom + 10,
         { width: PAGE_W, align: 'center' }
       );
  }

  doc.end();
}

module.exports = { generateDocumentPDF };
