const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const { dbQuery } = require('../utils/db');
const { getFirma } = require('../utils/companySettings');

// Bild im Speicher halten (für KI-Vision-Analyse)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilddateien erlaubt.'));
  }
});

// Groq Vision-Modelle (Lieferschein-Scan)
const GROQ_VISION_MODELS = [
  'llama-4-scout-17b-16e-instruct',
];

// Gemini-Fallback für Vision (probiert mehrere Modelle durch)
const GEMINI_VISION_MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
];
async function callGeminiVision(systemPrompt, b64, mimeType) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY nicht konfiguriert.');
  let lastErr;
  for (const model of GEMINI_VISION_MODELS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: systemPrompt },
                { inline_data: { mime_type: mimeType, data: b64 } }
              ]
            }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
          })
        }
      );
      const data = await response.json();
      if (!response.ok) { lastErr = data; continue; }
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) { lastErr = err; }
  }
  throw new Error('Alle Gemini-Modelle nicht verfügbar: ' + JSON.stringify(lastErr));
}

// OpenRouter-Fallback für Vision
const OPENROUTER_VISION_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
];
async function callOpenRouterVision(systemPrompt, b64, mimeType) {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error('OPENROUTER_API_KEY nicht konfiguriert.');
  let lastErr;
  for (const model of OPENROUTER_VISION_MODELS) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orKey}`,
          'HTTP-Referer': process.env.APP_URL || 'https://localhost',
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
          temperature: 0.2,
          max_tokens: 4096
        })
      });
      const data = await response.json();
      if (!response.ok) { lastErr = data; continue; }
      return data?.choices?.[0]?.message?.content || '';
    } catch (err) { lastErr = err; }
  }
  throw new Error('Alle OpenRouter-Modelle nicht verfügbar: ' + JSON.stringify(lastErr));
}

async function callVision(apiKey, systemPrompt, b64, mimeType) {
  let lastError;
  for (const model of GROQ_VISION_MODELS) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
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
          temperature: 0.2,
          max_tokens: 4096
        })
      });
      const data = await response.json();
      if (!response.ok) {
        const code = data?.error?.code || response.status;
        if (code === 429 || code === 404 || code === 400) { lastError = data; continue; }
        throw new Error(JSON.stringify(data));
      }
      return data?.choices?.[0]?.message?.content || '';
    } catch (err) {
      lastError = err;
    }
  }
  // Groq fehlgeschlagen → Gemini als Fallback
  if (process.env.GEMINI_API_KEY) {
    try { return await callGeminiVision(systemPrompt, b64, mimeType); } catch (err) { lastError = err; }
  }
  // Gemini fehlgeschlagen → OpenRouter als letzter Fallback
  if (process.env.OPENROUTER_API_KEY) {
    return await callOpenRouterVision(systemPrompt, b64, mimeType);
  }
  throw new Error('Alle Vision-Modelle nicht verfügbar: ' + JSON.stringify(lastError));
}

// Bereinigt Felder, die versehentlich als JSON-Array gespeichert wurden
// z.B. '{"M10×40","M10×40"}' → 'M10×40'
function fixArrayFields(item) {
  ['profil', 'abmessung'].forEach(key => {
    const v = item[key];
    if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
      try {
        // PostgreSQL-Array-Syntax: {"wert1","wert2"} → ersten Wert nehmen
        const first = v.slice(1, -1).split(',')[0].replace(/^"|"$/g, '');
        item[key] = first || null;
      } catch (e) { /* unveränderter Wert */ }
    }
  });
  return item;
}

// ==========================================
// LAGERLISTE ANZEIGEN
// ==========================================
router.get('/', async (req, res) => {
  try {
    // Custom-Tabs aus Firmeneinstellungen laden
    const firma = await getFirma();
    let customTabs = [];
    try { customTabs = JSON.parse(firma.lager_custom_tabs || '[]'); } catch(e) {}
    const customTabKeys = customTabs.map(t => t.key);

    const requestedTab = req.query.tab || 'baustahl';
    const tab = ['edelstahl','schrauben','entnahmen','reste', ...customTabKeys].includes(requestedTab)
              ? requestedTab
              : 'baustahl';

    let items = [], entnahmen = [], reste = [], projects = [];

    if (tab === 'entnahmen') {
      const r = await dbQuery(
        `SELECT le.id, le.lager_item_id, le.project_id, le.user_id,
                le.menge, le.einheit, le.notiz, le.created_at,
                le.einheitspreis, le.gesamtpreis,
                li.bezeichnung as mat_bezeichnung, li.profil as mat_profil,
                li.einheit as mat_einheit, p.title as project_title, u.username
         FROM lager_entnahmen le
         LEFT JOIN lager_items li ON le.lager_item_id = li.id
         LEFT JOIN projects    p  ON le.project_id    = p.id
         LEFT JOIN users       u  ON le.user_id       = u.id
         ORDER BY le.created_at DESC LIMIT 200`
      );
      entnahmen = r.rows || [];
    } else if (tab === 'reste') {
      const r = await dbQuery(
        `SELECT * FROM lager_reststuecke ORDER BY created_at DESC`
      );
      reste = r.rows || [];
    } else {
      // baustahl, edelstahl, schrauben – alle aus lager_items mit material_type-Filter
      const r = await dbQuery(
        `SELECT * FROM lager_items WHERE material_type = ? ORDER BY bezeichnung ASC, id DESC`,
        [tab]
      );
      items = (r.rows || []).map(fixArrayFields);
    }

    // Projekte für Entnahme-Dropdown immer laden
    const pRes = await dbQuery(
      `SELECT id, title FROM projects WHERE status != 'Abgeschlossen' ORDER BY title ASC`
    );
    projects = pRes.rows || [];

    // Alle lager_items für Entnahme-Dropdown (unabhängig von Tab)
    const allItemsRes = await dbQuery(
      `SELECT id, bezeichnung, profil, menge, einheit, material_type FROM lager_items ORDER BY bezeichnung ASC`
    );

    res.render('lager', {
      items, entnahmen, reste, tab, projects,
      allItems: allItemsRes.rows || [],
      customTabs,
      scanBs: parseInt(req.query.scan_bs) || 0,
      scanEs: parseInt(req.query.scan_es) || 0,
      moved:  req.query.moved === '1'
    });
  } catch (err) {
    console.error('Lagerliste Fehler:', err);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// EINTRAG MANUELL HINZUFÜGEN
// ==========================================
router.post('/add', async (req, res) => {
  const { material_type, bezeichnung, profil, abmessung, menge, einheit,
          lieferschein_nr, lieferdatum, notiz, mindestbestand, lagerort, einheitspreis } = req.body;
  try {
    await dbQuery(
      `INSERT INTO lager_items
         (material_type, bezeichnung, profil, abmessung, menge, einheit,
          lieferschein_nr, lieferdatum, notiz, mindestbestand, lagerort, einheitspreis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [material_type || 'baustahl', bezeichnung, profil || null, abmessung || null,
       parseFloat(String(menge).replace(',', '.')) || 0, einheit || 'Stk',
       lieferschein_nr || null, lieferdatum || null, notiz || null,
       parseFloat(String(mindestbestand || '0').replace(',', '.')) || 0,
       lagerort || null,
       parseFloat(String(einheitspreis || '0').replace(',', '.')) || 0]
    );
    const firma2 = await getFirma();
    const customKeys = JSON.parse(firma2.lager_custom_tabs || '[]').map(t => t.key);
    const validTabs = ['baustahl','edelstahl','schrauben', ...customKeys];
    const redirectTab = validTabs.includes(material_type) ? material_type : 'baustahl';
    res.redirect('/lager?tab=' + redirectTab);
  } catch (err) {
    console.error('Lager-Add Fehler:', err);
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// EINTRAG BEARBEITEN
// ==========================================
router.post('/edit', async (req, res) => {
  const { id, material_type, bezeichnung, profil, abmessung, menge, einheit,
          lieferschein_nr, lieferdatum, notiz, mindestbestand, lagerort, einheitspreis } = req.body;
  try {
    await dbQuery(
      `UPDATE lager_items
         SET material_type=?, bezeichnung=?, profil=?, abmessung=?, menge=?, einheit=?,
             lieferschein_nr=?, lieferdatum=?, notiz=?, mindestbestand=?, lagerort=?, einheitspreis=?
       WHERE id=?`,
      [material_type || 'baustahl', bezeichnung, profil || null, abmessung || null,
       parseFloat(String(menge).replace(',', '.')) || 0, einheit || 'Stk',
       lieferschein_nr || null, lieferdatum || null, notiz || null,
       parseFloat(String(mindestbestand || '0').replace(',', '.')) || 0,
       lagerort || null,
       parseFloat(String(einheitspreis || '0').replace(',', '.')) || 0,
       id]
    );
    const firma2 = await getFirma();
    const customKeys = JSON.parse(firma2.lager_custom_tabs || '[]').map(t => t.key);
    const validTabs = ['baustahl','edelstahl','schrauben', ...customKeys];
    const redirectTab = validTabs.includes(material_type) ? material_type : 'baustahl';
    res.redirect('/lager?tab=' + redirectTab);
  } catch (err) {
    console.error('Lager-Edit Fehler:', err);
    res.status(500).send('Fehler beim Aktualisieren');
  }
});

// ==========================================
// EINTRAG VERSCHIEBEN (material_type ändern)
// ==========================================
router.post('/move', async (req, res) => {
  const { id, new_type, from_tab } = req.body;
  const firma2 = await getFirma();
  const customKeys2 = JSON.parse(firma2.lager_custom_tabs || '[]').map(t => t.key);
  const validTypes = ['baustahl', 'edelstahl', 'schrauben', ...customKeys2];
  if (!validTypes.includes(new_type)) return res.status(400).send('Ungültiger Typ.');
  try {
    await dbQuery('UPDATE lager_items SET material_type = ? WHERE id = ?', [new_type, id]);
    res.redirect('/lager?tab=' + new_type + '&moved=1');
  } catch (err) {
    console.error('Lager-Move Fehler:', err);
    res.status(500).send('Fehler beim Verschieben');
  }
});

// ==========================================
// EINTRAG LÖSCHEN
// ==========================================
router.post('/delete', async (req, res) => {
  const { id, tab } = req.body;
  try {
    await dbQuery('DELETE FROM lager_items WHERE id = ?', [id]);
    res.redirect('/lager?tab=' + (tab || 'baustahl'));
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// MATERIALENTNAHME BUCHEN
// ==========================================
router.post('/entnahme', async (req, res) => {
  const { lager_item_id, project_id, menge, notiz } = req.body;
  const userId = req.user?.id;
  try {
    const itemRes = await dbQuery('SELECT * FROM lager_items WHERE id = ?', [lager_item_id]);
    const item = itemRes.rows[0];
    if (!item) return res.status(404).send('Lagereintrag nicht gefunden');

    const entnahmeMenge = parseFloat(String(menge).replace(',', '.')) || 0;
    if (entnahmeMenge <= 0) return res.redirect('/lager?tab=entnahmen');

    // Entnahme protokollieren
    await dbQuery(
      `INSERT INTO lager_entnahmen (lager_item_id, project_id, user_id, menge, einheit, notiz)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [lager_item_id, project_id || null, userId || null,
       entnahmeMenge, item.einheit || 'Stk', notiz || null]
    );

    // Bestand reduzieren
    const neuerBestand = Math.max(0, parseFloat(item.menge || 0) - entnahmeMenge);
    await dbQuery('UPDATE lager_items SET menge = ? WHERE id = ?', [neuerBestand, lager_item_id]);

    res.redirect('/lager?tab=entnahmen');
  } catch (err) {
    console.error('Entnahme Fehler:', err);
    res.status(500).send('Fehler beim Buchen: ' + err.message);
  }
});

// Entnahme löschen (und Bestand zurückbuchen)
router.post('/entnahme/delete', async (req, res) => {
  const { id } = req.body;
  try {
    const r = await dbQuery('SELECT * FROM lager_entnahmen WHERE id = ?', [id]);
    const e = r.rows[0];
    if (e) {
      // Bestand wiederherstellen
      await dbQuery(
        'UPDATE lager_items SET menge = menge + ? WHERE id = ?',
        [e.menge, e.lager_item_id]
      );
      await dbQuery('DELETE FROM lager_entnahmen WHERE id = ?', [id]);
    }
    res.redirect('/lager?tab=entnahmen');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// RESTSTÜCKE
// ==========================================
router.post('/rest/add', async (req, res) => {
  const { material_type, bezeichnung, profil, laenge, menge, einheit, lagerort, notiz } = req.body;
  try {
    await dbQuery(
      `INSERT INTO lager_reststuecke
         (material_type, bezeichnung, profil, laenge, menge, einheit, lagerort, notiz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [material_type || 'baustahl', bezeichnung, profil || null, laenge || null,
       parseFloat(String(menge || '1').replace(',', '.')) || 1,
       einheit || 'Stk', lagerort || null, notiz || null]
    );
    res.redirect('/lager?tab=reste');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern');
  }
});

router.post('/rest/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM lager_reststuecke WHERE id = ?', [id]);
    res.redirect('/lager?tab=reste');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// API: KNAPPER BESTAND (für Dashboard)
// ==========================================
router.get('/api/low-stock', async (req, res) => {
  try {
    const result = await dbQuery(
      `SELECT id, material_type, bezeichnung, profil, menge, einheit, mindestbestand
       FROM lager_items
       WHERE mindestbestand > 0 AND menge <= mindestbestand
       ORDER BY (mindestbestand - menge) DESC`
    );
    res.json({ items: result.rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// KI-VISION: LIEFERSCHEIN FOTOGRAFIEREN
// ==========================================
router.post('/scan', upload.single('image'), async (req, res) => {
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY)
    return res.status(500).json({ error: 'Kein KI-API-Key konfiguriert.' });
  if (!req.file)
    return res.status(400).json({ error: 'Kein Bild übermittelt.' });

  const apiKey   = process.env.GROQ_API_KEY;
  const b64      = req.file.buffer.toString('base64');
  const mimeType = req.file.mimetype;

  const systemPrompt = `Du bist ein Assistent für einen deutschen Metallbaubetrieb.
Analysiere diesen Lieferschein und extrahiere ALLE Materialpositionen.

WICHTIG: Antworte AUSSCHLIESSLICH mit einem JSON-Array. Absolut kein Text, keine Erklärung, kein Markdown, keine Codeblöcke davor oder danach. Nur das reine JSON-Array.

Beispiel-Ausgabe:
[{"bezeichnung":"Flachstahl","profil":"40x5","abmessung":"6000mm","menge":10,"einheit":"Stk","lieferschein_nr":"LS-12345","lieferdatum":"2024-01-15","material_type":"baustahl"}]

Regeln:
- material_type: "baustahl" für Stahl/Eisen/HEA/IPE/RHS/CHS, "edelstahl" für Edelstahl/VA/V2A/V4A/1.4301/1.4571, "schrauben" für Schrauben/Muttern/Scheiben/Bolzen
- lieferdatum: Format YYYY-MM-DD, sonst null
- lieferschein_nr: Lieferscheinnummer oder Belegnummer, sonst null
- menge: nur die Zahl, keine Einheit
- einheit: "Stk", "m", "kg", "m²" oder "Psch"
- Wenn kein Lieferschein erkennbar: []`;

  try {
    const reply = await callVision(apiKey, systemPrompt, b64, mimeType);
    console.log('[Scan] KI-Rohantwort:', reply.slice(0, 600));

    // Markdown-Code-Blöcke entfernen
    let jsonStr = reply
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    // Erstes '[' suchen
    const start = jsonStr.indexOf('[');
    if (start === -1) {
      console.log('[Scan] Kein JSON-Array gefunden in Antwort:', jsonStr.slice(0, 300));
      return res.json({ items: [], raw: reply });
    }
    jsonStr = jsonStr.slice(start);

    // Schließendes ']' suchen – falls abgeschnitten: Array reparieren
    let end = jsonStr.lastIndexOf(']');
    if (end === -1) {
      // Antwort wurde durch max_tokens abgeschnitten – letztes vollständiges Objekt retten
      const lastClose = jsonStr.lastIndexOf('}');
      if (lastClose === -1) {
        console.log('[Scan] Keine vollständigen Objekte gefunden');
        return res.json({ items: [], raw: reply });
      }
      jsonStr = jsonStr.slice(0, lastClose + 1) + ']';
      console.log('[Scan] Array war abgeschnitten, repariert bis Objekt', lastClose);
    } else {
      jsonStr = jsonStr.slice(0, end + 1);
    }

    let items;
    try {
      items = JSON.parse(jsonStr);
    } catch (e) {
      console.log('[Scan] JSON-Parse-Fehler:', e.message, '| String:', jsonStr.slice(0, 300));
      return res.json({ items: [], raw: reply });
    }
    if (!Array.isArray(items)) items = [items];
    console.log('[Scan] Gefundene Positionen:', items.length);
    res.json({ items, raw: items.length === 0 ? reply : undefined });
  } catch (err) {
    console.error('Lager-Scan Fehler:', err);
    res.status(500).json({ error: 'KI-Analyse fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

// ==========================================
// KI-ERGEBNIS SPEICHERN (mehrere Positionen)
// ==========================================
router.post('/scan-save', async (req, res) => {
  try {
    const raw = req.body.items;
    const items = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Erlaubte material_types: Standardtabs + Custom-Tabs
    const firma = await getFirma();
    const customKeys = JSON.parse(firma.lager_custom_tabs || '[]').map(t => t.key);
    const validTypes = new Set(['baustahl', 'edelstahl', 'schrauben', ...customKeys]);

    // Zähler pro Tab für Weiterleitung
    const tabCount = {};

    for (const item of items) {
      // material_type übernehmen wenn gültig, sonst baustahl
      const matType = validTypes.has(item.material_type) ? item.material_type : 'baustahl';
      tabCount[matType] = (tabCount[matType] || 0) + 1;

      await dbQuery(
        `INSERT INTO lager_items
           (material_type, bezeichnung, profil, abmessung, menge, einheit,
            lieferschein_nr, lieferdatum, notiz)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [matType, item.bezeichnung || 'Unbekannt',
         item.profil || null, item.abmessung || null,
         parseFloat(item.menge) || 0, item.einheit || 'Stk',
         item.lieferschein_nr || null, item.lieferdatum || null, item.notiz || null]
      );
    }

    // Auf den Tab mit den meisten Positionen weiterleiten
    const redirectTab = Object.entries(tabCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'baustahl';
    const anzahlBaustahl  = tabCount['baustahl']  || 0;
    const anzahlEdelstahl = tabCount['edelstahl'] || 0;
    res.redirect('/lager?tab=' + redirectTab + '&scan_bs=' + anzahlBaustahl + '&scan_es=' + anzahlEdelstahl);
  } catch (err) {
    console.error('Scan-Save Fehler:', err);
    res.status(500).send('Fehler beim Speichern: ' + err.message);
  }
});

module.exports = router;
