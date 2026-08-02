const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const db           = require('./config/database');

// ==========================================
// ZEITZONE AUF DEUTSCHLAND FESTLEGEN
// ==========================================
process.env.TZ = 'Europe/Berlin';

// PostgreSQL-Verbindung auf UTC halten
if (process.env.DATABASE_URL) {
  db.query("SET timezone = 'UTC';").catch(() => {});
}

// ==========================================
// HILFSFUNKTION (SQLite & PostgreSQL)
// ==========================================
const isPg = !!process.env.DATABASE_URL;

const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (process.env.DATABASE_URL) {
      let i = 0;
      let pgSql = sql.replace(/\?/g, () => `$${++i}`);
      if (pgSql.trim().toUpperCase().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
        pgSql += ' RETURNING id';
      }
      db.query(pgSql, params, (err, res) => {
        if (err) return reject(err);
        const rows   = res.rows || [];
        const lastID = rows.length > 0 && rows[0].id ? rows[0].id : null;
        resolve({ rows, lastID });
      });
    } else {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        db.all(sql, params, function(err, rows) {
          if (err) return reject(err);
          resolve({ rows: rows || [], lastID: null });
        });
      } else {
        db.run(sql, params, function(err) {
          if (err) return reject(err);
          resolve({ rows: [], lastID: this.lastID });
        });
      }
    }
  });
};

// ==========================================
// AUTOMATISCHE TABELLEN-ERSTELLUNG
// ==========================================
dbQuery(`CREATE TABLE IF NOT EXISTS articles (id SERIAL PRIMARY KEY, title TEXT NOT NULL, unit TEXT, unit_price NUMERIC(10,2) DEFAULT 0, description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS project_photos (id SERIAL PRIMARY KEY, project_id INT, file_url TEXT NOT NULL, original_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS project_measurements (id SERIAL PRIMARY KEY, project_id INT, component_name TEXT NOT NULL, width TEXT, height TEXT, angle TEXT, quantity INT DEFAULT 1, note TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS project_notes (id SERIAL PRIMARY KEY, project_id INT, note_text TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`ALTER TABLE project_notes ADD COLUMN IF NOT EXISTS audio_url TEXT`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS vacations (id SERIAL PRIMARY KEY, user_id INT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT, type TEXT DEFAULT 'Urlaub', file_url TEXT, status TEXT DEFAULT 'Beantragt', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS project_tasks (id SERIAL PRIMARY KEY, project_id INT NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT DEFAULT 'Restarbeit', status TEXT DEFAULT 'Offen', photo_url TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS angle TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS width TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS height TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS note TEXT`).catch(() => {});
dbQuery(`ALTER TABLE vacations ADD COLUMN IF NOT EXISTS file_url TEXT`).catch(() => {});
dbQuery(`ALTER TABLE vacations ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'Urlaub'`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS customer_id INT`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,8)`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8)`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS note TEXT`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS project_id INT`).catch(() => {});
dbQuery(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lat NUMERIC(10,8)`).catch(() => {});
dbQuery(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lng NUMERIC(11,8)`).catch(() => {});
dbQuery(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_radius INT DEFAULT 200`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS project_sketches (id SERIAL PRIMARY KEY, project_id INT NOT NULL, title TEXT, image_data TEXT NOT NULL, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS tickers (id SERIAL PRIMARY KEY, message TEXT NOT NULL, author TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS appointment_users (appointment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (appointment_id, user_id))`).catch(() => {});
dbQuery(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 19`).catch(() => {});
dbQuery(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) DEFAULT 0`).catch(() => {});
dbQuery(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) DEFAULT 0`).catch(() => {});
dbQuery(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS due_date TEXT`).catch(() => {});
dbQuery(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_note TEXT`).catch(() => {});
dbQuery(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS dunning_level INT DEFAULT 0`).catch(() => {});
dbQuery(`CREATE TABLE IF NOT EXISTS document_items (id SERIAL PRIMARY KEY, document_id INT NOT NULL, description TEXT, quantity NUMERIC(10,3) DEFAULT 1, unit TEXT DEFAULT 'Stk', price NUMERIC(12,2) DEFAULT 0)`).catch(() => {});
dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vacation_allowance INT DEFAULT 30`).catch(() => {});
dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT`).catch(() => {});
dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_api_key TEXT`).catch(() => {});
dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_notify BOOLEAN DEFAULT true`).catch(() => {});

// Bereinigung alter lokaler Upload-Pfade
dbQuery("DELETE FROM project_files  WHERE file_url LIKE '/uploads/%'").catch(() => {});
dbQuery("DELETE FROM customer_files WHERE file_url LIKE '/uploads/%'").catch(() => {});

// ==========================================
// CLOUDINARY (wird von Route-Dateien benötigt)
// ==========================================
const { v2: cloudinary } = require('cloudinary');
cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET
});

// ==========================================
// MIDDLEWARE & ROUTEN
// ==========================================
const { verifyToken, requireAdmin } = require('./middleware/auth');
const authRoutes         = require('./routes/authRoutes');
const documentRoutes     = require('./routes/documentRoutes');
const dashboardRoutes    = require('./routes/dashboardRoutes');
const projectRoutes      = require('./routes/projectRoutes');
const customerRoutes     = require('./routes/customerRoutes');
const calendarRoutes     = require('./routes/calendarRoutes');
const timetrackingRoutes = require('./routes/timetrackingRoutes');
const vacationRoutes     = require('./routes/vacationRoutes');
const adminRoutes        = require('./routes/adminRoutes');
const articleRoutes      = require('./routes/articleRoutes');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'Public')));

// ==========================================
// RATE LIMITING
// ==========================================
// Login: max. 10 Versuche pro 15 Minuten je IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Zu viele Anmeldeversuche. Bitte warte 15 Minuten und versuche es erneut.'
});
app.use('/login', loginLimiter);

// API: max. 200 Anfragen pro Minute je IP (verhindert Scraping/KI-Missbrauch)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 Minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Zu viele Anfragen. Bitte kurz warten.'
});
app.use('/api/', apiLimiter);

// ==========================================
// ÖFFENTLICHE ROUTEN (Login / Logout)
// ==========================================
app.use('/', authRoutes);

// ==========================================
// ALLE FOLGENDEN ROUTEN ERFORDERN LOGIN
// ==========================================
app.use(verifyToken);

// Dokument-Routen (Angebote → Projekt / Rechnung)
app.use('/documents', documentRoutes);

// Dashboard & Widget-Einstellungen
app.use('/', dashboardRoutes);

// Aufträge & Baustellen
app.use('/projects', projectRoutes);

// Kunden
app.use('/customers', customerRoutes);

// Kalender & Termine & Wetter-API
app.use('/',              calendarRoutes);

// Zeiterfassung
app.use('/timetracking', timetrackingRoutes);

// Urlaub & Abwesenheit
app.use('/vacations', vacationRoutes);

// Admin-Bereich (Zeiterfassung-Übersicht, Mitarbeiter, Ticker, PDF)
app.use('/admin',   adminRoutes);
app.use('/ticker',  adminRoutes);

// Artikel-Stamm
app.use('/articles', articleRoutes);

// ==========================================
// GLOBALE SUCHE
// ==========================================
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  // SQLite unterstützt kein ILIKE — Fallback auf LIKE (case-insensitive per COLLATE NOCASE)
  const like    = `%${q}%`;
  const isAdmin = req.user.role === 'ADMIN';

  const likeOp = isPg ? 'ILIKE' : 'LIKE';

  try {
    const projRes = await dbQuery(`
      SELECT p.id, p.title, p.status, p.description, c.company_name, c.contact_person
      FROM projects p LEFT JOIN customers c ON p.customer_id = c.id
      WHERE p.title ${likeOp} ? OR p.description ${likeOp} ?
         OR c.company_name ${likeOp} ? OR c.contact_person ${likeOp} ?
      ORDER BY p.created_at DESC LIMIT 6`, [like, like, like, like]);

    const custRes = isAdmin ? await dbQuery(`
      SELECT id, company_name, contact_person, city, phone
      FROM customers
      WHERE company_name ${likeOp} ? OR contact_person ${likeOp} ? OR city ${likeOp} ?
      ORDER BY company_name ASC LIMIT 5`, [like, like, like])
      : { rows: [] };

    const appRes = await dbQuery(`
      SELECT a.id, a.title, a.start_date, a.description, c.company_name, c.contact_person
      FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id
      WHERE a.title ${likeOp} ? OR a.description ${likeOp} ?
         OR c.company_name ${likeOp} ? OR c.contact_person ${likeOp} ?
      ORDER BY a.start_date DESC LIMIT 4`, [like, like, like, like]);

    const notesRes = await dbQuery(`
      SELECT n.id, n.note_text, n.project_id, p.title as project_title
      FROM project_notes n LEFT JOIN projects p ON n.project_id = p.id
      WHERE n.note_text ${likeOp} ?
      ORDER BY n.created_at DESC LIMIT 4`, [like]);

    const results = [
      ...(projRes.rows || []).map(r => ({
        type: 'project', icon: '🏗️',
        label: r.title,
        sub:   [r.company_name || r.contact_person, r.status].filter(Boolean).join(' · '),
        url:   `/projects/${r.id}`
      })),
      ...(custRes.rows || []).map(r => ({
        type: 'customer', icon: '👤',
        label: r.company_name || r.contact_person,
        sub:   [r.contact_person, r.city].filter(Boolean).join(' · '),
        url:   `/customers`
      })),
      ...(appRes.rows || []).map(r => ({
        type: 'appointment', icon: '📅',
        label: r.title,
        sub:   [r.company_name || r.contact_person, r.start_date ? new Date(r.start_date).toLocaleDateString('de-DE') : ''].filter(Boolean).join(' · '),
        url:   `/calendar`
      })),
      ...(notesRes.rows || []).map(r => ({
        type: 'note', icon: '📝',
        label: r.note_text.length > 70 ? r.note_text.slice(0, 70) + '…' : r.note_text,
        sub:   r.project_title ? `Auftrag: ${r.project_title}` : '',
        url:   r.project_id ? `/projects/${r.project_id}` : `/projects`
      }))
    ];

    res.json({ results });
  } catch (err) {
    console.error('Suche Fehler:', err.message);
    res.json({ results: [] });
  }
});

// ==========================================
// KI-API-ROUTEN (global, nicht projektgebunden)
// ==========================================
const multer = require('multer');
const imageUploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // max. 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilddateien erlaubt.'));
  }
});

async function callAI(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY nicht konfiguriert.');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.APP_URL || 'https://metallbau-app.onrender.com',
      'X-Title': 'Metallbau App'
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.choices[0].message.content;
}

const { FIRMA } = require('./utils/firma');

app.post('/api/ai/offer-assistant', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'Keine Nachricht übermittelt.' });
  const systemPrompt = `Du bist ein KI-Assistent für den Metallbaubetrieb "${FIRMA.name}".\nHilf dem Benutzer, ein Angebot zu erstellen. Antworte immer auf Deutsch.\n\nWenn Leistungen genannt werden, antworte mit:\n1. Kurzem Einleitungssatz\n2. JSON-Liste:\nPOSITIONEN_JSON:\n[\n  {"title": "Bezeichnung", "quantity": 1, "unit": "Stk", "price": 0},\n  ...\n]\nErlaubte Einheiten: Stk, m, Std, kg, m², Psch\nStundensatz ca. 75–95 €, Materialpreise marktüblich. Bei Unsicherheit price: 0.`;
  try {
    const text = await callAI(`${systemPrompt}\n\n${context ? 'Kontext:\n' + context + '\n' : ''}Benutzer: ${message}`);
    res.json({ reply: text });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

// Bildanalyse für den Angebots-Assistenten (Vision)
app.post('/api/ai/offer-assistant-image',
  imageUploadMemory.single('image'),
  async (req, res) => {
    if (!process.env.OPENROUTER_API_KEY)
      return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
    if (!req.file)
      return res.status(400).json({ error: 'Kein Bild übermittelt.' });

    const apiKey   = process.env.OPENROUTER_API_KEY;
    const b64      = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const systemPrompt = `Du bist ein KI-Assistent für den Metallbaubetrieb "${FIRMA.name}".
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
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.APP_URL || 'https://metallbau-app.onrender.com',
          'X-Title': 'Metallbau App'
        },
        body: JSON.stringify({
          model: 'google/gemini-flash-1.5',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: systemPrompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
            ]
          }],
          temperature: 0.7
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(data));
      res.json({ reply: data.choices[0].message.content });
    } catch (err) {
      res.status(500).json({ error: 'KI-Bildanalyse fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
    }
  }
);

app.post('/api/ai/article-suggest', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Keine Beschreibung übermittelt.' });
  const prompt = `Du bist ein Assistent für einen Metallbaubetrieb. Antworte NUR mit einem JSON-Objekt:\n{"title":"…","unit":"Stk|m|m²|kg|Std|Psch","unit_price":0.00,"description":"…"}\nBenutzereingabe: ${message}`;
  try {
    const text  = await callAI(prompt);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'KI konnte keinen Artikel vorschlagen.' });
    res.json({ article: JSON.parse(match[0]) });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

app.post('/api/ai/project-description', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { keywords } = req.body;
  if (!keywords) return res.status(400).json({ error: 'Keine Stichworte übermittelt.' });
  const prompt = `Schreibe eine kurze, sachliche Auftragsbeschreibung (1-2 Sätze, max. 150 Zeichen) auf Deutsch. Antworte NUR mit der Beschreibung.\nStichworte: ${keywords}`;
  try {
    const text = await callAI(prompt);
    res.json({ description: text.trim().replace(/^["']|["']$/g, '') });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

app.post('/api/ai/payment-reminder', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { invoice_number, customer_name, total_amount, due_date, dunning_level } = req.body;
  if (!invoice_number) return res.status(400).json({ error: 'Rechnungsnummer fehlt.' });
  const levelText = dunning_level > 1 ? `(${dunning_level}. Mahnung)` : '(1. Zahlungserinnerung)';
  const prompt = `Du bist Inhaber von "${FIRMA.name}". Schreibe einen höflichen Mahnungstext ${levelText} (3-5 Sätze, kein Betreff, keine Grußformel am Anfang).\n\nRechnungsnummer: ${invoice_number}\nKunde: ${customer_name || 'Kunde'}\nBetrag: ${total_amount ? Number(total_amount).toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' €' : 'offen'}\nFällig seit: ${due_date ? new Date(due_date).toLocaleDateString('de-DE') : 'überfällig'}`;
  try {
    const text = await callAI(prompt);
    res.json({ reminder: text });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

// ==========================================
// SERVER START
// ==========================================
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Metallbau-App gestartet!`);
  console.log(`👉 Öffne im Browser: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
