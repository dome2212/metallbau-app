const express = require('express');
const router = express.Router();
const multer = require('multer');

// KI-API-ROUTEN (global, nicht projektgebunden)
// ==========================================
const imageUploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // max. 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilddateien erlaubt.'));
  }
});

// Groq Text-KI – Fallback-Kette über kostenlose Modelle
const GROQ_TEXT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama3-8b-8192',
  'gemma2-9b-it',
];

async function callAI(prompt, maxTokens = 512) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY nicht konfiguriert.');
  let lastError;
  for (const model of GROQ_TEXT_MODELS) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          max_tokens: maxTokens
        })
      });
      const data = await res.json();
      if (!res.ok) {
        const code = data?.error?.code || res.status;
        if (code === 429 || code === 404 || code === 400) { lastError = data; continue; }
        throw new Error(JSON.stringify(data));
      }
      const content = data?.choices?.[0]?.message?.content;
      if (!content) { lastError = data; continue; }
      return content;
    } catch (err) {
      lastError = err;
      if (!err.message?.includes('fetch')) throw err;
    }
  }
  throw new Error('Alle Groq-Modelle nicht verfügbar: ' + JSON.stringify(lastError));
}

// Reasoning-Tags entfernen die manche Modelle (Nemotron, DeepSeek) vor der Antwort ausgeben
function stripThinking(text) {
  return (text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<\/?thinking>[\s\S]*?<\/?thinking>\s*/gi, '')
    .trim();
}

const { getFirma } = require('./utils/companySettings');

router.post('/offer-assistant', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'Keine Nachricht übermittelt.' });
  const firma = await getFirma();
  const systemPrompt = `Du bist Angebots-Assistent für den Metallbaubetrieb "${firma.name}". Antworte IMMER auf Deutsch. Gib KEINE Erklärungen, kein Denken, keine Kommentare aus.

Antworte NUR in diesem exakten Format:
[Ein Satz Einleitung auf Deutsch.]
POSITIONEN_JSON:
[
  {"title": "Bezeichnung", "quantity": 1, "unit": "Stk", "price": 85},
  {"title": "Bezeichnung 2", "quantity": 2, "unit": "m", "price": 45}
]

Regeln:
- Erlaubte Einheiten: Stk, m, Std, kg, m², Psch
- price = Einzelpreis pro Einheit in EUR (Zahl, kein Text)
- Stundensatz 75–95 €, Materialpreise marktüblich Deutschland
- Bei Unsicherheit price: 0
- Kein <think>, kein Fließtext, keine Erklärung – NUR das Format oben`;
  try {
    const text = stripThinking(await callAI(`${systemPrompt}\n\n${context ? 'Kontext:\n' + context + '\n' : ''}Anfrage: ${message}`, 600));
    res.json({ reply: text });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

// Bildanalyse für den Angebots-Assistenten (Vision)
// Groq (primär) + Gemini (Fallback)
const GROQ_VISION_MODELS = [
  'llama-4-scout-17b-16e-instruct',
];

const GEMINI_VISION_MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
];
async function callGeminiVisionAI(systemPrompt, b64, mimeType) {
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
            generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
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
async function callOpenRouterVisionAI(systemPrompt, b64, mimeType) {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error('OPENROUTER_API_KEY nicht konfiguriert.');
  const OR_VISION_MODELS = [
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  ];
  let lastErr;
  for (const model of OR_VISION_MODELS) {
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
          temperature: 0.4,
          max_tokens: 1024
        })
      });
      const data = await response.json();
      if (!response.ok) { lastErr = data; continue; }
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.choices?.[0]?.message?.content || '';
    } catch (err) { lastErr = err; }
  }
  throw new Error('Alle OpenRouter-Modelle nicht verfügbar: ' + JSON.stringify(lastErr));
}

async function callVisionAI(apiKey, systemPrompt, b64, mimeType) {
  let lastError;
  if (apiKey) {
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
            temperature: 0.4,
            max_tokens: 1024
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
  }
  // Groq fehlgeschlagen → Gemini als Fallback
  if (process.env.GEMINI_API_KEY) {
    try { return await callGeminiVisionAI(systemPrompt, b64, mimeType); } catch (err) { lastError = err; }
  }
  // Gemini fehlgeschlagen → OpenRouter als letzter Fallback
  if (process.env.OPENROUTER_API_KEY) {
    return await callOpenRouterVisionAI(systemPrompt, b64, mimeType);
  }
  throw new Error('Alle Vision-Modelle nicht verfügbar: ' + JSON.stringify(lastError));
}

router.post('/offer-assistant-image',
  imageUploadMemory.single('image'),
  async (req, res) => {
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
    if (!req.file)
      return res.status(400).json({ error: 'Kein Bild übermittelt.' });

    const apiKey   = process.env.GROQ_API_KEY;
    const b64      = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const firma = await getFirma();
    const systemPrompt = `Du bist ein KI-Assistent für den Metallbaubetrieb "${firma.name}".
Analysiere das Bild und erkenne alle sichtbaren Metallbau-Leistungen, Materialien, Maße oder Bauteile.
Antworte auf Deutsch. Wenn erkennbare Leistungen vorhanden sind, antworte mit:
1. Kurzem Einleitungssatz über das Bild
2. JSON-Liste:
POSITIONEN_JSON:
[
  {"title": "Bezeichnung", "quantity": 1, "unit": "Stk", "price": 0},
  ...
]
Erlaubte Einheiten: Stk, m, Std, kg, m², Psch
Stundensatz ca. 75–95 €, Materialpreise marktüblich. Bei Unsicherheit price: 0.`;

    try {
      const reply = await callVisionAI(apiKey, systemPrompt, b64, mimeType);
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: 'KI-Bildanalyse fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
    }
  }
);

router.post('/article-suggest', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Keine Beschreibung übermittelt.' });
  const prompt = `Du bist ein Assistent für einen Metallbaubetrieb. Antworte NUR mit einem JSON-Objekt:\n{"title":"…","unit":"Stk|m|m²|kg|Std|Psch","unit_price":0.00,"description":"…"}\nBenutzereingabe: ${message}`;
  try {
    const text  = stripThinking(await callAI(prompt, 200));
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'KI konnte keinen Artikel vorschlagen.' });
    res.json({ article: JSON.parse(match[0]) });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

// KI-Preisschätzung für Lagerartikel (Rohmaterial, Halbzeug, Verbindungsmittel)
router.post('/lager-price', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
  const { bezeichnung, profil, einheit } = req.body;
  if (!bezeichnung) return res.status(400).json({ error: 'Keine Materialbezeichnung übermittelt.' });

  const beschreibung = [bezeichnung, profil].filter(Boolean).join(' ');
  const prompt = `Du bist ein erfahrener Einkäufer in einem deutschen Metallbaubetrieb.
Schätze den aktuellen deutschen Markt-Einkaufspreis (netto, EUR) für folgendes Rohmaterial / Halbzeug / Verbindungsmittel:

Material: ${beschreibung}
Einheit: ${einheit || 'Stk'}

Antworte NUR mit einem JSON-Objekt (kein Text davor oder danach):
{"einheitspreis": 12.50, "begruendung": "Kurze Begründung (1 Satz)", "einheit": "${einheit || 'Stk'}"}

Regeln:
- Realistische Marktpreise für Deutschland 2024/2025 (Stahlhandel, Schraubenhandel etc.)
- Preise in EUR pro Einheit
- Falls unsicher, lieber etwas höher schätzen als zu niedrig
- Bei Stahl/Profile: typischer Preis pro Meter oder kg je nach Angabe
- Nur gültige JSON zurückgeben`;

  try {
    const text  = stripThinking(await callAI(prompt, 150));
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return res.status(500).json({ error: 'KI konnte keinen Preis schätzen.' });
    const data = JSON.parse(match[0]);
    res.json({ einheitspreis: data.einheitspreis, begruendung: data.begruendung, einheit: data.einheit });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

router.post('/project-description', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
  const { keywords } = req.body;
  if (!keywords) return res.status(400).json({ error: 'Keine Stichworte übermittelt.' });
  const prompt = `Schreibe eine kurze, sachliche Auftragsbeschreibung (1-2 Sätze, max. 150 Zeichen) auf Deutsch. Antworte NUR mit der Beschreibung.\nStichworte: ${keywords}`;
  try {
    const text = stripThinking(await callAI(prompt, 100));
    res.json({ description: text.trim().replace(/^["']|["']$/g, '') });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

router.post('/defect-analyze',
  imageUploadMemory.single('image'),
  async (req, res) => {
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
    if (!req.file)
      return res.status(400).json({ error: 'Kein Bild übermittelt.' });

    const apiKey   = process.env.GROQ_API_KEY;
    const b64      = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const hint     = (req.body.hint || '').trim();

    const systemPrompt = `Du bist ein erfahrener Metallbau-Sachverständiger. Analysiere das Foto eines Bauteils oder einer Baustelle.
Antworte auf Deutsch mit einem JSON-Objekt (kein Text davor oder danach):
{
  "title": "Kurzer Mangeltitel (max. 6 Wörter)",
  "description": "Genaue Beschreibung des Mangels oder der Restarbeit (1-2 Sätze)",
  "category": "Mangel" | "Restarbeit" | "Bestellung",
  "severity": "gering" | "mittel" | "hoch"
}
${hint ? 'Zusätzlicher Hinweis vom Nutzer: ' + hint : ''}
Falls kein Mangel erkennbar ist, setze title auf "Kein Mangel erkennbar" und category auf "Restarbeit".`;

    try {
      const reply = await callVisionAI(apiKey, systemPrompt, b64, mimeType);
      const match = reply.match(/\{[\s\S]*?\}/);
      if (!match) return res.status(500).json({ error: 'KI konnte kein Ergebnis extrahieren.' });
      const result = JSON.parse(match[0]);
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: 'KI-Bildanalyse fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
    }
  }
);

router.post('/expand-position', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
  const { keywords, context } = req.body;
  if (!keywords) return res.status(400).json({ error: 'Keine Stichpunkte übermittelt.' });
  const firma = await getFirma();
  const prompt = `Du bist ein erfahrener Metallbauer bei "${firma.name}". Schreibe eine professionelle Leistungsbeschreibung für eine Angebotsposition auf Deutsch.
Antworte NUR mit dem Beschreibungstext, ohne Einleitung, ohne Titel, ohne Anführungszeichen. Max. 2 Sätze. Sachlich und präzise.
${context ? 'Projektkontext: ' + context : ''}
Stichpunkte: ${keywords}`;
  try {
    const text = await callAI(prompt, 150);
    res.json({ text: text.trim().replace(/^["'„]|["'"]$/g, '') });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

router.post('/payment-reminder', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert.' });
  const { invoice_number, customer_name, total_amount, due_date, dunning_level } = req.body;
  if (!invoice_number) return res.status(400).json({ error: 'Rechnungsnummer fehlt.' });
  const levelText = dunning_level > 1 ? `(${dunning_level}. Mahnung)` : '(1. Zahlungserinnerung)';
  const firma = await getFirma();
  const prompt = `Du bist Inhaber von "${firma.name}". Schreibe einen höflichen Mahnungstext ${levelText} (3-5 Sätze, kein Betreff, keine Grußformel am Anfang).\n\nRechnungsnummer: ${invoice_number}\nKunde: ${customer_name || 'Kunde'}\nBetrag: ${total_amount ? Number(total_amount).toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' €' : 'offen'}\nFällig seit: ${due_date ? new Date(due_date).toLocaleDateString('de-DE') : 'überfällig'}`;
  try {
    const text = await callAI(prompt);
    res.json({ reminder: text });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

module.exports = router;
