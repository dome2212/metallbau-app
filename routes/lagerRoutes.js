const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const { dbQuery } = require('../utils/db');
// Bild im Speicher halten (für KI-Vision-Analyse)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilddateien erlaubt.'));
  }
});

// Kostenlose Vision-Modelle (Fallback-Kette)
const VISION_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'meta-llama/llama-4-scout:free'
];

async function callVision(apiKey, systemPrompt, b64, mimeType) {
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
          temperature: 0.2
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

// ==========================================
// LAGERLISTE ANZEIGEN
// ==========================================
router.get('/', async (req, res) => {
  try {
    const tab = req.query.tab === 'edelstahl' ? 'edelstahl' : 'baustahl';
    const result = await dbQuery(
      `SELECT * FROM lager_items WHERE material_type = ? ORDER BY lieferdatum DESC, id DESC`,
      [tab]
    );
    res.render('lager', { items: result.rows || [], tab });
  } catch (err) {
    console.error('Lagerliste Fehler:', err);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// EINTRAG MANUELL HINZUFÜGEN
// ==========================================
router.post('/add', async (req, res) => {
  const { material_type, bezeichnung, profil, abmessung, menge, einheit, lieferschein_nr, lieferdatum, notiz } = req.body;
  try {
    await dbQuery(
      `INSERT INTO lager_items (material_type, bezeichnung, profil, abmessung, menge, einheit, lieferschein_nr, lieferdatum, notiz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [material_type || 'baustahl', bezeichnung, profil || null, abmessung || null,
       parseFloat(String(menge).replace(',', '.')) || 0, einheit || 'Stk',
       lieferschein_nr || null, lieferdatum || null, notiz || null]
    );
    res.redirect('/lager?tab=' + (material_type === 'edelstahl' ? 'edelstahl' : 'baustahl'));
  } catch (err) {
    console.error('Lager-Add Fehler:', err);
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// EINTRAG BEARBEITEN
// ==========================================
router.post('/edit', async (req, res) => {
  const { id, material_type, bezeichnung, profil, abmessung, menge, einheit, lieferschein_nr, lieferdatum, notiz } = req.body;
  try {
    await dbQuery(
      `UPDATE lager_items SET material_type=?, bezeichnung=?, profil=?, abmessung=?, menge=?, einheit=?, lieferschein_nr=?, lieferdatum=?, notiz=? WHERE id=?`,
      [material_type || 'baustahl', bezeichnung, profil || null, abmessung || null,
       parseFloat(String(menge).replace(',', '.')) || 0, einheit || 'Stk',
       lieferschein_nr || null, lieferdatum || null, notiz || null, id]
    );
    res.redirect('/lager?tab=' + (material_type === 'edelstahl' ? 'edelstahl' : 'baustahl'));
  } catch (err) {
    console.error('Lager-Edit Fehler:', err);
    res.status(500).send('Fehler beim Aktualisieren');
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
// KI-VISION: LIEFERSCHEIN FOTOGRAFIEREN
// ==========================================
router.post('/scan', upload.single('image'), async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY)
    return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  if (!req.file)
    return res.status(400).json({ error: 'Kein Bild übermittelt.' });

  const apiKey   = process.env.OPENROUTER_API_KEY;
  const b64      = req.file.buffer.toString('base64');
  const mimeType = req.file.mimetype;

  const systemPrompt = `Du bist ein Assistent für einen deutschen Metallbaubetrieb.
Analysiere diesen Lieferschein und extrahiere ALLE Materialpositionen.
Antworte NUR mit einem JSON-Array. Kein Text davor oder danach.
Format:
[
  {
    "bezeichnung": "Flachstahl",
    "profil": "40x5",
    "abmessung": "6000mm",
    "menge": 10,
    "einheit": "Stk",
    "lieferschein_nr": "LS-12345",
    "lieferdatum": "2024-01-15",
    "material_type": "baustahl"
  }
]
material_type: "baustahl" für normalen Stahl/Eisen, "edelstahl" für Edelstahl/VA/V2A/V4A/1.4301 etc.
lieferdatum im Format YYYY-MM-DD, wenn erkennbar, sonst null.
lieferschein_nr: Lieferscheinnummer falls erkennbar, sonst null.
Wenn kein Lieferschein zu sehen ist, gib [] zurück.`;

  try {
    const reply = await callVision(apiKey, systemPrompt, b64, mimeType);
    // JSON aus der Antwort extrahieren
    const match = reply.match(/\[[\s\S]*\]/);
    if (!match) return res.json({ items: [], raw: reply });
    const items = JSON.parse(match[0]);
    res.json({ items });
  } catch (err) {
    console.error('Lager-Scan Fehler:', err);
    res.status(500).json({ error: 'KI-Analyse fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

// ==========================================
// KI-ERGEBNIS SPEICHERN (mehrere Positionen)
// ==========================================
router.post('/scan-save', async (req, res) => {
  const tab = req.body.tab || 'baustahl';
  try {
    const raw = req.body.items;
    const items = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const item of items) {
      await dbQuery(
        `INSERT INTO lager_items (material_type, bezeichnung, profil, abmessung, menge, einheit, lieferschein_nr, lieferdatum, notiz)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.material_type || tab, item.bezeichnung || 'Unbekannt',
         item.profil || null, item.abmessung || null,
         parseFloat(item.menge) || 0, item.einheit || 'Stk',
         item.lieferschein_nr || null, item.lieferdatum || null, item.notiz || null]
      );
    }
    res.redirect('/lager?tab=' + tab);
  } catch (err) {
    console.error('Scan-Save Fehler:', err);
    res.status(500).send('Fehler beim Speichern: ' + err.message);
  }
});

module.exports = router;
