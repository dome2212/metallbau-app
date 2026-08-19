const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const PDFDocument = require('pdfkit');
const { requireAdmin } = require('../middleware/auth');

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
function optimiere(positionen, stangenlaenge) {
  // Alle Einzelstücke auffalten (Menge × Länge)
  const stuecke = [];
  for (const p of positionen) {
    for (let i = 0; i < p.menge; i++) {
      stuecke.push({ pos: p.pos, profil: p.profil, laenge: p.laenge, bemerk: p.bemerk });
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
        if (!stange.uebermas && stange.rest >= teil.laenge) {
          stange.rest  -= teil.laenge;
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

function erzeugePdf(res, dateiname, positionen, gruppen, stangenlaenge, firmaName) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${dateiname}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 45, bufferPages: true });
  doc.pipe(res);

  const W      = doc.page.width - 90;
  const GRAU   = '#6b7280';
  const BLAU   = '#1e40af';
  const HELLBL = '#eff6ff';
  const SCHW   = '#111827';

  // ── Kopf ──────────────────────────────────────────────────
  doc.fontSize(18).fillColor(BLAU).text('Schnittliste', 45, 45, { width: W });
  doc.fontSize(9).fillColor(GRAU)
    .text(`${firmaName || 'Metallbau'}  ·  Stangenlänge: ${stangenlaenge.toLocaleString('de-DE')} mm  ·  Erstellt: ${new Date().toLocaleDateString('de-DE')}`,
      45, 68, { width: W });
  doc.moveTo(45, 82).lineTo(45 + W, 82).lineWidth(1).strokeColor(BLAU).stroke();
  doc.moveDown(1.8);

  // ── Positionstabelle ─────────────────────────────────────
  doc.fontSize(11).fillColor(SCHW).text('Positionen (Eingabe)', { underline: true });
  doc.moveDown(0.4);

  const colPos  = 45,  wPos   = 35;
  const colMng  = 80,  wMng   = 40;
  const colPro  = 120, wPro   = 130;
  const colL    = 250, wL     = 65;
  const colBem  = 315, wBem   = W - (315 - 45);

  // Tabellenkopf
  doc.fontSize(8).fillColor(GRAU);
  doc.text('Pos',     colPos, doc.y, { width: wPos });
  const y0 = doc.y;
  doc.text('Menge',   colMng, y0,    { width: wMng });
  doc.text('Profil',  colPro, y0,    { width: wPro });
  doc.text('Länge mm',colL,   y0,    { width: wL });
  doc.text('Bemerkung',colBem,y0,    { width: wBem });
  doc.moveDown(0.15);
  doc.moveTo(45, doc.y).lineTo(45 + W, doc.y).lineWidth(0.5).strokeColor('#d1d5db').stroke();
  doc.moveDown(0.3);

  doc.fontSize(8.5).fillColor(SCHW);
  for (const p of positionen) {
    const y = doc.y;
    doc.text(String(p.pos),   colPos, y, { width: wPos });
    doc.text(String(p.menge), colMng, y, { width: wMng });
    doc.text(p.profil,        colPro, y, { width: wPro });
    doc.text(p.laenge.toLocaleString('de-DE') + ' mm', colL, y, { width: wL });
    doc.text(p.bemerk || '–', colBem, y, { width: wBem });
    doc.moveDown(0.25);
    if (doc.y > doc.page.height - 100) { doc.addPage(); }
  }

  doc.moveDown(1);

  // ── Optimierungsergebnis pro Profil ───────────────────────
  doc.fontSize(11).fillColor(SCHW).text('Optimierte Schnittaufteilung', { underline: true });

  for (const g of gruppen) {
    doc.moveDown(0.7);
    if (doc.y > doc.page.height - 120) doc.addPage();

    // Profil-Header
    doc.roundedRect(45, doc.y, W, 18, 3).fill(HELLBL);
    doc.fontSize(9.5).fillColor(BLAU)
      .text(`${g.profil}   —   ${g.stangenzahl} Stange(n)   |   Ausnutzung: ${g.ausnutzung} %   |   Verschnitt: ${g.verschnittGes.toLocaleString('de-DE')} mm`,
        50, doc.y - 15, { width: W - 10 });
    doc.moveDown(0.6);

    let stIdx = 0;
    for (const stange of g.stangen) {
      stIdx++;
      if (doc.y > doc.page.height - 80) doc.addPage();
      const label = stange.uebermas ? `Übermaß-Stück` : `Stange ${stIdx}`;
      doc.fontSize(8).fillColor(GRAU).text(label, 50, doc.y, { continued: false });
      doc.moveDown(0.15);

      // Balkengrafik
      const barX = 50, barY = doc.y, barH = 12;
      const barW = W - 10;
      doc.rect(barX, barY, barW, barH).lineWidth(0.5).strokeColor('#9ca3af').stroke();

      let xCur = barX;
      const colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
      let ci = 0;
      for (const t of stange.teile) {
        const tw = stange.uebermas
          ? barW
          : Math.round((t.laenge / stangenlaenge) * barW);
        doc.rect(xCur, barY, tw, barH).fill(colors[ci % colors.length]);
        xCur += tw;
        ci++;
      }
      // Restbalken
      if (!stange.uebermas && stange.rest > 0) {
        const rw = barX + barW - xCur;
        if (rw > 0) doc.rect(xCur, barY, rw, barH).fill('#e5e7eb');
      }
      doc.rect(barX, barY, barW, barH).lineWidth(0.5).strokeColor('#9ca3af').stroke();

      doc.y = barY + barH + 4;
      doc.fontSize(7.5).fillColor(SCHW);
      const stTeileText = stange.teile.map(t => `${t.laenge} mm (Pos ${t.pos})`).join('   ');
      const restText = stange.uebermas ? '' : `   Rest: ${stange.rest.toLocaleString('de-DE')} mm`;
      doc.text(stTeileText + restText, 50, doc.y, { width: W - 10 });
      doc.moveDown(0.5);
    }
  }

  // ── Zusammenfassung ───────────────────────────────────────
  doc.moveDown(0.8);
  if (doc.y > doc.page.height - 80) doc.addPage();
  doc.moveTo(45, doc.y).lineTo(45 + W, doc.y).lineWidth(0.5).strokeColor('#d1d5db').stroke();
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor(SCHW)
    .text(`Gesamt: ${gruppen.reduce((s, g) => s + g.stangenzahl, 0)} Stange(n)  |  ` +
      `Ø Ausnutzung: ${Math.round(gruppen.reduce((s,g)=>s+g.ausnutzung,0)/Math.max(gruppen.length,1))} %  |  ` +
      `Gesamtlänge Teile: ${gruppen.reduce((s,g)=>s+g.gesamtLaenge,0).toLocaleString('de-DE')} mm`);

  doc.end();
}

// ══════════════════════════════════════════════════════════════
//  ROUTEN
// ══════════════════════════════════════════════════════════════

// GET  /schnittliste  – Formular-Seite
router.get('/', requireAdmin, (req, res) => {
  res.render('schnittliste', { currentUser: req.user, fehler: null, ergebnis: null });
});

// POST /schnittliste  – Datei hochladen + Vorschau (JSON)
router.post('/upload', requireAdmin, upload.single('datei'), (req, res) => {
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

    const gruppen = optimiere(positionen, stangenlaenge);
    res.json({ ok: true, positionen, gruppen, stangenlaenge });
  } catch (err) {
    res.status(400).json({ fehler: err.message });
  }
});

// POST /schnittliste/pdf  – PDF herunterladen
router.post('/pdf', requireAdmin, upload.single('datei'), (req, res) => {
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

    const gruppen  = optimiere(positionen, stangenlaenge);
    const dateiname = `Schnittliste_${new Date().toISOString().slice(0,10)}.pdf`;
    erzeugePdf(res, dateiname, positionen, gruppen, stangenlaenge, firmaName);
  } catch (err) {
    res.status(400).send('Fehler: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════
//  VISION-KI-HILFSFUNKTION  (gleiche Infrastruktur wie server.js)
// ══════════════════════════════════════════════════════════════

const VISION_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
];

async function callVisionKI(b64, mimeType) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY nicht konfiguriert.');

  const systemPrompt = `Du bist ein erfahrener Metallbau-Konstrukteur und Experte für technische Zeichnungen.
Du erhältst ein Bild — das kann eine technische Zeichnung, eine Prinzipskizze, ein Katalogblatt oder ein Foto eines Geländers / einer Stahlkonstruktion sein.
Deine Aufgabe: Erkenne ALLE Bauteile, Profile und Materialien und erstelle daraus eine Schnittliste.

WICHTIG — auch bei Prinzipskizzen ohne exakte Maße:
- Wenn "LÄNGE" oder "HÖHE" als Platzhalter steht: trage laenge:0 ein und schreibe den Platzhalter in "bemerk"
- Wenn nur ein Durchmesser oder Profiltyp erkennbar ist (z.B. "Ø33,7mm", "Ø12mm Vollmaterial"): trotzdem als Position aufnehmen
- Jedes erkennbare Bauteil / Material einzeln aufnehmen, auch wenn die genaue Länge fehlt
- Bei fehlender Länge: laenge:0 setzen — der Benutzer trägt sie später ein

Erkennungsquellen (alle auswerten):
- Bauteilbezeichnungen mit Pfeilen / Hinweislinien (z.B. "Wandflansch Ø80mm", "Ø33,7 Füllstab", "Handlauf Ø42,4mm")
- Durchmesser- und Profilangaben (Ø, □, mm-Angaben)
- Mengenangaben aus dem Bild oder aus sichtbaren Wiederholungen
- Materialangaben (z.B. "V2A geschliffen K240", "Edelstahl", "8mm")
- Stücklisten- oder Positionstabellen falls vorhanden
- Bemaßungslinien mit konkreten Zahlenwerten

Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Array ohne jeglichen Erklärungstext.
Format:
[
  {"pos":"1","menge":1,"profil":"Rohr Ø42,4x2,5mm","laenge":0,"bemerk":"Handlauf, Länge nach Maß"},
  {"pos":"2","menge":4,"profil":"Rohr Ø33,7mm","laenge":0,"bemerk":"Vertikal-Füllstab"},
  {"pos":"3","menge":1,"profil":"Wandflansch Ø80mm","laenge":0,"bemerk":"mit Wandanschluss, geschweißt"}
]
Regeln:
- "laenge" als Ganzzahl in mm; 0 wenn keine konkrete Länge erkennbar
- "menge" als Ganzzahl; 1 wenn unklar; bei sichtbaren Wiederholungen (z.B. 7 Füllstäbe) die Anzahl schätzen
- "profil" so präzise wie erkennbar (Durchmesser, Wandstärke, Profiltyp)
- "bemerk" = Bauteilname aus dem Bild + wichtige Hinweise (Material, Oberfläche, Verbindungsart)
- "pos" = fortlaufend nummerieren
- Keine Codeblöcke, kein Markdown, nur reines JSON`;

  let lastError;
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
              { type: 'text', text: systemPrompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
            ]
          }],
          temperature: 0.1
        })
      });
      const data = await response.json();
      if (!response.ok) {
        const code = data?.error?.code;
        if (code === 429 || code === 404 || code === 400) { lastError = data; continue; }
        throw new Error(JSON.stringify(data));
      }
      return data.choices[0].message.content;
    } catch (err) {
      lastError = err;
      if (!err.message?.includes('fetch')) throw err;
    }
  }
  throw new Error('Alle Vision-Modelle nicht verfügbar: ' + JSON.stringify(lastError));
}

// POST /schnittliste/bild  – Bild analysieren → Positionen zurückgeben
router.post('/bild', requireAdmin, bildUpload.single('bild'), async (req, res) => {
  if (!req.file) return res.status(400).json({ fehler: 'Kein Bild hochgeladen.' });
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ fehler: 'KI-Analyse nicht konfiguriert (OPENROUTER_API_KEY fehlt).' });
  }

  try {
    const b64      = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const rawText  = await callVisionKI(b64, mimeType);

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
        bemerk: String(p.bemerk || '').trim()
      }));

    if (positionen.length === 0) {
      return res.status(422).json({
        fehler: 'Keine Bauteile erkannt. Bitte prüfe ob das Bild eine technische Zeichnung oder Skizze mit Profilbezeichnungen enthält.',
        rohAntwort: rawText.slice(0, 500)
      });
    }

    const stangenlaenge = parseInt(req.body.stangenlaenge || '6000', 10) || 6000;
    const gruppen       = optimiere(positionen, stangenlaenge);

    res.json({ ok: true, positionen, gruppen, stangenlaenge });
  } catch (err) {
    console.error('Schnittliste Bild-KI Fehler:', err.message);
    res.status(500).json({ fehler: 'KI-Analyse fehlgeschlagen: ' + err.message });
  }
});

module.exports = router;
