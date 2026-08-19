// KI-Angebot: Route zum Generieren und Speichern
// Fügt zwei Endpunkte hinzu: POST /projects/:id/generate-quote und POST /projects/:id/save-generated-quote

const express = require('express');
const router = express.Router();
const db = require('../config/database');

// Prüfe, ob genaiClient global existiert (wird in server.js initialisiert)
let genaiClient;
try { genaiClient = require('../server').genaiClient; } catch (e) { genaiClient = null; }

// Helper: dbQuery wie in projectRoutes.js verwenden
const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    db.query(pgSql, params, (err, res) => {
      if (err) return reject(err);
      resolve({ rows: res.rows || [] });
    });
  });
};

// Generierung per AI
router.post('/:id/generate-quote', async (req, res) => {
  const projectId = req.params.id;
  try {
    const projRes = await dbQuery(`SELECT projects.*, customers.company_name, customers.contact_person FROM projects LEFT JOIN customers ON projects.customer_id = customers.id WHERE projects.id = ?`, [projectId]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });

    const measurementsRes = await dbQuery('SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at ASC', [projectId]);
    const notesRes = await dbQuery('SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC', [projectId]);

    const measurementsList = (measurementsRes.rows || []).map(m => {
      const parts = [];
      if (m.component_name) parts.push(m.component_name);
      if (m.width) parts.push(`B: ${m.width}`);
      if (m.height) parts.push(`H: ${m.height}`);
      if (m.quantity) parts.push(`Anz.: ${m.quantity}`);
      if (m.note) parts.push(`(${m.note})`);
      return '- ' + parts.join(' · ');
    }).join('\n') || '- keine Aufmaße -';

    const notesList = (notesRes.rows || []).map(n => '- ' + (n.note_text || '')).join('\n') || '- keine Notizen -';

    if (!genaiClient) return res.status(500).json({ error: 'KI-Client nicht konfiguriert' });

    const prompt = `Du bist ein professioneller Angebots-Generator für einen deutschen Metallbaubetrieb. Erstelle ein formelles Angebot (Deutsch) für das Projekt:\n\nFirma: ${project.company_name || '–'}\nProjekt: ${project.title}\n\nAufmaße:\n${measurementsList}\n\nNotizen:\n${notesList}\n\nGebe das Angebot als gut strukturierten Fließtext zurück.`;

    const aiResponse = await genaiClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ type: 'text', text: prompt }],
      temperature: 0.2,
      maxOutputTokens: 800
    });

    let generated = '';
    try {
      if (aiResponse?.results && Array.isArray(aiResponse.results) && aiResponse.results[0]) {
        const r = aiResponse.results[0];
        if (r?.content && Array.isArray(r.content)) {
          const textBlock = r.content.find(c => c.type && c.type.includes('text')) || r.content[0];
          generated = textBlock?.text || textBlock?.contents || '';
        } else if (r?.text) {
          generated = r.text;
        } else {
          generated = JSON.stringify(r);
        }
      } else if (aiResponse?.outputText) {
        generated = aiResponse.outputText;
      } else if (aiResponse?.candidates && aiResponse.candidates[0]) {
        generated = aiResponse.candidates[0].content || aiResponse.candidates[0].output || '';
      } else {
        generated = JSON.stringify(aiResponse);
      }
    } catch (e) {
      generated = JSON.stringify(aiResponse);
    }

    if (typeof generated === 'string' && generated.length > 10000) generated = generated.slice(0, 10000) + '\n\n[Ausgabe gekürzt]';

    res.json({ ok: true, text: generated });
  } catch (err) {
    console.error('Fehler beim Generieren des KI-Angebots:', err);
    res.status(500).json({ error: 'Fehler bei der Angebotserstellung' });
  }
});

// Speichern des bearbeiteten Angebots
router.post('/:id/save-generated-quote', async (req, res) => {
  const projectId = req.params.id;
  const quoteText = (req.body.quote_text || '').trim();
  if (!quoteText) return res.redirect(`/projects/${projectId}`);
  try {
    await dbQuery('INSERT INTO project_notes (project_id, note_text) VALUES (?, ?)', [projectId, `KI-Angebot:\n\n${quoteText}`]);
    res.redirect(`/projects/${projectId}`);
  } catch (err) {
    console.error('Fehler beim Speichern des KI-Angebots:', err);
    res.status(500).send('Fehler beim Speichern des KI-Angebots');
  }
});

module.exports = router;
