const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const PDFDocument = require('pdfkit');
const { requirePerm } = require('../middleware/auth');

// Zugriff über Berechtigungs-Matrix (ADMIN: Standard an, EMPLOYEE: Standard aus)
const requireSchnittliste = requirePerm('schnittliste', true, false, 'die Schnittliste');

// Datei nur im Arbeitsspeicher halten – kein Disk-Speicher nötig
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|txt|xlsx)$/i.test(file.originalname);
    cb(ok ? null : new Error('Nur CSV- oder XLSX-Dateien erlaubt'), ok);
  }
});

// Bild-Upload (JPEG/PNG/WebP)
const bildUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Nur Bilddateien erlaubt (JPG, PNG, WebP)'), ok);
  }
});

// ══════════════════════════════════════════════════════════════
//  PARSER-HILFEN
// ══════════════════════════════════════════════════════════════

/**
 * CSV-Zeilen clever splitten: berücksichtigt Anführungszeichen.
 */
function splitCsvLine(line, sep = ';') {
  const cols = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === sep && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cols.push(cur.trim());
  return cols;
}

/**
 * Erkennt automatisch ob Semikolon oder Komma als Trennzeichen verwendet wird.
 */
function detectSep(firstLine) {
  const semi  = (firstLine.match(/;/g)  || []).length;
  const comma = (firstLine.match(/,/g)  || []).length;
  return semi >= comma ? ';' : ',';
}

/**
 * Parst eine CSV-Datei (Buffer) und gibt Zeilen als Array von Objekten zurück.
 * Erwartet Spalten: Pos, Menge, Profil, Länge (mm), Bemerkung  (Reihenfolge egal,
 * Spaltennamen werden normalisiert).
 */
function parseCsv(buffer) {
  const text  = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) throw new Error('Die Datei enthält zu wenig Zeilen (mindestens Kopfzeile + 1 Datenzeile).');

  const sep    = detectSep(lines[0]);
  const header = splitCsvLine(lines[0], sep).map(h => h.toLowerCase().replace(/[^a-z0-9äöü]/g, ''));

  // Spalten-Mapping: flexibel, erkennt deutschsprachige und englische Bezeichnungen
  function idx(candidates) {
    for (const c of candidates) {
      const i = header.findIndex(h => h.includes(c));
      if (i !== -1) return i;
    }
    return -1;
  }

  const iPos    = idx(['pos', 'nr', 'lfd']);
  const iMenge  = idx(['menge', 'anz', 'qty', 'stk', 'stueck']);
  const iProfil = idx(['profil', 'profil', 'material', 'typ', 'bezeichnung', 'name']);
  const iLaenge = idx(['laenge', 'länge', 'length', 'mm', 'l(mm)', 'lmm']);
  const iBemerk = idx(['bemerk', 'hinweis', 'note', 'komment', 'info']);
  const iWinkel = idx(['winkel', 'gehrung', 'angle', 'schnitt']);

  if (iMenge === -1 || iProfil === -1 || iLaenge === -1) {
    throw new Error(
      'Pflichtfelder nicht gefunden. Die Datei braucht Spalten für: ' +
      'Menge (oder "Anz"), Profil (oder "Material"), Länge (oder "L(mm)").\n' +
      `Erkannte Spalten: ${header.join(', ')}`
    );
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], sep);
    if (cols.every(c => c === '')) continue;

    const laenge = parseFloat((cols[iLaenge] || '').replace(',', '.')) || 0;
    const menge  = parseInt(cols[iMenge] || '1', 10) || 1;
    if (laenge <= 0) continue; // leere/ungültige Zeile überspringen

    rows.push({
      pos:     iPos !== -1 ? (cols[iPos] || String(i)) : String(i),
      menge,
      profil:  (cols[iProfil] || '–').trim(),
      laenge,
      bemerk:  iBemerk !== -1 ? (cols[iBemerk] || '') : '',
      winkel:  iWinkel !== -1 ? (cols[iWinkel] || '').trim() : '',
    });
  }
  return rows;
}

/**
 * Minimaler XLSX-Parser (nur .xlsx, kein .xls).
 * Liest shared strings + Sheet1-Zellen per Regex – kein externes Paket nötig.
 */
function parseXlsx(buffer) {
  // XLSX ist ein ZIP. Wir extrahieren per Regex die Rohdaten aus dem Buffer.
  // Da wir kein unzip-Paket haben, konvertieren wir zu CSV-ähnlichem Text:
  // Fallback: Buffer als UTF-8 dekodieren und Zellen herausregexen.
  const raw = buffer.toString('binary');

  // Shared Strings extrahieren
  const ssMatch = raw.match(/<sst[^>]*>([\s\S]*?)<\/sst>/);
  const sharedStrings = [];
  if (ssMatch) {
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(ssMatch[1])) !== null) {
      const text = (m[1].match(/<t[^>]*>([^<]*)<\/t>/g) || [])
        .map(t => t.replace(/<[^>]+>/g, ''))
        .join('');
      sharedStrings.push(decodeXmlEntities(text));
    }
  }

  // Sheet1 extrahieren
  const sheetMatch = raw.match(/<worksheet[\s\S]*?<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sheetMatch) throw new Error('Konnte Sheet-Daten im XLSX nicht lesen.');

  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
  const valRe  = /<v>([^<]*)<\/v>/;

  const grid = [];
  let rowM;
  while ((rowM = rowRe.exec(sheetMatch[1])) !== null) {
    const rowCells = {};
    let cellM;
    const rowContent = rowM[1];
    cellRe.lastIndex = 0;
    while ((cellM = cellRe.exec(rowContent)) !== null) {
      const ref   = cellM[1];
      const attrs = cellM[2];
      const inner = cellM[3];
      const colLetter = ref.match(/([A-Z]+)/)[1];
      const colIdx    = colLetterToIndex(colLetter);
      const vM = valRe.exec(inner);
      const rawVal = vM ? vM[1] : '';
      // t="s" → shared string; t="str" → inline string
      const isStr = /t="s"/.test(attrs);
      const isInlineStr = /t="str"/.test(attrs);
      let val = rawVal;
      if (isStr) val = sharedStrings[parseInt(rawVal, 10)] || '';
      else if (isInlineStr) val = decodeXmlEntities(rawVal);
      rowCells[colIdx] = val;
    }
    if (Object.keys(rowCells).length) grid.push(rowCells);
  }

  if (grid.length < 2) throw new Error('Das XLSX enthält zu wenig Zeilen.');

  // Ersten Row als Header
  const headerRow = grid[0];
  const maxCol = Math.max(...Object.keys(headerRow).map(Number));
  const header = [];
  for (let c = 0; c <= maxCol; c++) {
    header.push((headerRow[c] || '').toLowerCase().replace(/[^a-z0-9äöü]/g, ''));
  }

  function idx(candidates) {
    for (const c of candidates) {
      const i = header.findIndex(h => h.includes(c));
      if (i !== -1) return i;
    }
    return -1;
  }

  const iPos    = idx(['pos', 'nr', 'lfd']);
  const iMenge  = idx(['menge', 'anz', 'qty', 'stk']);
  const iProfil = idx(['profil', 'material', 'typ', 'bezeichnung', 'name']);
  const iLaenge = idx(['laenge', 'länge', 'length', 'mm', 'l(mm)']);
  const iBemerk = idx(['bemerk', 'hinweis', 'note', 'komment', 'info']);
  const iWinkel = idx(['winkel', 'gehrung', 'angle', 'schnitt']);

  if (iMenge === -1 || iProfil === -1 || iLaenge === -1) {
    throw new Error(
      'Pflichtfelder nicht gefunden. Erkannte Spalten: ' + header.join(', ')
    );
  }

  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const laenge = parseFloat((r[iLaenge] || '').toString().replace(',', '.')) || 0;
    const menge  = parseInt((r[iMenge] || '1').toString(), 10) || 1;
    if (laenge <= 0) continue;
    rows.push({
      pos:    iPos !== -1 ? (r[iPos] || String(i)) : String(i),
      menge,
      profil: (r[iProfil] || '–').toString().trim(),
      laenge,
      bemerk: iBemerk !== -1 ? (r[iBemerk] || '') : '',
      winkel: iWinkel !== -1 ? String(r[iWinkel] || '').trim() : '',
    });
  }
  return rows;
}

function colLetterToIndex(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + col.charCodeAt(i) - 64;
  return n - 1;
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}

// ══════════════════════════════════════════════════════════════
//  OPTIMIERUNGS-ALGORITHMUS  (First-Fit-Decreasing)
// ══════════════════════════════════════════════════════════════

/**
 * Gruppiert Positionen nach Profil und berechnet für jedes Profil die
 * optimale Aufteilung auf Stangenlängen (First-Fit Decreasing).
 * Gibt pro Gruppe die Stangen + Verschnitt zurück.
 */
function parseSaege(body) {
  const v = parseFloat(String((body && body.saege) ?? '3').replace(',', '.'));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 20) : 3;
}

function optimiere(positionen, stangenlaenge, saege = 0) {
  // Alle Einzelstücke auffalten (Menge × Länge)
  const stuecke = [];
  for (const p of positionen) {
    for (let i = 0; i < p.menge; i++) {
      stuecke.push({ pos: p.pos, profil: p.profil, laenge: p.laenge, bemerk: p.bemerk, winkel: p.winkel || '' });
    }
  }

  // Gruppieren nach Profil
  const gruppen = {};
  for (const s of stuecke) {
    if (!gruppen[s.profil]) gruppen[s.profil] = [];
    gruppen[s.profil].push(s);
  }

  const ergebnis = [];
  for (const [profil, teile] of Object.entries(gruppen)) {
    // Absteigende Sortierung (größte zuerst → bessere Packung)
    const sorted = [...teile].sort((a, b) => b.laenge - a.laenge);
    const stangen = []; // Array von { rest, teile[] }

    for (const teil of sorted) {
      if (teil.laenge > stangenlaenge) {
        // Stück länger als Stange → eigene "Übermaß-Stange"
        stangen.push({ rest: 0, teile: [teil], uebermas: true });
        continue;
      }
      // Erste Stange finden, die noch Platz hat
      let gefunden = false;
      for (const stange of stangen) {
        // Jeder weitere Schnitt auf derselben Stange kostet zusätzlich die Sägeblattbreite
        const bedarf = teil.laenge + (stange.teile.length > 0 ? saege : 0);
        if (!stange.uebermas && stange.rest >= bedarf) {
          stange.rest  -= bedarf;
          stange.teile.push(teil);
          gefunden = true;
          break;
        }
      }
      if (!gefunden) {
        stangen.push({ rest: stangenlaenge - teil.laenge, teile: [teil], uebermas: false });
      }
    }

    const gesamtLaenge   = teile.reduce((s, t) => s + t.laenge, 0);
    const stangenzahl    = stangen.filter(s => !s.uebermas).length;
    const verschnittGes  = stangen.filter(s => !s.uebermas).reduce((s, st) => s + st.rest, 0);
    const ausnutzung     = stangenzahl > 0
      ? Math.round((gesamtLaenge / (stangenzahl * stangenlaenge)) * 100)
      : 100;

    ergebnis.push({ profil, stangen, gesamtLaenge, stangenzahl, verschnittGes, ausnutzung });
  }
  return ergebnis;
}

// ══════════════════════════════════════════════════════════════
//  PDF-GENERATOR
// ══════════════════════════════════════════════════════════════

/**
 * Winkeltext ("35° / 17,5°", "45°", "35° / 90° parallel") → Schnittgeometrie.
 * dev = Abweichung vom geraden 90°-Schnitt (Gehrungswinkel); Werte >= 90 oder fehlend = gerade.
 * parallel = beide Enden parallel geschnitten (Parallelogramm), sonst Trapez (Gehrung).
 */
function schnittInfo(winkel) {
  const txt = String(winkel || '');
  const zahlen = (txt.match(/\d+(?:[.,]\d+)?/g) || []).map(z => parseFloat(z.replace(',', '.')));
  if (zahlen.length === 0) return null;
  const dev = a => (a > 0 && a < 90 ? a : 0);
  const d1 = dev(zahlen[0]);
  const d2 = zahlen.length > 1 ? dev(zahlen[1]) : d1;
  if (d1 === 0 && d2 === 0) return { d1: 0, d2: 0, parallel: false };
  return { d1, d2, parallel: /parallel|par\b/i.test(txt) };
}

/** Zeichnet das Teil als Skizze mit den Schnittrichtungen der beiden Enden. */
function zeichneSchnitt(doc, x, y, w, h, info) {
  if (!info) {
    doc.font('Helvetica').fontSize(9).fillColor('#9ca3af').text('–', x, y + 2, { width: w, lineBreak: false });
    return;
  }
  const off = d => Math.min(w * 0.28, h * Math.tan(d * Math.PI / 180));
  const o1 = off(info.d1), o2 = off(info.d2);
  // Trapez (Gehrung): beide Schrägen laufen nach innen; Parallelogramm: gleiche Neigung an beiden Enden
  const pts = info.parallel
    ? [[x + o1, y], [x + w, y], [x + w - o2, y + h], [x, y + h]]
    : [[x + o1, y], [x + w - o2, y], [x + w, y + h], [x, y + h]];
  doc.save();
  doc.polygon(...pts).lineWidth(0.9).fillAndStroke('#e5e7eb', '#374151');
  doc.restore();
}

function erzeugePdf(res, dateiname, positionen, gruppen, stangenlaenge, firmaName, saege = 0) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${dateiname}"`);

  const M = 45;
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
  doc.pipe(res);

  const W      = doc.page.width - 2 * M;
  const BOTTOM = doc.page.height - 60;
  const GRAU   = '#6b7280';
  const BLAU   = '#1e40af';
  const HELLBL = '#eff6ff';
  const SCHW   = '#111827';
  const LINIE  = '#d1d5db';
  const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
  const fmt    = n => Number(n).toLocaleString('de-DE');

  let y = M;
  // Platz für "h" Punkte sicherstellen, sonst neue Seite
  const platz = h => { if (y + h > BOTTOM) { doc.addPage(); y = M; return true; } return false; };

  // ── Kopf ──────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(20).fillColor(BLAU).text('Schnittliste', M, y, { width: W, lineBreak: false });
  y += 26;
  doc.font('Helvetica').fontSize(9).fillColor(GRAU)
    .text(`${firmaName || 'Metallbau'}  ·  Stangenlänge: ${fmt(stangenlaenge)} mm  ·  Sägeblatt: ${saege} mm  ·  Erstellt: ${new Date().toLocaleDateString('de-DE')}`,
      M, y, { width: W, lineBreak: false });
  y += 16;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.2).strokeColor(BLAU).stroke();
  y += 16;

  // ── Positionstabelle ─────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(11).fillColor(SCHW).text('Positionen', M, y, { lineBreak: false });
  y += 20;

  const cols = [
    { x: M,          w: 26,          t: 'Pos',       a: 'left'  },
    { x: M + 28,     w: 32,          t: 'Menge',     a: 'right' },
    { x: M + 62,     w: 110,         t: 'Profil',    a: 'left'  },
    { x: M + 174,    w: 48,          t: 'Länge',     a: 'right' },
    { x: M + 224,    w: 36,          t: '≈ kg',      a: 'right' },
    { x: M + 262,    w: 56,          t: 'Winkel',    a: 'left'  },
    { x: M + 320,    w: 52,          t: 'Schnitt',   a: 'left'  },
    { x: M + 374,    w: W - 374,     t: 'Bemerkung', a: 'left'  },
  ];
  const kopfZeile = () => {
    doc.rect(M, y, W, 18).fill('#f3f4f6');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAU);
    for (const c of cols) doc.text(c.t, c.x + 3, y + 5, { width: c.w - 6, align: c.a, lineBreak: false });
    y += 18;
  };
  kopfZeile();

  positionen.forEach((p, i) => {
    doc.font('Helvetica').fontSize(9);
    const kgVal = (p.kg && p.kg > 0) ? String(p.kg).replace('.', ',') : '–';
    const werte = [String(p.pos), String(p.menge), p.profil, p.laenge ? fmt(p.laenge) : '–', kgVal, p.winkel || '–', '', p.bemerk || '–'];
    const h = Math.max(24, ...werte.map((v, k) => doc.heightOfString(v, { width: cols[k].w - 6 }))) + 8;
    if (platz(h)) kopfZeile();
    doc.font('Helvetica').fontSize(9);
    if (i % 2 === 1) doc.rect(M, y, W, h).fill('#fafafa');
    doc.fillColor(SCHW);
    werte.forEach((v, k) => { if (k !== 6) doc.text(v, cols[k].x + 3, y + 4, { width: cols[k].w - 6, align: cols[k].a }); });
    zeichneSchnitt(doc, cols[6].x + 2, y + (h - 14) / 2, 44, 14, schnittInfo(p.winkel));
    y += h;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.4).strokeColor(LINIE).stroke();
  });

  y += 8;
  const gesamtKg = positionen.reduce((s, p) => s + (Number(p.kg) || 0) * (Number(p.menge) || 1), 0);
  if (gesamtKg > 0) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(SCHW)
      .text(`Gesamtgewicht (ca.): ${fmt(Math.round(gesamtKg * 10) / 10)} kg`, M, y, { width: W });
    y += 14;
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(GRAU)
    .text('Winkel = Abweichung vom geraden 90°-Schnitt.  Skizze: Draufsicht auf das Teil, links = Anfang, rechts = Ende (schematisch).  ≈ kg = Schätzwert der KI (1 Stück).',
      M, y, { width: W });
  y += 24;

  // ── Optimierungsergebnis pro Profil ───────────────────────
  platz(60);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(SCHW).text('Optimierte Schnittaufteilung', M, y, { lineBreak: false });
  y += 22;

  for (const g of gruppen) {
    platz(70);
    // Profil-Header
    doc.roundedRect(M, y, W, 22, 3).fill(HELLBL);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BLAU)
      .text(g.profil, M + 8, y + 6, { width: W * 0.45, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(8.5).fillColor(BLAU)
      .text(`${g.stangenzahl} Stange(n)  ·  Ausnutzung ${g.ausnutzung} %  ·  Verschnitt ${fmt(g.verschnittGes)} mm`,
        M + W * 0.45, y + 7, { width: W * 0.55 - 8, align: 'right', lineBreak: false });
    y += 30;

    let stIdx = 0;
    for (const stange of g.stangen) {
      stIdx++;
      const teileText = stange.teile.map(t => `${fmt(t.laenge)} (Pos ${t.pos}${t.winkel ? ', ' + t.winkel : ''})`).join('  ·  ')
        + (stange.uebermas ? '' : `   —   Rest: ${fmt(stange.rest)} mm`);
      doc.font('Helvetica').fontSize(8);
      const textH = doc.heightOfString(teileText, { width: W - 10 });
      platz(12 + 14 + textH + 14);

      doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAU)
        .text(stange.uebermas ? 'Übermaß-Stück' : `Stange ${stIdx}`, M + 5, y, { lineBreak: false });
      y += 12;

      const barX = M + 5, barW = W - 10, barH = 14;
      doc.rect(barX, y, barW, barH).fill('#e5e7eb');
      let xCur = barX;
      stange.teile.forEach((t, ci) => {
        const tw = stange.uebermas ? barW : Math.max(1, (t.laenge / stangenlaenge) * barW);
        doc.rect(xCur, y, Math.min(tw, barX + barW - xCur), barH).fill(COLORS[ci % COLORS.length]);
        xCur += tw;
        if (!stange.uebermas && ci < stange.teile.length - 1) {
          // Schnittfuge (Sägeblatt) als sichtbare Lücke zwischen den Teilen
          doc.moveTo(xCur, y).lineTo(xCur, y + barH).lineWidth(0.6).strokeColor('#ffffff').stroke();
          xCur += (saege / stangenlaenge) * barW;
        }
      });
      doc.rect(barX, y, barW, barH).lineWidth(0.5).strokeColor('#9ca3af').stroke();
      y += barH + 5;

      doc.font('Helvetica').fontSize(8).fillColor(SCHW)
        .text(teileText, barX, y, { width: barW });
      y += textH + 12;
    }
    y += 6;
  }

  // ── Zusammenfassung ───────────────────────────────────────
  platz(40);
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(LINIE).stroke();
  y += 10;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(SCHW)
    .text(`Gesamt: ${gruppen.reduce((s, g) => s + g.stangenzahl, 0)} Stange(n)   |   ` +
      `Ø Ausnutzung: ${Math.round(gruppen.reduce((s,g)=>s+g.ausnutzung,0)/Math.max(gruppen.length,1))} %   |   ` +
      `Gesamtlänge Teile: ${fmt(gruppen.reduce((s,g)=>s+g.gesamtLaenge,0))} mm`, M, y, { width: W });

  // Seitenzahlen
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(GRAU)
      .text(`Seite ${i + 1} / ${range.count}`, M, doc.page.height - 40, { width: W, align: 'right', lineBreak: false });
  }

  doc.end();
}

// ══════════════════════════════════════════════════════════════
//  ROUTEN
// ══════════════════════════════════════════════════════════════

// GET  /schnittliste  – Formular-Seite
router.get('/', requireSchnittliste, (req, res) => {
  res.render('schnittliste', { currentUser: req.user, fehler: null, ergebnis: null });
});

// POST /schnittliste  – Datei hochladen + Vorschau (JSON)
router.post('/upload', requireSchnittliste, upload.single('datei'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ fehler: 'Keine Datei hochgeladen.' });

    const stangenlaenge = parseInt(req.body.stangenlaenge || '6000', 10);
    if (stangenlaenge < 100 || stangenlaenge > 20000) {
      return res.status(400).json({ fehler: 'Stangenlänge muss zwischen 100 und 20.000 mm liegen.' });
    }

    let positionen;
    if (/\.xlsx$/i.test(req.file.originalname)) {
      positionen = parseXlsx(req.file.buffer);
    } else {
      positionen = parseCsv(req.file.buffer);
    }

    if (positionen.length === 0) {
      return res.status(400).json({ fehler: 'Die Datei enthält keine auswertbaren Zeilen.' });
    }

    const saege   = parseSaege(req.body);
    const gruppen = optimiere(positionen, stangenlaenge, saege);
    res.json({ ok: true, positionen, gruppen, stangenlaenge, saege });
  } catch (err) {
    res.status(400).json({ fehler: err.message });
  }
});

// POST /schnittliste/pdf  – PDF herunterladen
router.post('/pdf', requireSchnittliste, upload.single('datei'), (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Keine Datei hochgeladen.');

    const stangenlaenge = parseInt(req.body.stangenlaenge || '6000', 10);
    const firmaName     = req.body.firma_name || '';

    let positionen;
    if (/\.xlsx$/i.test(req.file.originalname)) {
      positionen = parseXlsx(req.file.buffer);
    } else {
      positionen = parseCsv(req.file.buffer);
    }

    const saege    = parseSaege(req.body);
    const gruppen  = optimiere(positionen, stangenlaenge, saege);
    const dateiname = `Schnittliste_${new Date().toISOString().slice(0,10)}.pdf`;
    erzeugePdf(res, dateiname, positionen, gruppen, stangenlaenge, firmaName, saege);
  } catch (err) {
    res.status(400).send('Fehler: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════
//  VISION-KI-HILFSFUNKTION  (gleiche Infrastruktur wie server.js)
// ══════════════════════════════════════════════════════════════

const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
const VISION_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
];

const VISION_PROMPT_BASIS = `Du bist ein erfahrener Metallbau-Konstrukteur und Experte für technische Zeichnungen.
Du erhältst ein Bild — das kann eine technische Zeichnung, eine Prinzipskizze, ein Katalogblatt oder ein Foto eines Geländers / einer Stahlkonstruktion sein.
Deine Aufgabe: Erkenne ALLE Bauteile, Profile und Materialien und erstelle daraus eine Schnittliste.

WICHTIG — auch bei Prinzipskizzen ohne exakte Maße:
- Wenn nur ein Durchmesser oder Profiltyp erkennbar ist (z.B. "Ø33,7mm", "Ø12mm Vollmaterial"): trotzdem als Position aufnehmen
- Jedes erkennbare Bauteil / Material einzeln aufnehmen, auch wenn die genaue Länge fehlt
- Bei fehlender Länge: laenge:0 setzen — der Benutzer trägt sie später ein
- Wenn "LÄNGE" oder "HÖHE" als Platzhalter steht: trage laenge:0 ein und schreibe den Platzhalter in "bemerk"
- Wenn eine Stückliste im Bild steht, übernimm sie exakt.
- WINKEL: Erfasse alle Schnitt- und Gehrungswinkel je Position im Feld "winkel" (z.B. "35° / 17,5°" = Winkel am Anfang / am Ende des Teils, oder "45°" bei einem Winkel). Quellen: Spalte "Schnitt"/"Winkel" der Stückliste, Winkelangaben (°) an Gehrungen, Detailansichten und Neigungen der Bauteile. Gerade Schnitte (90°) nur eintragen, wenn sie ausdrücklich angegeben sind; sonst leer lassen ("").
- Sind beide Enden eines Teils parallel geschnitten (Parallelogramm, z.B. schräge Wange zwischen senkrechten Pfosten), hänge " parallel" an den Winkeltext an (z.B. "35° / 35° parallel").
- Das Feld "winkel" MUSS in JEDEM Objekt vorhanden sein. Steht in der Stückliste eine Spalte "Schnitt" oder "Winkel", übernimm deren Wert für jede Position wörtlich (auch "90°/90°").
- GEWICHT (kg): Schätze das ungefähre Gewicht EINER Einheit (1 Stück × Länge) in kg. Grundlage: Stahl-Dichte ≈ 7,85 kg/dm³. Nutze bekannte Metergewichte von Standardprofilen (z.B. Rohr Ø42,4×2,5 ≈ 2,4 kg/m, Rohr Ø33,7×2 ≈ 1,6 kg/m, IPE 200 ≈ 22,4 kg/m, HEB 160 ≈ 42,6 kg/m, ROR 60×60×3 ≈ 5,2 kg/m, Flachstahl 40×5 ≈ 1,57 kg/m, Vierkant 20×20 ≈ 3,14 kg/m). Formel grob: kg ≈ (kg/m) × (laenge_mm / 1000). Bei unklarem Profil oder laenge:0 → kg:0. Runde auf 1 Nachkommastelle.

Antworte AUSSCHLIESSLICH mit einem JSON-Array, z.B.:
[
  {"pos":"1","menge":1,"profil":"Rohr Ø42,4x2,5mm","laenge":2450,"winkel":"35° / 17,5°","bemerk":"Handlauf","kg":5.9},
  {"pos":"2","menge":4,"profil":"Rohr Ø33,7mm","laenge":0,"winkel":"","bemerk":"Vertikal-Füllstab","kg":0}
]
Regeln:
- "laenge" als Ganzzahl in mm; 0 wenn keine konkrete Länge erkennbar
- "menge" als Ganzzahl; 1 wenn unklar; bei sichtbaren Wiederholungen die Anzahl schätzen
- "profil" so präzise wie erkennbar (Durchmesser, Wandstärke, Profiltyp)
- "winkel" = Schnitt-/Gehrungswinkel als Text, leer wenn keiner erkennbar
- "bemerk" = Bauteilname aus dem Bild + wichtige Hinweise
- "kg" = ungefähres Gewicht EINER Einheit in kg (Zahl, 1 Nachkommastelle); 0 wenn nicht schätzbar
- "pos" = fortlaufend nummerieren
- Keine Codeblöcke, kein Markdown, nur reines JSON`;

function visionPrompt(anzahl) {
  if (anzahl <= 1) return VISION_PROMPT_BASIS;
  return VISION_PROMPT_BASIS + `

MEHRERE BILDER: Du erhältst ${anzahl} Bilder derselben Konstruktion (z.B. Gesamtansicht, Detailzeichnung, Stückliste, Foto). Werte ALLE Bilder gemeinsam aus und erstelle EINE zusammengeführte Schnittliste:
- Jedes Bauteil nur EINMAL aufnehmen, auch wenn es auf mehreren Bildern vorkommt.
- Maße, Winkel und Profile aus verschiedenen Bildern kombinieren (z.B. Länge aus der Gesamtansicht, Winkel aus dem Detail, Profil aus der Stückliste).
- Widersprechen sich Bilder, bevorzuge die Stückliste und schreibe den Widerspruch in "bemerk".`;
}

async function callGeminiVision(bilder, errors) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  for (const model of GEMINI_MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: visionPrompt(bilder.length) },
              ...bilder.map(b => ({ inline_data: { mime_type: b.mimeType, data: b.b64 } }))
            ]}],
            generationConfig: { temperature: 0.1 }
          })
        }
      );
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('');
      if (r.ok && text) return text;
      errors.push(`Gemini ${model}: ${data?.error?.message || 'leere Antwort'}`);
    } catch (e) {
      errors.push(`Gemini ${model}: ${e.message}`);
    }
  }
  return null;
}

async function callOpenRouterVision(bilder, errors) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  for (const model of VISION_MODELS) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.APP_URL || 'https://metallbau-app.onrender.com',
          'X-Title': 'Metallbau App'
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: visionPrompt(bilder.length) },
              ...bilder.map(b => ({ type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.b64}` } }))
            ]
          }],
          temperature: 0.1
        })
      });
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (response.ok && text) return text;
      errors.push(`OpenRouter ${model}: ${data?.error?.message || 'leere Antwort'}`);
    } catch (e) {
      errors.push(`OpenRouter ${model}: ${e.message}`);
    }
  }
  return null;
}

async function callVisionKI(bilder) {
  if (!process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    throw new Error('Weder GEMINI_API_KEY noch OPENROUTER_API_KEY konfiguriert.');
  }
  const errors = [];
  const text = (await callGeminiVision(bilder, errors))
            || (await callOpenRouterVision(bilder, errors));
  if (text) return text;
  throw new Error('Alle Vision-Modelle nicht verfügbar: ' + errors.join(' | ').slice(0, 600));
}

// POST /schnittliste/bild  – Bild analysieren → Positionen zurückgeben
router.post('/bild', requireSchnittliste, bildUpload.array('bild', 4), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ fehler: 'Kein Bild hochgeladen.' });
  if (!process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ fehler: 'KI-Analyse nicht konfiguriert (GEMINI_API_KEY oder OPENROUTER_API_KEY fehlt).' });
  }

  try {
    const bilder  = req.files.map(f => ({ b64: f.buffer.toString('base64'), mimeType: f.mimetype }));
    const rawText = await callVisionKI(bilder);

    // JSON aus KI-Antwort extrahieren (auch wenn leichter Zusatztext dabei ist)
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(422).json({
        fehler: 'Die KI konnte keine Schnittlisten-Daten im Bild erkennen.',
        rohAntwort: rawText.slice(0, 300)
      });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return res.status(422).json({ fehler: 'Keine Positionen im Bild erkennbar.' });
    }

    // Normalisieren — auch Positionen ohne Länge (laenge:0) zulassen
    const positionen = parsed
      .filter(p => p.profil && String(p.profil).trim() !== '')
      .map((p, i) => ({
        pos:    String(p.pos || i + 1),
        menge:  Math.max(1, parseInt(p.menge, 10) || 1),
        profil: String(p.profil).trim(),
        laenge: Math.max(0, Math.round(parseFloat(p.laenge) || 0)),
        bemerk: String(p.bemerk || '').trim(),
        winkel: String(p.winkel || '').trim(),
        kg:     Math.max(0, Math.round((parseFloat(p.kg) || 0) * 10) / 10)
      }));

    if (positionen.length === 0) {
      return res.status(422).json({
        fehler: 'Keine Bauteile erkannt. Bitte prüfe ob das Bild eine technische Zeichnung oder Skizze mit Profilbezeichnungen enthält.',
        rohAntwort: rawText.slice(0, 500)
      });
    }

    const stangenlaenge = parseInt(req.body.stangenlaenge || '6000', 10) || 6000;
    const saege         = parseSaege(req.body);
    const gruppen       = optimiere(positionen, stangenlaenge, saege);

    res.json({ ok: true, positionen, gruppen, stangenlaenge, saege });
  } catch (err) {
    console.error('Schnittliste Bild-KI Fehler:', err.message);
    res.status(500).json({ fehler: 'KI-Analyse fehlgeschlagen: ' + err.message });
  }
});

module.exports = router;
