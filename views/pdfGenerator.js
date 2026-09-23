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

/** Hex etwas abdunkeln */
function darkenHex(hex, pct = 0.15) {
  const n = parseInt((hex || '#1e3a5f').replace('#', ''), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * (1 - pct)));
  const g = Math.max(0, Math.round(((n >>  8) & 0xff) * (1 - pct)));
  const b = Math.max(0, Math.round(( n        & 0xff) * (1 - pct)));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Haupt-Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erzeugt ein vollständiges Rechnungs- oder Angebots-PDF mit PDFKit.
 * Professionelles Layout angelehnt an moderne Rechnungsprogramme
 * (DIN 5008-nah, klare Typografie, klare Summenbox).
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

  const fmt = n =>
    Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const fmtQty = n =>
    Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  const fmtDate = d => {
    try { return new Date(d).toLocaleDateString('de-DE'); } catch (_) { return ''; }
  };

  // ── Design-Farben ─────────────────────────────────────────────────────────
  const accent      = firma.pdf_color || '#1e3a5f';
  const accentDark  = darkenHex(accent, 0.18);
  const accentLight = lightenHex(accent, 0.93);
  const grayBorder  = '#e5e7eb';
  const grayMuted   = '#6b7280';
  const grayText    = '#374151';
  const blackText   = '#111827';

  // ── Logo vorab laden ──────────────────────────────────────────────────────
  let logoBuffer = null;
  const logoUrl  = firma.logo_url || firma.sidebar_logo_url || null;
  if (logoUrl && (logoUrl.startsWith('http://') || logoUrl.startsWith('https://'))) {
    logoBuffer = await fetchImageBuffer(logoUrl);
  }

  // ── PDFDocument initialisieren ────────────────────────────────────────────
  // Schmalere Ränder für professionelleres Erscheinungsbild (DIN-nah)
  const doc = new PDFDocument({
    size:        'A4',
    margin:      48,
    bufferPages: true,
    info: {
      Title:   `${docLabel} ${docNr}`,
      Author:  firma.name || 'Metallbau',
      Subject: docLabel,
      Creator: 'Metallbau App',
    }
  });

  const safeName = docNr.replace(/[^a-zA-Z0-9_\-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${docLabel}-${safeName}.pdf"`);
  doc.pipe(res);

  const ML = doc.page.margins.left;    // 48
  const MR = doc.page.margins.right;
  const MT = doc.page.margins.top;
  const MB = doc.page.margins.bottom;
  const PAGE_W  = doc.page.width  - ML - MR;  // ~499
  const PAGE_H  = doc.page.height - MT - MB;

  // ═══════════════════════════════════════════════════════════════════════════
  // BRIEFKOPF – Logo links, Firmendaten rechts, dezente Akzentlinie
  // ═══════════════════════════════════════════════════════════════════════════

  const HEADER_TOP  = MT;
  const LOGO_MAX_W  = PAGE_W * 0.40;
  const LOGO_MAX_H  = 58;
  const CONTACT_X   = ML + PAGE_W * 0.52;
  const CONTACT_W   = PAGE_W * 0.48;

  let headerBottomY = HEADER_TOP;

  // Links: Logo oder Firmenname
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, ML, HEADER_TOP, {
        fit:    [LOGO_MAX_W, LOGO_MAX_H],
        align:  'left',
        valign: 'top',
      });
      headerBottomY = Math.max(headerBottomY, HEADER_TOP + LOGO_MAX_H);
    } catch (_) {
      logoBuffer = null;
    }
  }

  if (!logoBuffer) {
    doc.fontSize(18).fillColor(accent).font('Helvetica-Bold')
       .text((firma.name || 'Ihre Firma').toUpperCase(), ML, HEADER_TOP, { width: LOGO_MAX_W });
    headerBottomY = Math.max(headerBottomY, doc.y);
  }

  // Slogan unter Logo/Name
  if (firma.slogan) {
    const sloganY = (logoBuffer ? HEADER_TOP + LOGO_MAX_H : doc.y) + 3;
    doc.fontSize(7).fillColor('#9ca3af').font('Helvetica')
       .text(firma.slogan, ML, sloganY, { width: LOGO_MAX_W });
    headerBottomY = Math.max(headerBottomY, doc.y);
  }

  // Rechts: Kontaktdaten (kompakt, rechtsbündig)
  const contactLines = [
    { text: firma.name, bold: true },
    { text: firma.strasse },
    { text: firma.plzOrt },
    { text: firma.tel   ? `Tel  ${firma.tel}`   : null },
    { text: firma.email },
    { text: firma.web },
  ].filter(l => l.text);

  doc.fontSize(7.5).fillColor(grayText).font('Helvetica');
  contactLines.forEach((line, i) => {
    if (line.bold) doc.font('Helvetica-Bold').fillColor(blackText);
    else doc.font('Helvetica').fillColor(grayText);
    doc.text(line.text, CONTACT_X, HEADER_TOP + i * 10.5, { width: CONTACT_W, align: 'right' });
  });

  const contactBottomY = HEADER_TOP + contactLines.length * 10.5;
  headerBottomY = Math.max(headerBottomY, contactBottomY);

  // Akzentlinie unter dem Briefkopf
  const lineY = headerBottomY + 12;
  doc.moveTo(ML, lineY)
     .lineTo(ML + PAGE_W, lineY)
     .lineWidth(1.5).strokeColor(accent).stroke();
  // Dünne zweite Linie für Premium-Look
  doc.moveTo(ML, lineY + 2.5)
     .lineTo(ML + PAGE_W, lineY + 2.5)
     .lineWidth(0.4).strokeColor(accentLight).stroke();

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPFÄNGER (DIN-Fenster-nah) + DOKUMENT-META rechts
  // ═══════════════════════════════════════════════════════════════════════════

  const ADDR_TOP  = lineY + 16;
  const META_X    = ML + PAGE_W * 0.55;
  const META_W    = PAGE_W * 0.45;

  // Mini-Absenderzeile (wie im Fensterumschlag)
  doc.fontSize(6.5).fillColor('#9ca3af').font('Helvetica')
     .text(
       [firma.name, firma.strasse, firma.plzOrt].filter(Boolean).join('  ·  '),
       ML, ADDR_TOP, { width: PAGE_W * 0.48 }
     );

  // Empfänger-Adresse
  const addrY = ADDR_TOP + 12;
  doc.fontSize(10).fillColor(blackText).font('Helvetica-Bold')
     .text(invoice.company_name || invoice.contact_person || '–', ML, addrY, { width: PAGE_W * 0.48 });
  doc.fontSize(9).fillColor(grayText).font('Helvetica');
  if (invoice.company_name && invoice.contact_person) {
    doc.text(`z. Hd. ${invoice.contact_person}`, ML, doc.y + 1, { width: PAGE_W * 0.48 });
  }
  if (invoice.street) {
    doc.text(invoice.street, ML, doc.y + 1, { width: PAGE_W * 0.48 });
  }
  if (invoice.zip || invoice.city) {
    doc.text([invoice.zip, invoice.city].filter(Boolean).join(' '), ML, doc.y + 1, { width: PAGE_W * 0.48 });
  }
  const addrBottomY = doc.y;

  // Meta-Box rechts (Karten-Look)
  const metaRows = [];
  metaRows.push([isOffer ? 'Angebots-Nr.' : 'Rechnungs-Nr.', docNr]);
  metaRows.push(['Datum', fmtDate(invoice.created_at)]);
  if (!isOffer && invoice.due_date) {
    metaRows.push(['Fällig am', fmtDate(invoice.due_date)]);
  }
  if (isOffer && firma.angebotsgueltig) {
    try {
      const gueltig = new Date(invoice.created_at);
      gueltig.setDate(gueltig.getDate() + parseInt(firma.angebotsgueltig || 30));
      metaRows.push(['Gültig bis', fmtDate(gueltig)]);
    } catch (_) {}
  }
  if (isDunning) {
    const stufe = invoice.dunning_level === 1 ? '1. Erinnerung'
                : invoice.dunning_level === 2 ? '2. Mahnung'
                : '3. Letzte Mahnung';
    metaRows.push(['Mahnstufe', stufe]);
  }
  if (invoice.customer_number || invoice.customer_no) {
    metaRows.push(['Kunden-Nr.', invoice.customer_number || invoice.customer_no]);
  }
  if (invoice.project_number || invoice.project_ref) {
    metaRows.push(['Projekt', invoice.project_number || invoice.project_ref]);
  }

  const metaBoxH = 12 + metaRows.length * 14 + 8;
  const metaBoxY = ADDR_TOP + 4;

  // Hintergrund der Meta-Box
  doc.roundedRect(META_X, metaBoxY, META_W, metaBoxH, 4)
     .fill(accentLight);
  // Linker Akzentstreifen
  doc.rect(META_X, metaBoxY, 3, metaBoxH).fill(accent);

  doc.fontSize(8).font('Helvetica');
  metaRows.forEach(([label, value], i) => {
    const ry = metaBoxY + 10 + i * 14;
    doc.fillColor(grayMuted).text(label, META_X + 12, ry, { width: META_W * 0.42 });
    doc.fillColor(blackText).font('Helvetica-Bold')
       .text(String(value || ''), META_X + META_W * 0.42 + 8, ry, { width: META_W * 0.52 - 10, align: 'right' });
    doc.font('Helvetica');
  });

  // ── Betreff / Einleitung ──────────────────────────────────────────────────
  const titleY = Math.max(addrBottomY, metaBoxY + metaBoxH) + 20;

  // Dokument-Titel
  if (isDunning) {
    doc.fontSize(13).fillColor('#b91c1c').font('Helvetica-Bold')
       .text(`Mahnung zu Rechnung ${docNr}`, ML, titleY);
  } else {
    doc.fontSize(13).fillColor(accent).font('Helvetica-Bold')
       .text(`${docLabel} Nr. ${docNr}`, ML, titleY);
  }

  const introText = isDunning
    ? 'Sehr geehrte Damen und Herren,\ntrotz unserer Rechnung haben wir bisher keinen Zahlungseingang feststellen können.\nWir bitten Sie, den ausstehenden Betrag umgehend zu begleichen.'
    : isOffer
      ? (firma.pdf_intro_offer || 'Sehr geehrte Damen und Herren,\nvielen Dank für Ihre Anfrage. Wir unterbreiten Ihnen folgendes Angebot:')
      : (firma.pdf_intro_invoice || 'Sehr geehrte Damen und Herren,\nwir erlauben uns, folgende Leistungen in Rechnung zu stellen:');

  doc.fontSize(9).fillColor(grayText).font('Helvetica')
     .text(introText, ML, doc.y + 8, { width: PAGE_W, lineGap: 2 });

  // ═══════════════════════════════════════════════════════════════════════════
  // POSITIONSTABELLE
  // ═══════════════════════════════════════════════════════════════════════════

  const tableTop = doc.y + 14;

  // Spalten: Pos | Bezeichnung | Menge | Einheit | Einzelpreis | Gesamt
  const C = {
    pos:   { x: ML,              w: 26  },
    desc:  { x: ML + 26,         w: PAGE_W - 26 - 52 - 36 - 72 - 72 },
    qty:   { x: 0, w: 52  },
    unit:  { x: 0, w: 36  },
    price: { x: 0, w: 72  },
    total: { x: 0, w: 72  },
  };
  C.qty.x   = C.desc.x + C.desc.w;
  C.unit.x  = C.qty.x  + C.qty.w;
  C.price.x = C.unit.x + C.unit.w;
  C.total.x = C.price.x + C.price.w;

  // Tabellenkopf
  const TH = 20;
  doc.rect(ML, tableTop, PAGE_W, TH).fill(accent);
  const thY = tableTop + 6;
  doc.fontSize(7).fillColor('#ffffff').font('Helvetica-Bold');
  doc.text('Pos.',          C.pos.x   + 2, thY, { width: C.pos.w   - 4 });
  doc.text('Bezeichnung',   C.desc.x  + 2, thY, { width: C.desc.w  - 4 });
  doc.text('Menge',         C.qty.x   + 2, thY, { width: C.qty.w   - 4, align: 'right' });
  doc.text('Einh.',         C.unit.x  + 2, thY, { width: C.unit.w  - 4, align: 'left' });
  doc.text('Einzelpreis',   C.price.x + 2, thY, { width: C.price.w - 4, align: 'right' });
  doc.text('Gesamt',        C.total.x + 2, thY, { width: C.total.w - 4, align: 'right' });

  // Zeilen
  const ROW_PAD = 5;
  let rowY = tableTop + TH;

  (items || []).forEach((item, idx) => {
    const lineTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0);
    const bg        = idx % 2 === 0 ? '#f9fafb' : '#ffffff';

    // Beschreibungshöhe berechnen
    doc.font('Helvetica').fontSize(8.5);
    const descText  = item.description || '';
    const descH     = doc.heightOfString(descText, { width: C.desc.w - 6 });
    const rowHeight = Math.max(20, descH + ROW_PAD * 2);

    // Seitenumbruch – Platz für Summen + Bankbox freilassen
    if (rowY + rowHeight > doc.page.height - MB - 160) {
      // Unterkante der Tabelle auf aktueller Seite
      doc.moveTo(ML, rowY).lineTo(ML + PAGE_W, rowY)
         .lineWidth(0.4).strokeColor(grayBorder).stroke();
      doc.addPage();
      rowY = MT;

      // Tabellenkopf auf neuer Seite wiederholen
      doc.rect(ML, rowY, PAGE_W, TH).fill(accent);
      const nthY = rowY + 6;
      doc.fontSize(7).fillColor('#ffffff').font('Helvetica-Bold');
      doc.text('Pos.',          C.pos.x   + 2, nthY, { width: C.pos.w   - 4 });
      doc.text('Bezeichnung',   C.desc.x  + 2, nthY, { width: C.desc.w  - 4 });
      doc.text('Menge',         C.qty.x   + 2, nthY, { width: C.qty.w   - 4, align: 'right' });
      doc.text('Einh.',         C.unit.x  + 2, nthY, { width: C.unit.w  - 4, align: 'left' });
      doc.text('Einzelpreis',   C.price.x + 2, nthY, { width: C.price.w - 4, align: 'right' });
      doc.text('Gesamt',        C.total.x + 2, nthY, { width: C.total.w - 4, align: 'right' });
      rowY += TH;
    }

    doc.rect(ML, rowY, PAGE_W, rowHeight).fill(bg);
    // Dezente Trennlinie
    doc.moveTo(ML, rowY + rowHeight).lineTo(ML + PAGE_W, rowY + rowHeight)
       .lineWidth(0.3).strokeColor(grayBorder).stroke();

    const cellY = rowY + ROW_PAD;
    doc.fillColor(grayMuted).font('Helvetica').fontSize(8)
       .text(String(idx + 1), C.pos.x + 2, cellY, { width: C.pos.w - 4 });
    doc.fillColor(blackText).fontSize(8.5)
       .text(descText, C.desc.x + 2, cellY, { width: C.desc.w - 6 });
    doc.fillColor(grayText)
       .text(fmtQty(item.quantity), C.qty.x + 2, cellY, { width: C.qty.w - 4, align: 'right' });
    doc.fillColor(grayMuted).fontSize(7.5)
       .text(item.unit || '', C.unit.x + 2, cellY, { width: C.unit.w - 4 });
    doc.fillColor(grayText).fontSize(8.5)
       .text(fmt(item.price), C.price.x + 2, cellY, { width: C.price.w - 4, align: 'right' });
    doc.fillColor(blackText).font('Helvetica-Bold')
       .text(fmt(lineTotal), C.total.x + 2, cellY, { width: C.total.w - 4, align: 'right' });
    doc.font('Helvetica');

    rowY += rowHeight;
  });

  // Untere Linie der Tabelle
  doc.moveTo(ML, rowY).lineTo(ML + PAGE_W, rowY)
     .lineWidth(0.8).strokeColor(accent).stroke();

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMENBLOCK (rechts, klar hervorgehoben)
  // ═══════════════════════════════════════════════════════════════════════════

  const SUM_W       = 200;
  const SUM_X       = ML + PAGE_W - SUM_W;
  let sumY          = rowY + 14;

  // Seitenumbruch prüfen
  if (sumY + 90 > doc.page.height - MB - 80) {
    doc.addPage();
    sumY = MT + 10;
  }

  doc.fontSize(8.5).fillColor(grayMuted).font('Helvetica');
  doc.text('Zwischensumme (Netto)', SUM_X, sumY, { width: SUM_W * 0.55 });
  doc.fillColor(grayText)
     .text(fmt(subtotal), SUM_X + SUM_W * 0.55, sumY, { width: SUM_W * 0.45, align: 'right' });
  sumY += 15;

  doc.fillColor(grayMuted)
     .text(`${taxRate} % MwSt.`, SUM_X, sumY, { width: SUM_W * 0.55 });
  doc.fillColor(grayText)
     .text(fmt(tax), SUM_X + SUM_W * 0.55, sumY, { width: SUM_W * 0.45, align: 'right' });
  sumY += 12;

  // Trennlinie
  doc.moveTo(SUM_X, sumY).lineTo(SUM_X + SUM_W, sumY)
     .lineWidth(1).strokeColor(accent).stroke();
  sumY += 8;

  // Gesamtbetrag – hervorgehobene Box
  const totalBoxH = 28;
  doc.roundedRect(SUM_X - 4, sumY - 4, SUM_W + 8, totalBoxH, 3).fill(accent);
  doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold');
  doc.text('Gesamtbetrag (Brutto)', SUM_X, sumY + 4, { width: SUM_W * 0.55 });
  doc.fontSize(11)
     .text(fmt(total), SUM_X + SUM_W * 0.50, sumY + 3, { width: SUM_W * 0.50, align: 'right' });
  sumY += totalBoxH + 16;

  // ═══════════════════════════════════════════════════════════════════════════
  // ZAHLUNGSHINWEIS
  // ═══════════════════════════════════════════════════════════════════════════

  doc.moveTo(ML, sumY).lineTo(ML + PAGE_W, sumY)
     .lineWidth(0.4).strokeColor(grayBorder).stroke();
  sumY += 12;

  let paymentNote;
  if (isDunning) {
    paymentNote = `Bitte überweisen Sie den ausstehenden Betrag von ${fmt(total)} umgehend auf das unten stehende Konto, um weitere Mahnkosten zu vermeiden. Verwendungszweck: ${docNr}`;
  } else if (isOffer) {
    paymentNote = `Dieses Angebot ist gültig für ${firma.angebotsgueltig || 30} Tage ab Ausstellungsdatum. Bei Auftragserteilung bitten wir um schriftliche Bestätigung.`;
  } else {
    paymentNote = `Zahlbar innerhalb von ${firma.zahlungsfrist || 14} Tagen ohne Abzug per ${firma.default_payment_method || 'Überweisung'}. Bitte geben Sie als Verwendungszweck die Rechnungsnummer ${docNr} an.`;
  }

  doc.fontSize(8.5).fillColor(grayText).font('Helvetica')
     .text(paymentNote, ML, sumY, { width: PAGE_W, lineGap: 1.5 });
  sumY = doc.y + 14;

  // ═══════════════════════════════════════════════════════════════════════════
  // BANKDATEN-BOX (3 Spalten)
  // ═══════════════════════════════════════════════════════════════════════════

  const BOX_H    = 58;
  const bankColW = PAGE_W / 3;

  if (sumY + BOX_H > doc.page.height - MB - 30) {
    doc.addPage();
    sumY = MT + 10;
  }

  doc.roundedRect(ML, sumY, PAGE_W, BOX_H, 4).fill('#f8fafc');
  doc.roundedRect(ML, sumY, PAGE_W, BOX_H, 4)
     .lineWidth(0.5).strokeColor(grayBorder).stroke();

  // Spaltenköpfe
  doc.fontSize(7).fillColor(accent).font('Helvetica-Bold');
  doc.text('Bankverbindung', ML + 10,              sumY + 8, { width: bankColW - 16 });
  doc.text('Kontakt',        ML + bankColW + 10,   sumY + 8, { width: bankColW - 16 });
  doc.text('Steuer / Firma', ML + bankColW * 2 + 10, sumY + 8, { width: bankColW - 16 });

  // Trennlinien
  doc.moveTo(ML + bankColW,     sumY + 6).lineTo(ML + bankColW,     sumY + BOX_H - 6)
     .lineWidth(0.4).strokeColor(grayBorder).stroke();
  doc.moveTo(ML + bankColW * 2, sumY + 6).lineTo(ML + bankColW * 2, sumY + BOX_H - 6)
     .lineWidth(0.4).strokeColor(grayBorder).stroke();

  doc.font('Helvetica').fillColor(grayText).fontSize(7.5);

  const bankLines = [
    firma.bank,
    firma.iban ? `IBAN  ${firma.iban}` : null,
    firma.bic  ? `BIC   ${firma.bic}`  : null,
  ].filter(Boolean);

  const contLines = [
    firma.tel   ? `Tel  ${firma.tel}` : null,
    firma.email,
    firma.web,
  ].filter(Boolean);

  const taxLines = [
    firma.steuernr,
    firma.name,
  ].filter(Boolean);

  bankLines.forEach((l, i) => doc.text(l, ML + 10,              sumY + 22 + i * 10, { width: bankColW - 16 }));
  contLines.forEach((l, i) => doc.text(l, ML + bankColW + 10,   sumY + 22 + i * 10, { width: bankColW - 16 }));
  taxLines.forEach ((l, i) => doc.text(l, ML + bankColW * 2 + 10, sumY + 22 + i * 10, { width: bankColW - 16 }));

  // ═══════════════════════════════════════════════════════════════════════════
  // OPTIONALE AGB / FUSSNOTENTEXT
  // ═══════════════════════════════════════════════════════════════════════════

  let footerY = sumY + BOX_H + 12;

  if (firma.pdf_agb_text) {
    if (footerY + 40 > doc.page.height - MB) {
      doc.addPage();
      footerY = MT + 10;
    }
    doc.fontSize(7).fillColor('#9ca3af').font('Helvetica')
       .text(firma.pdf_agb_text, ML, footerY, { width: PAGE_W });
    footerY = doc.y + 8;
  }

  if (firma.pdf_footer_text) {
    doc.fontSize(7).fillColor('#9ca3af').font('Helvetica')
       .text(firma.pdf_footer_text, ML, footerY, { width: PAGE_W, align: 'center' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEITENZAHLEN (auf allen Seiten)
  // ═══════════════════════════════════════════════════════════════════════════

  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    // Feine Linie über der Fußzeile
    const footY = doc.page.height - MB + 6;
    doc.moveTo(ML, footY).lineTo(ML + PAGE_W, footY)
       .lineWidth(0.3).strokeColor(grayBorder).stroke();
    doc.fontSize(7).fillColor('#9ca3af').font('Helvetica')
       .text(
         `Seite ${i + 1} von ${totalPages}  ·  ${docLabel} ${docNr}  ·  ${firma.name || ''}`,
         ML, footY + 4,
         { width: PAGE_W, align: 'center' }
       );
  }

  doc.end();
}

module.exports = { generateDocumentPDF };
