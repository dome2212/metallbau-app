const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const PDFDocument = require('pdfkit');
const { requirePerm } = require('../middleware/auth');
const { dbQuery } = require('../utils/db');

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
  const iKg     = idx(['kg', 'gewicht', 'weight']);

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
    const profil = (cols[iProfil] || '').trim();
    // Zeilen ohne Profil überspringen; Länge 0 ist erlaubt (KI / manuell nachtragen)
    if (!profil) continue;

    const kgRaw = iKg !== -1 ? parseFloat((cols[iKg] || '').replace(',', '.')) : 0;
    rows.push({
      pos:     iPos !== -1 ? (cols[iPos] || String(i)) : String(i),
      menge,
      profil,
      laenge,
      bemerk:  iBemerk !== -1 ? (cols[iBemerk] || '') : '',
      winkel:  iWinkel !== -1 ? (cols[iWinkel] || '').trim() : '',
      kg:      Math.max(0, Math.round((kgRaw || 0) * 10) / 10),
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

function normProfil(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[,]/g, '.');
}

function parseLaengeMm(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(',', '.').replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * @param {Array} reststuecke optional [{id, profil, laenge}] – Reststücke aus dem Lager
 */
function optimiere(positionen, stangenlaenge, saege = 0, reststuecke = []) {
  const stuecke = [];
  for (const p of positionen) {
    for (let i = 0; i < p.menge; i++) {
      stuecke.push({
        pos: p.pos,
        profil: p.profil,
        laenge: p.laenge,
        bemerk: p.bemerk,
        winkel: p.winkel || '',
        kg: p.kg || 0
      });
    }
  }

  const gruppen = {};
  for (const s of stuecke) {
    if (!gruppen[s.profil]) gruppen[s.profil] = [];
    gruppen[s.profil].push(s);
  }

  // Reststücke nach Profil-Schlüssel
  const restePool = (Array.isArray(reststuecke) ? reststuecke : []).map(r => ({
    id: r.id,
    profil: r.profil || r.bezeichnung || '',
    laenge: parseLaengeMm(r.laenge),
    used: false
  })).filter(r => r.laenge > 0);

  const ergebnis = [];
  let globalSchritt = 0;
  const verwendeteReste = [];

  for (const [profil, teile] of Object.entries(gruppen)) {
    const sorted = [...teile].sort((a, b) => b.laenge - a.laenge);
    const stangen = [];
    const pKey = normProfil(profil);

    for (const teil of sorted) {
      if (teil.laenge > stangenlaenge) {
        stangen.push({ rest: 0, teile: [teil], uebermas: true, istRest: false });
        continue;
      }
      let gefunden = false;

      // 1) Auf bereits geöffnete Stangen/Reste packen
      for (const stange of stangen) {
        const bedarf = teil.laenge + (stange.teile.length > 0 ? saege : 0);
        if (!stange.uebermas && stange.rest >= bedarf) {
          stange.rest -= bedarf;
          stange.teile.push(teil);
          gefunden = true;
          break;
        }
      }
      if (gefunden) continue;

      // 2) Passendes Reststück aus dem Lager (Profil match, Länge reicht)
      const kandidaten = restePool
        .filter(r => !r.used && r.laenge >= teil.laenge && (
          normProfil(r.profil) === pKey ||
          normProfil(r.profil).includes(pKey) ||
          pKey.includes(normProfil(r.profil))
        ))
        .sort((a, b) => a.laenge - b.laenge); // kleinstes passendes Reststück
      if (kandidaten.length) {
        const r = kandidaten[0];
        r.used = true;
        verwendeteReste.push({ id: r.id, profil: r.profil, laenge: r.laenge });
        stangen.push({
          rest: r.laenge - teil.laenge,
          teile: [teil],
          uebermas: false,
          istRest: true,
          restId: r.id,
          restUrsprung: r.laenge
        });
        continue;
      }

      // 3) Neue volle Stange
      stangen.push({
        rest: stangenlaenge - teil.laenge,
        teile: [teil],
        uebermas: false,
        istRest: false
      });
    }

    const schnittfolge = [];
    let stIdx = 0;
    for (const stange of stangen) {
      stIdx++;
      const folge = [];
      stange.teile.forEach((t, ti) => {
        globalSchritt += 1;
        const schritt = {
          nr: globalSchritt,
          stangeNr: stIdx,
          teilNr: ti + 1,
          pos: t.pos,
          laenge: t.laenge,
          winkel: t.winkel || '',
          bemerk: t.bemerk || '',
          uebermas: !!stange.uebermas,
          istRest: !!stange.istRest
        };
        folge.push(schritt);
        schnittfolge.push(schritt);
        t.schnittNr = globalSchritt;
      });
      stange.folge = folge;
      stange.stangeNr = stIdx;
    }

    const gesamtLaenge  = teile.reduce((s, t) => s + t.laenge, 0);
    const neueStangen   = stangen.filter(s => !s.uebermas && !s.istRest);
    const restStangen   = stangen.filter(s => s.istRest);
    const stangenzahl   = neueStangen.length; // nur neu zu bestellende Stangen
    const verschnittGes = stangen.filter(s => !s.uebermas).reduce((s, st) => s + st.rest, 0);
    const basisLaenge   = (stangenzahl * stangenlaenge) + restStangen.reduce((s, st) => s + (st.restUrsprung || 0), 0);
    const ausnutzung    = basisLaenge > 0
      ? Math.round((gesamtLaenge / basisLaenge) * 100)
      : 100;

    // Reststücke die nach dem Schnitt übrig bleiben (>= 300 mm sinnvoll)
    const neueReste = stangen
      .filter(s => !s.uebermas && s.rest >= 300)
      .map(s => ({
        profil,
        laenge: Math.round(s.rest),
        vonRest: !!s.istRest,
        restId: s.restId || null
      }));

    ergebnis.push({
      profil,
      stangen,
      gesamtLaenge,
      stangenzahl,
      reststangenZahl: restStangen.length,
      verschnittGes,
      ausnutzung,
      schnittfolge,
      neueReste
    });
  }

  // Meta anhängen (nicht in Gruppen-Array, sondern als Property auf dem Array)
  ergebnis.verwendeteReste = verwendeteReste;
  return ergebnis;
}

/** Materialbedarf: Stangen je Profil + kg-Summe */
function materialbedarf(positionen, gruppen, stangenlaenge) {
  const byProfil = {};
  for (const g of gruppen) {
    byProfil[g.profil] = {
      profil: g.profil,
      stangen: g.stangenzahl,
      reststangen: g.reststangenZahl || 0,
      gesamtLaengeMm: g.gesamtLaenge,
      verschnittMm: g.verschnittGes,
      kg: 0
    };
  }
  for (const p of positionen) {
    if (!byProfil[p.profil]) {
      byProfil[p.profil] = {
        profil: p.profil, stangen: 0, reststangen: 0,
        gesamtLaengeMm: 0, verschnittMm: 0, kg: 0
      };
    }
    byProfil[p.profil].kg += (Number(p.kg) || 0) * (Number(p.menge) || 1);
  }
  const zeilen = Object.values(byProfil).map(z => ({
    ...z,
    kg: Math.round(z.kg * 10) / 10,
    stangenlaenge
  }));
  const sumStangen = zeilen.reduce((s, z) => s + z.stangen, 0);
  const sumKg = Math.round(zeilen.reduce((s, z) => s + z.kg, 0) * 10) / 10;
  return { zeilen, sumStangen, sumKg, stangenlaenge };
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

function erzeugePdf(res, dateiname, positionen, gruppen, stangenlaenge, firmaName, saege = 0, projectTitle = '') {
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
  const auftrag = String(projectTitle || '').trim();

  let y = M;
  // Platz für "h" Punkte sicherstellen, sonst neue Seite
  const platz = h => { if (y + h > BOTTOM) { doc.addPage(); y = M; return true; } return false; };

  // ── Kopf ──────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(20).fillColor(BLAU).text('Schnittliste', M, y, { width: W, lineBreak: false });
  y += 26;
  if (auftrag) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(SCHW)
      .text('Auftrag: ' + auftrag, M, y, { width: W, lineBreak: false });
    y += 18;
  }
  doc.font('Helvetica').fontSize(9).fillColor(GRAU)
    .text(`${firmaName || 'Metallbau'}  ·  Stangenlänge: ${fmt(stangenlaenge)} mm  ·  Sägeblatt: ${saege} mm  ·  Erstellt: ${new Date().toLocaleDateString('de-DE')}`,
      M, y, { width: W, lineBreak: false });
  y += 16;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.2).strokeColor(BLAU).stroke();
  y += 16;

  // ── Positionstabelle ─────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(11).fillColor(SCHW).text('Positionen', M, y, { lineBreak: false });
  y += 18;

  // Feste Spaltenbreiten – Summe muss <= W sein (A4 bei M=45: ~505 pt)
  // Pos | Menge | Profil | Länge | kg | Winkel | Schnitt | Bemerkung
  const cW = [22, 38, 118, 50, 32, 68, 48];
  let cx = M;
  const cols = [
    { x: cx, w: cW[0], t: 'Pos',       a: 'left'  },
    { x: (cx += cW[0]), w: cW[1], t: 'Menge',  a: 'right' },
    { x: (cx += cW[1]), w: cW[2], t: 'Profil', a: 'left'  },
    { x: (cx += cW[2]), w: cW[3], t: 'L (mm)', a: 'right' },
    { x: (cx += cW[3]), w: cW[4], t: 'kg',     a: 'right' },
    { x: (cx += cW[4]), w: cW[5], t: 'Winkel', a: 'left'  },
    { x: (cx += cW[5]), w: cW[6], t: 'Schnitt',a: 'center'},
    { x: (cx += cW[6]), w: M + W - cx, t: 'Bemerkung', a: 'left' },
  ];
  const kopfZeile = () => {
    doc.rect(M, y, W, 16).fill('#f3f4f6');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GRAU);
    for (const c of cols) {
      doc.text(c.t, c.x + 2, y + 4, { width: c.w - 4, align: c.a, lineBreak: false });
    }
    y += 16;
  };
  kopfZeile();

  positionen.forEach((p, i) => {
    doc.font('Helvetica').fontSize(8);
    const kgVal = (p.kg && p.kg > 0) ? String(p.kg).replace('.', ',') : '-';
    const werte = [
      String(p.pos),
      String(p.menge),
      p.profil || '-',
      p.laenge ? fmt(p.laenge) : '-',
      kgVal,
      p.winkel || '-',
      '',
      p.bemerk || '-'
    ];
    // Hoehe: Profil/Bemerkung duerfen umbrechen, Rest einzeilig
    const hProfil = doc.heightOfString(werte[2], { width: cols[2].w - 4 });
    const hBemerk = doc.heightOfString(werte[7], { width: cols[7].w - 4 });
    const h = Math.max(20, hProfil, hBemerk, 14) + 6;
    if (platz(h)) kopfZeile();
    doc.font('Helvetica').fontSize(8);
    if (i % 2 === 1) doc.rect(M, y, W, h).fill('#fafafa');
    doc.fillColor(SCHW);
    // Pos, Menge, Laenge, kg – einzeilig
    [0, 1, 3, 4].forEach(k => {
      doc.text(werte[k], cols[k].x + 2, y + 4, { width: cols[k].w - 4, align: cols[k].a, lineBreak: false });
    });
    // Profil + Bemerkung – duerfen umbrechen
    doc.text(werte[2], cols[2].x + 2, y + 4, { width: cols[2].w - 4, align: 'left' });
    doc.text(werte[7], cols[7].x + 2, y + 4, { width: cols[7].w - 4, align: 'left' });
    // Winkel einzeilig
    doc.text(werte[5], cols[5].x + 2, y + 4, { width: cols[5].w - 4, align: 'left', lineBreak: false });
    // Schnitt-Skizze
    zeichneSchnitt(doc, cols[6].x + 3, y + (h - 12) / 2, 40, 12, schnittInfo(p.winkel));
    y += h;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.4).strokeColor(LINIE).stroke();
  });

  y += 8;
  const gesamtKg = positionen.reduce((s, p) => s + (Number(p.kg) || 0) * (Number(p.menge) || 1), 0);
  if (gesamtKg > 0) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(SCHW)
      .text('Gesamtgewicht (ca.): ' + fmt(Math.round(gesamtKg * 10) / 10) + ' kg', M, y, { width: W });
    y += 14;
  }
  doc.font('Helvetica').fontSize(7).fillColor(GRAU)
    .text('Winkel = Abweichung vom geraden 90-Grad-Schnitt.  Skizze: Draufsicht.  kg = Schaetzwert der KI pro Stueck.',
      M, y, { width: W });
  y += 22;

  // ── Optimierungsergebnis pro Profil ───────────────────────
  platz(60);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(SCHW).text('Optimierte Schnittaufteilung', M, y, { lineBreak: false });
  y += 14;
  doc.font('Helvetica').fontSize(8).fillColor(GRAU)
    .text('Reihenfolge: große Teile zuerst auf die Stange legen – so entsteht weniger Verschnitt.', M, y, { width: W, lineBreak: false });
  y += 18;

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
      const teileText = stange.teile.map((t, ti) => {
        const nr = t.schnittNr || (stange.folge && stange.folge[ti] && stange.folge[ti].nr) || (ti + 1);
        return `#${nr} Pos ${t.pos}: ${fmt(t.laenge)} mm${t.winkel ? ' (' + t.winkel + ')' : ''}`;
      }).join('  →  ')
        + (stange.uebermas ? '' : `   —   Rest: ${fmt(stange.rest)} mm`);
      doc.font('Helvetica').fontSize(8);
      const textH = doc.heightOfString(teileText, { width: W - 10 });
      platz(12 + 14 + textH + 14);

      doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAU)
        .text(stange.uebermas ? 'Übermaß-Stück' : `Stange ${stIdx} – Schnittreihenfolge`, M + 5, y, { lineBreak: false });
      y += 12;

      const barX = M + 5, barW = W - 10, barH = 14;
      doc.rect(barX, y, barW, barH).fill('#e5e7eb');
      let xCur = barX;
      stange.teile.forEach((t, ci) => {
        const tw = stange.uebermas ? barW : Math.max(1, (t.laenge / stangenlaenge) * barW);
        doc.rect(xCur, y, Math.min(tw, barX + barW - xCur), barH).fill(COLORS[ci % COLORS.length]);
        xCur += tw;
        if (!stange.uebermas && ci < stange.teile.length - 1) {
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

  // ── Empfohlene Schnittreihenfolge (gesamt) ────────────────
  const alleSchritte = [];
  for (const g of gruppen) {
    for (const s of (g.schnittfolge || [])) {
      alleSchritte.push({ ...s, profil: g.profil });
    }
  }
  if (alleSchritte.length) {
    platz(50);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(SCHW)
      .text('Empfohlene Schnittreihenfolge (weniger Verschnitt)', M, y, { lineBreak: false });
    y += 14;
    doc.font('Helvetica').fontSize(8).fillColor(GRAU)
      .text('In dieser Reihenfolge schneiden – zuerst die längsten Teile je Profil, Stange für Stange.', M, y, { width: W });
    y += 16;

    // Tabellenkopf
    const cNr = 28, cPos = 45, cProf = 130, cLen = 70, cSt = 70, cRest = W - 28 - 45 - 130 - 70 - 70;
    platz(16);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GRAU);
    doc.text('Nr', M, y, { width: cNr, lineBreak: false });
    doc.text('Pos', M + cNr, y, { width: cPos, lineBreak: false });
    doc.text('Profil', M + cNr + cPos, y, { width: cProf, lineBreak: false });
    doc.text('Länge', M + cNr + cPos + cProf, y, { width: cLen, lineBreak: false });
    doc.text('Stange', M + cNr + cPos + cProf + cLen, y, { width: cSt, lineBreak: false });
    doc.text('Winkel / Hinweis', M + cNr + cPos + cProf + cLen + cSt, y, { width: cRest, lineBreak: false });
    y += 11;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(LINIE).stroke();
    y += 4;

    for (const s of alleSchritte) {
      platz(14);
      const hinweis = [s.winkel, s.bemerk, s.uebermas ? 'Übermaß' : ''].filter(Boolean).join(' · ');
      doc.font('Helvetica-Bold').fontSize(8).fillColor(BLAU)
        .text(String(s.nr), M, y, { width: cNr, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(SCHW)
        .text(String(s.pos), M + cNr, y, { width: cPos, lineBreak: false })
        .text(String(s.profil || '').slice(0, 28), M + cNr + cPos, y, { width: cProf, lineBreak: false, ellipsis: true })
        .text(fmt(s.laenge) + ' mm', M + cNr + cPos + cProf, y, { width: cLen, lineBreak: false })
        .text(s.uebermas ? 'Übermaß' : ('Stange ' + s.stangeNr), M + cNr + cPos + cProf + cLen, y, { width: cSt, lineBreak: false })
        .text(hinweis.slice(0, 40), M + cNr + cPos + cProf + cLen + cSt, y, { width: cRest, lineBreak: false, ellipsis: true });
      y += 13;
    }
    y += 8;
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

/** PDF: Materialbedarf / Bestellliste für Stahlhändler */
function erzeugeBestellPdf(res, dateiname, bedarf, firmaName, projectTitle) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${dateiname}"`);
  doc.pipe(res);
  const M = 40, W = 515;
  const SCHW = '#111827', GRAU = '#6b7280', BLAU = '#1d4ed8', LINIE = '#e5e7eb';
  const fmt = n => Number(n).toLocaleString('de-DE');

  doc.font('Helvetica-Bold').fontSize(16).fillColor(SCHW).text('Materialbedarf / Bestellliste', M, 40);
  doc.font('Helvetica').fontSize(9).fillColor(GRAU)
    .text(`${firmaName || 'Metallbau'}  ·  ${new Date().toLocaleDateString('de-DE')}`, M, 62, { width: W });
  if (projectTitle) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BLAU).text('Auftrag: ' + projectTitle, M, 80, { width: W });
  }
  let y = projectTitle ? 105 : 85;

  doc.font('Helvetica').fontSize(9).fillColor(SCHW)
    .text(`Stangenlänge Standard: ${fmt(bedarf.stangenlaenge)} mm`, M, y);
  y += 18;

  const cols = [
    { t: 'Profil', w: 200 },
    { t: 'Stangen', w: 70 },
    { t: 'ca. kg', w: 70 },
    { t: 'Teile-Länge', w: 90 },
    { t: 'Hinweis', w: 85 }
  ];
  let x = M;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAU);
  cols.forEach(c => { doc.text(c.t, x, y, { width: c.w, lineBreak: false }); x += c.w; });
  y += 12;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(LINIE).stroke();
  y += 6;

  for (const z of bedarf.zeilen) {
    if (y > 750) { doc.addPage(); y = 50; }
    x = M;
    const hinweis = z.reststangen ? (z.reststangen + '× Reststück genutzt') : '';
    const vals = [
      String(z.profil).slice(0, 40),
      String(z.stangen),
      fmt(z.kg),
      fmt(z.gesamtLaengeMm) + ' mm',
      hinweis
    ];
    doc.font('Helvetica').fontSize(9).fillColor(SCHW);
    vals.forEach((v, i) => { doc.text(v, x, y, { width: cols[i].w, lineBreak: false }); x += cols[i].w; });
    y += 16;
  }

  y += 10;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(LINIE).stroke();
  y += 12;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(SCHW)
    .text(`Summe: ${bedarf.sumStangen} Stange(n)  ·  ca. ${fmt(bedarf.sumKg)} kg`, M, y);
  y += 20;
  doc.font('Helvetica').fontSize(8).fillColor(GRAU)
    .text('Hinweis: Stangenanzahl aus Schnitt-Optimierung. kg = Schätzwert (Stahl ~7,85 kg/dm³). Reststücke aus dem Lager sind bereits abgezogen.', M, y, { width: W });
  doc.end();
}

/** PDF: Angebot aus Schnittliste */
function erzeugeAngebotPdf(res, dateiname, positionen, firmaName, projectTitle, opts = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${dateiname}"`);
  doc.pipe(res);
  const M = 40, W = 515;
  const SCHW = '#111827', GRAU = '#6b7280', BLAU = '#1d4ed8', LINIE = '#e5e7eb';
  const fmt = n => Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtN = n => Number(n).toLocaleString('de-DE');

  const stahlPreisPro100kg = Number(opts.stahlPreis) || 0; // € / 100 kg
  const stunden = Number(opts.stunden) || 0;
  const stundensatz = Number(opts.stundensatz) || 0;
  const mwst = Number(opts.mwst) || 19;

  doc.font('Helvetica-Bold').fontSize(16).fillColor(SCHW).text('Angebot (aus Schnittliste)', M, 40);
  doc.font('Helvetica').fontSize(9).fillColor(GRAU)
    .text(`${firmaName || 'Metallbau'}  ·  ${new Date().toLocaleDateString('de-DE')}`, M, 62, { width: W });
  if (projectTitle) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BLAU).text('Auftrag / Projekt: ' + projectTitle, M, 80, { width: W });
  }
  let y = projectTitle ? 105 : 85;

  // Positionstabelle
  const cW = [35, 45, 160, 70, 55, 70, 80];
  const heads = ['Pos', 'Menge', 'Profil / Bezeichnung', 'Länge', 'kg/Stk', 'kg ges.', 'Material €'];
  let x = M;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GRAU);
  heads.forEach((h, i) => { doc.text(h, x, y, { width: cW[i], lineBreak: false }); x += cW[i]; });
  y += 11;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(LINIE).stroke();
  y += 5;

  let materialSumme = 0;
  let kgSumme = 0;
  for (const p of positionen) {
    if (y > 720) { doc.addPage(); y = 50; }
    const menge = Number(p.menge) || 1;
    const kgStk = Number(p.kg) || 0;
    const kgGes = Math.round(kgStk * menge * 10) / 10;
    kgSumme += kgGes;
    const matEuro = stahlPreisPro100kg > 0 ? (kgGes / 100) * stahlPreisPro100kg : 0;
    materialSumme += matEuro;
    x = M;
    const vals = [
      String(p.pos),
      String(menge),
      String(p.profil || '').slice(0, 36) + (p.bemerk ? ' – ' + String(p.bemerk).slice(0, 20) : ''),
      fmtN(p.laenge) + ' mm',
      kgStk ? String(kgStk).replace('.', ',') : '–',
      kgGes ? String(kgGes).replace('.', ',') : '–',
      matEuro > 0 ? fmt(matEuro) : '–'
    ];
    doc.font('Helvetica').fontSize(8).fillColor(SCHW);
    vals.forEach((v, i) => { doc.text(v, x, y, { width: cW[i], lineBreak: false, ellipsis: true }); x += cW[i]; });
    y += 14;
  }

  y += 8;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(LINIE).stroke();
  y += 14;

  const lohn = stunden * stundensatz;
  const netto = materialSumme + lohn;
  const mwstBetrag = netto * (mwst / 100);
  const brutto = netto + mwstBetrag;

  doc.font('Helvetica').fontSize(9).fillColor(SCHW);
  doc.text(`Gesamtgewicht (ca.): ${fmtN(Math.round(kgSumme * 10) / 10)} kg`, M, y); y += 14;
  if (stahlPreisPro100kg > 0) {
    doc.text(`Material (Stahl ca. ${fmt(stahlPreisPro100kg)} €/100 kg): ${fmt(materialSumme)} €`, M, y); y += 14;
  } else {
    doc.fillColor(GRAU).text('Materialpreis: kein Stahlpreis hinterlegt – nur kg-Angabe.', M, y); y += 14;
    doc.fillColor(SCHW);
  }
  if (stunden > 0 && stundensatz > 0) {
    doc.text(`Arbeitszeit: ${fmtN(stunden)} h × ${fmt(stundensatz)} €/h = ${fmt(lohn)} €`, M, y); y += 14;
  }
  y += 4;
  doc.font('Helvetica-Bold').fontSize(11)
    .text(`Netto: ${fmt(netto)} €`, M, y); y += 16;
  doc.font('Helvetica').fontSize(9)
    .text(`MwSt. ${mwst} %: ${fmt(mwstBetrag)} €`, M, y); y += 14;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BLAU)
    .text(`Brutto: ${fmt(brutto)} €`, M, y); y += 24;

  doc.font('Helvetica').fontSize(8).fillColor(GRAU)
    .text('Unverbindliche Kalkulation auf Basis der Schnittliste. kg und Preise sind Schätzwerte. Kein rechtsverbindliches Angebot ohne Prüfung.', M, y, { width: W });
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
    const projectTitle  = String(req.body.project_name || '').trim();

    let positionen;
    if (/\.xlsx$/i.test(req.file.originalname)) {
      positionen = parseXlsx(req.file.buffer);
    } else {
      positionen = parseCsv(req.file.buffer);
    }

    const saege    = parseSaege(req.body);
    const gruppen  = optimiere(positionen, stangenlaenge, saege);
    const safeTitle = projectTitle
      ? projectTitle.replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '_').slice(0, 40)
      : '';
    const dateiname = safeTitle
      ? `Schnittliste_${safeTitle}_${new Date().toISOString().slice(0,10)}.pdf`
      : `Schnittliste_${new Date().toISOString().slice(0,10)}.pdf`;
    erzeugePdf(res, dateiname, positionen, gruppen, stangenlaenge, firmaName, saege, projectTitle);
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
  const multi = anzahl <= 1 ? '' : `

MEHRERE BILDER (${anzahl}): Du erhältst mehrere Bilder derselben Konstruktion (z.B. Handskizze, CAD-Zeichnung, Stücklistentabelle, Detail, Foto).
Werte ALLE gemeinsam aus und erstelle EINE zusammengeführte Schnittliste:
- Stücklistentabelle hat Vorrang bei Pos/Menge/Profil/Länge – ergänze fehlende Winkel/kg aus Skizze und Details.
- Handskizze + Bemaßung: alle erkennbaren Längen und Winkel übernehmen.
- Jedes Bauteil nur EINMAL; Maße aus verschiedenen Bildern kombinieren.
- Bei Widerspruch: Stückliste bevorzugen, Hinweis in "bemerk".
- Fehlende Länge → laenge:0 und Platzhalter in "bemerk".`;

  return VISION_PROMPT_BASIS + multi + `

ZUSÄTZLICH:
- Erkenne Handskizzen, CAD, Katalogblätter und Fotos gleichermaßen.
- Wenn nur eine Tabelle (Stückliste) ohne Zeichnung: übernimm alle Zeilen exakt.
- Wenn Zeichnung ohne Tabelle: Positionen aus Bemaßung und Bauteilbezeichnungen ableiten.
- Füllstäbe/Wiederholungen zählen (z.B. 12 gleiche Stäbe → menge:12).`;
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

// ══════════════════════════════════════════════════════════════
//  GESPEICHERTE SCHNITTLISTEN (CRUD)
// ══════════════════════════════════════════════════════════════

// GET /schnittliste/api/projects  – Aufträge für Dropdown (wie Projektliste)
router.get('/api/projects', requireSchnittliste, async (req, res) => {
  try {
    let rows = [];
    try {
      // Identisch zu GET /projects
      const r = await dbQuery(
        `SELECT projects.id, projects.title, projects.status,
                customers.company_name, customers.contact_person
         FROM projects
         LEFT JOIN customers ON projects.customer_id = customers.id
         WHERE projects.deleted_at IS NULL
         ORDER BY projects.title ASC
         LIMIT 500`
      );
      rows = r.rows || [];
    } catch (e1) {
      console.warn('Schnittliste projects JOIN:', e1.message);
      try {
        const r2 = await dbQuery(
          `SELECT id, title, status FROM projects WHERE deleted_at IS NULL ORDER BY title ASC LIMIT 500`
        );
        rows = r2.rows || [];
      } catch (e2) {
        console.warn('Schnittliste projects deleted_at:', e2.message);
        const r3 = await dbQuery(`SELECT id, title, status FROM projects ORDER BY title ASC LIMIT 500`);
        rows = r3.rows || [];
      }
    }
    const projects = rows.map(p => {
      const titel = p.title || ('Auftrag #' + p.id);
      const kunde = p.company_name || p.contact_person || '';
      return {
        id: p.id,
        title: titel,
        status: p.status || '',
        company_name: p.company_name || '',
        label: kunde ? (titel + ' – ' + kunde) : titel
      };
    });
    res.json({ ok: true, projects, anzahl: projects.length });
  } catch (err) {
    console.error('Schnittliste projects:', err.message);
    res.status(500).json({ ok: false, fehler: err.message, projects: [] });
  }
});

// GET /schnittliste/api/list  – alle gespeicherten Listen (optional ?project_id=)
router.get('/api/list', requireSchnittliste, async (req, res) => {
  try {
    const filterPid = parseInt(req.query.project_id, 10) || 0;
    let r;
    try {
      let sql = `
        SELECT s.id, s.name, s.stangenlaenge, s.saege, s.quelle, s.project_id,
               s.created_by_name, s.created_at, s.updated_at, s.positionen_json,
               p.title AS project_title
        FROM schnittlisten s
        LEFT JOIN projects p ON p.id = s.project_id
      `;
      const params = [];
      if (filterPid > 0) {
        sql += ' WHERE s.project_id = ?';
        params.push(filterPid);
      }
      sql += ' ORDER BY s.updated_at DESC, s.id DESC LIMIT 100';
      r = await dbQuery(sql, params);
    } catch (joinErr) {
      // Fallback ohne project_id / JOIN (falls Migration noch nicht gelaufen)
      console.warn('Schnittliste list JOIN:', joinErr.message);
      r = await dbQuery(
        `SELECT id, name, stangenlaenge, saege, quelle, created_by_name, created_at, updated_at, positionen_json
         FROM schnittlisten ORDER BY updated_at DESC, id DESC LIMIT 100`
      );
      (r.rows || []).forEach(row => { row.project_id = null; row.project_title = null; });
    }
    const listen = (r.rows || []).map(row => {
      let anzahl = 0;
      try {
        const arr = JSON.parse(row.positionen_json || '[]');
        anzahl = Array.isArray(arr) ? arr.length : 0;
      } catch (_) {}
      return {
        id: row.id,
        name: row.name,
        stangenlaenge: row.stangenlaenge,
        saege: row.saege,
        quelle: row.quelle,
        project_id: row.project_id || null,
        project_title: row.project_title || null,
        created_by_name: row.created_by_name,
        created_at: row.created_at,
        updated_at: row.updated_at,
        anzahl
      };
    });
    res.json({ ok: true, listen });
  } catch (err) {
    console.error('Schnittliste list:', err.message);
    res.status(500).json({ fehler: 'Listen konnten nicht geladen werden: ' + err.message });
  }
});

// GET /schnittliste/api/:id  – eine Liste laden
router.get('/api/:id', requireSchnittliste, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ fehler: 'Ungültige ID.' });
    const r = await dbQuery(
      `SELECT s.*, p.title AS project_title
       FROM schnittlisten s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
      [id]
    );
    if (!r.rows || r.rows.length === 0) return res.status(404).json({ fehler: 'Schnittliste nicht gefunden.' });
    const row = r.rows[0];
    let positionen = [];
    try { positionen = JSON.parse(row.positionen_json || '[]'); } catch (_) {}
    const stangenlaenge = Number(row.stangenlaenge) || 6000;
    const saege = Number(row.saege) || 3;
    const gruppen = optimiere(positionen, stangenlaenge, saege);
    res.json({
      ok: true,
      id: row.id,
      name: row.name,
      positionen,
      gruppen,
      stangenlaenge,
      saege,
      quelle: row.quelle || 'datei',
      project_id: row.project_id || null,
      project_title: row.project_title || null
    });
  } catch (err) {
    console.error('Schnittliste load:', err.message);
    res.status(500).json({ fehler: 'Laden fehlgeschlagen: ' + err.message });
  }
});

// POST /schnittliste/api/save  – neu speichern oder überschreiben
router.post('/api/save', requireSchnittliste, async (req, res) => {
  try {
    const { name, positionen, stangenlaenge, saege, quelle, id, project_id } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ fehler: 'Bitte einen Namen angeben.' });
    if (!Array.isArray(positionen) || positionen.length === 0) {
      return res.status(400).json({ fehler: 'Keine Positionen zum Speichern.' });
    }
    // Positionen normalisieren
    const norm = positionen
      .filter(p => p && String(p.profil || '').trim())
      .map((p, i) => ({
        pos: String(p.pos || i + 1),
        menge: Math.max(1, parseInt(p.menge, 10) || 1),
        profil: String(p.profil).trim(),
        laenge: Math.max(0, Math.round(parseFloat(p.laenge) || 0)),
        winkel: String(p.winkel || '').trim(),
        bemerk: String(p.bemerk || '').trim(),
        kg: Math.max(0, Math.round((parseFloat(p.kg) || 0) * 10) / 10)
      }));
    if (norm.length === 0) return res.status(400).json({ fehler: 'Keine gültigen Positionen.' });

    const sl = parseInt(stangenlaenge, 10) || 6000;
    const sg = parseInt(saege, 10) || 3;
    const qu = (quelle === 'bild') ? 'bild' : 'datei';
    const json = JSON.stringify(norm);
    const userId = req.user && req.user.id ? req.user.id : null;
    const userName = req.user && req.user.username ? req.user.username : '';
    const pid = parseInt(project_id, 10) || null;

    const existingId = parseInt(id, 10) || 0;
    if (existingId > 0) {
      const check = await dbQuery('SELECT id FROM schnittlisten WHERE id = ?', [existingId]);
      if (!check.rows || check.rows.length === 0) {
        return res.status(404).json({ fehler: 'Eintrag zum Überschreiben nicht gefunden.' });
      }
      await dbQuery(
        `UPDATE schnittlisten SET name = ?, stangenlaenge = ?, saege = ?, positionen_json = ?,
         quelle = ?, project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [cleanName, sl, sg, json, qu, pid, existingId]
      );
      return res.json({ ok: true, id: existingId, name: cleanName, anzahl: norm.length, project_id: pid });
    }

    const ins = await dbQuery(
      `INSERT INTO schnittlisten (name, stangenlaenge, saege, positionen_json, quelle, created_by, created_by_name, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanName, sl, sg, json, qu, userId, userName, pid]
    );
    res.json({ ok: true, id: ins.lastID, name: cleanName, anzahl: norm.length, project_id: pid });
  } catch (err) {
    console.error('Schnittliste save:', err.message);
    res.status(500).json({ fehler: 'Speichern fehlgeschlagen: ' + err.message });
  }
});

// DELETE /schnittliste/api/:id
router.delete('/api/:id', requireSchnittliste, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ fehler: 'Ungültige ID.' });
    await dbQuery('DELETE FROM schnittlisten WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Schnittliste delete:', err.message);
    res.status(500).json({ fehler: 'Löschen fehlgeschlagen: ' + err.message });
  }
});

// ── Reststücke aus Lager (für Optimierung) ───────────────────
router.get('/api/reststuecke', requireSchnittliste, async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT id, material_type, bezeichnung, profil, laenge, menge, einheit, lagerort, notiz
       FROM lager_reststuecke ORDER BY created_at DESC LIMIT 200`
    );
    const rows = (r.rows || []).map(x => ({
      id: x.id,
      material_type: x.material_type,
      bezeichnung: x.bezeichnung,
      profil: x.profil || x.bezeichnung,
      laenge: parseLaengeMm(x.laenge),
      laenge_raw: x.laenge,
      menge: x.menge,
      lagerort: x.lagerort,
      notiz: x.notiz
    }));
    res.json({ ok: true, reststuecke: rows });
  } catch (err) {
    console.error('reststuecke list:', err.message);
    res.status(500).json({ ok: false, fehler: err.message });
  }
});

// Reststücke aus Optimierung ins Lager speichern
router.post('/api/reststuecke/save', requireSchnittliste, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ fehler: 'Keine Reststücke.' });
    let n = 0;
    for (const it of items) {
      const profil = String(it.profil || '').trim();
      const laenge = parseLaengeMm(it.laenge);
      if (!profil || laenge < 50) continue;
      await dbQuery(
        `INSERT INTO lager_reststuecke
           (material_type, bezeichnung, profil, laenge, menge, einheit, lagerort, notiz)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          it.material_type || 'baustahl',
          profil + ' Rest ' + laenge + ' mm',
          profil,
          String(laenge),
          1,
          'Stk',
          it.lagerort || null,
          it.notiz || ('Aus Schnittliste' + (it.vonRest ? ' (Nachschnitt)' : ''))
        ]
      );
      n++;
    }
    // Verwendete Reststücke aus Lager entfernen (verbraucht)
    const usedIds = Array.isArray(req.body.used_ids)
      ? req.body.used_ids.map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0)
      : [];
    for (const id of usedIds) {
      try { await dbQuery('DELETE FROM lager_reststuecke WHERE id = ?', [id]); } catch (_) {}
    }
    res.json({ ok: true, gespeichert: n, verbraucht: usedIds.length });
  } catch (err) {
    console.error('reststuecke save:', err.message);
    res.status(500).json({ fehler: err.message });
  }
});

// Neu optimieren inkl. optionaler Reststücke
router.post('/api/optimieren', requireSchnittliste, async (req, res) => {
  try {
    const positionen = Array.isArray(req.body.positionen) ? req.body.positionen : [];
    const stangenlaenge = parseInt(req.body.stangenlaenge || '6000', 10) || 6000;
    const saege = parseSaege(req.body);
    let reste = Array.isArray(req.body.reststuecke) ? req.body.reststuecke : null;
    if (!reste) {
      try {
        const r = await dbQuery(`SELECT id, bezeichnung, profil, laenge FROM lager_reststuecke`);
        reste = (r.rows || []).map(x => ({
          id: x.id, profil: x.profil || x.bezeichnung, laenge: parseLaengeMm(x.laenge)
        }));
      } catch (_) { reste = []; }
    }
    const gruppen = optimiere(positionen, stangenlaenge, saege, reste);
    const bedarf = materialbedarf(positionen, gruppen, stangenlaenge);
    res.json({
      ok: true,
      positionen,
      gruppen,
      stangenlaenge,
      saege,
      materialbedarf: bedarf,
      verwendeteReste: gruppen.verwendeteReste || []
    });
  } catch (err) {
    console.error('optimieren:', err.message);
    res.status(500).json({ fehler: err.message });
  }
});

// PDF Materialbedarf / Bestellliste
router.post('/pdf/bestellliste', requireSchnittliste, upload.single('datei'), (req, res) => {
  try {
    let positionen = [];
    if (req.file) {
      positionen = /\.xlsx$/i.test(req.file.originalname)
        ? parseXlsx(req.file.buffer) : parseCsv(req.file.buffer);
    } else if (req.body.positionen_json) {
      positionen = JSON.parse(req.body.positionen_json);
    }
    const stangenlaenge = parseInt(req.body.stangenlaenge || '6000', 10) || 6000;
    const saege = parseSaege(req.body);
    const gruppen = optimiere(positionen, stangenlaenge, saege);
    const bedarf = materialbedarf(positionen, gruppen, stangenlaenge);
    const firmaName = req.body.firma_name || '';
    const projectTitle = (req.body.project_name || '').trim();
    const dateiname = 'Bestellliste_' + new Date().toISOString().slice(0, 10) + '.pdf';
    erzeugeBestellPdf(res, dateiname, bedarf, firmaName, projectTitle);
  } catch (err) {
    console.error('bestellliste pdf:', err.message);
    res.status(500).json({ fehler: err.message });
  }
});

// PDF Angebot
router.post('/pdf/angebot', requireSchnittliste, upload.single('datei'), async (req, res) => {
  try {
    let positionen = [];
    if (req.file) {
      positionen = /\.xlsx$/i.test(req.file.originalname)
        ? parseXlsx(req.file.buffer) : parseCsv(req.file.buffer);
    } else if (req.body.positionen_json) {
      positionen = JSON.parse(req.body.positionen_json);
    }
    const firmaName = req.body.firma_name || '';
    const projectTitle = (req.body.project_name || '').trim();
    let stahlPreis = parseFloat(String(req.body.stahl_preis || '').replace(',', '.')) || 0;
    if (!stahlPreis) {
      try {
        const sp = await dbQuery(
          `SELECT preis_100kg FROM steel_prices ORDER BY gueltig_am DESC, id DESC LIMIT 1`
        );
        if (sp.rows && sp.rows[0]) stahlPreis = Number(sp.rows[0].preis_100kg) || 0;
      } catch (_) {}
    }
    const opts = {
      stahlPreis,
      stunden: parseFloat(String(req.body.stunden || '0').replace(',', '.')) || 0,
      stundensatz: parseFloat(String(req.body.stundensatz || '65').replace(',', '.')) || 65,
      mwst: parseFloat(String(req.body.mwst || '19').replace(',', '.')) || 19
    };
    const dateiname = 'Angebot_Schnittliste_' + new Date().toISOString().slice(0, 10) + '.pdf';
    erzeugeAngebotPdf(res, dateiname, positionen, firmaName, projectTitle, opts);
  } catch (err) {
    console.error('angebot pdf:', err.message);
    res.status(500).json({ fehler: err.message });
  }
});

module.exports = router;
