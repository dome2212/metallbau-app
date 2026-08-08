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
    const tab = req.query.tab === 'edelstahl' ? 'edelstahl'
              : req.query.tab === 'schrauben' ? 'schrauben'
              : req.query.tab === 'entnahmen' ? 'entnahmen'
              : req.query.tab === 'reste'     ? 'reste'
              : 'baustahl';

    let items = [], entnahmen = [], reste = [], projects = [];

    if (tab === 'entnahmen') {
      const r = await dbQuery(
        `SELECT le.*, li.bezeichnung as mat_bezeichnung, li.profil as mat_profil,
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
      items = r.rows || [];
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
      scanBs: parseInt(req.query.scan_bs) || 0,
      scanEs: parseInt(req.query.scan_es) || 0
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
          lieferschein_nr, lieferdatum, notiz, mindestbestand, lagerort } = req.body;
  try {
    await dbQuery(
      `INSERT INTO lager_items
         (material_type, bezeichnung, profil, abmessung, menge, einheit,
          lieferschein_nr, lieferdatum, notiz, mindestbestand, lagerort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [material_type || 'baustahl', bezeichnung, profil || null, abmessung || null,
       parseFloat(String(menge).replace(',', '.')) || 0, einheit || 'Stk',
       lieferschein_nr || null, lieferdatum || null, notiz || null,
       parseFloat(String(mindestbestand || '0').replace(',', '.')) || 0,
       lagerort || null]
    );
    const validTabs = ['baustahl','edelstahl','schrauben'];
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
          lieferschein_nr, lieferdatum, notiz, mindestbestand, lagerort } = req.body;
  try {
    await dbQuery(
      `UPDATE lager_items
         SET material_type=?, bezeichnung=?, profil=?, abmessung=?, menge=?, einheit=?,
             lieferschein_nr=?, lieferdatum=?, notiz=?, mindestbestand=?, lagerort=?
       WHERE id=?`,
      [material_type || 'baustahl', bezeichnung, profil || null, abmessung || null,
       parseFloat(String(menge).replace(',', '.')) || 0, einheit || 'Stk',
       lieferschein_nr || null, lieferdatum || null, notiz || null,
       parseFloat(String(mindestbestand || '0').replace(',', '.')) || 0,
       lagerort || null, id]
    );
    const validTabs = ['baustahl','edelstahl','schrauben'];
    const redirectTab = validTabs.includes(material_type) ? material_type : 'baustahl';
    res.redirect('/lager?tab=' + redirectTab);
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
  const fallbackTab = req.body.tab || 'baustahl';
  try {
    const raw = req.body.items;
    const items = typeof raw === 'string' ? JSON.parse(raw) : raw;

    let anzahlBaustahl = 0;
    let anzahlEdelstahl = 0;

    for (const item of items) {
      // material_type aus dem KI-Ergebnis verwenden; Fallback auf aktuellen Tab
      const matType = (item.material_type === 'edelstahl') ? 'edelstahl' : 'baustahl';
      if (matType === 'edelstahl') anzahlEdelstahl++; else anzahlBaustahl++;

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

    // Auf den Tab mit den meisten Positionen weiterleiten;
    // bei Gleichstand: Edelstahl bevorzugen (seltener, damit der User es sieht)
    const redirectTab = anzahlEdelstahl > anzahlBaustahl ? 'edelstahl' : 'baustahl';
    res.redirect('/lager?tab=' + redirectTab + '&scan_bs=' + anzahlBaustahl + '&scan_es=' + anzahlEdelstahl);
  } catch (err) {
    console.error('Scan-Save Fehler:', err);
    res.status(500).send('Fehler beim Speichern: ' + err.message);
  }
});

module.exports = router;
