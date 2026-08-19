const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const cors         = require('cors');
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
// DATENBANK-MIGRATIONEN
// Alle Schema-Definitionen leben in utils/migrations.js.
// Dort neue Tabellen oder Spalten hinzufügen – nicht hier.
// ==========================================
const { runMigrations } = require('./utils/migrations');
runMigrations().catch(err => {
  console.error('❌ Datenbank-Migration fehlgeschlagen:', err.message);
  process.exit(1);
});

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
const adminRoutes              = require('./routes/adminRoutes');
const articleRoutes            = require('./routes/articleRoutes');
const companySettingsRoutes    = require('./routes/companySettingsRoutes');
const reportsRoutes            = require('./routes/reportsRoutes');
const tickerRoutes             = require('./routes/tickerRoutes');
const lagerRoutes              = require('./routes/lagerRoutes');
const pushRoutes                = require('./routes/pushRoutes');
const taskRoutes                = require('./routes/taskRoutes');
const { startBackupCron, runBackup } = require('./utils/backup');
const app  = express();
const PORT = process.env.PORT || 3000;

// Trust the first proxy (Render / reverse-proxy environments) so that
// express-rate-limit can read the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// ==========================================
// CORS (für React Native Android-App)
// ==========================================
app.use(cors({
  origin: true,           // Alle Origins erlaubt (App sendet keine Origin)
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'Public')));

// UTF-8 Charset für alle HTML-Antworten erzwingen
app.use((req, res, next) => {
  const origRender = res.render.bind(res);
  res.render = function(view, options, callback) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return origRender(view, options, callback);
  };
  next();
});

// ==========================================
// RATE LIMITING
// ==========================================
// Login: max. 10 Versuche pro 15 Minuten je IP
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 15 Minuten
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Zu viele Anmeldeversuche. Bitte warte 5 Minuten und versuche es erneut.'
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

// Firmendaten für alle Views als res.locals bereitstellen (Sidebar-Name etc.)
const { getFirma: _getFirmaLocals } = require('./utils/companySettings');
const { canSeeMoney: _canSeeMoney, hasPerm: _hasPerm } = require('./middleware/auth');
app.use(async (req, res, next) => {
  try {
    res.locals.firma = await _getFirmaLocals();
  } catch (_) {
    res.locals.firma = require('./utils/companySettings').DEFAULTS;
  }
  // canSeeMoney als Helper für alle EJS-Views verfügbar machen
  res.locals.canSeeMoney = req.user ? _canSeeMoney(req.user, res.locals.firma) : false;
  // hasPerm als Helper-Funktion für alle EJS-Views (Sidebar, Seiten)
  res.locals.hasPerm = (area, adminDef, employeeDef) =>
    _hasPerm(req.user, area, res.locals.firma, adminDef, employeeDef);
  // Sidebar-Einstellungen aus Cookie für EJS verfügbar machen
  try {
    const raw = req.cookies && req.cookies.sidebar_hidden;
    res.locals.sidebarHidden = raw ? JSON.parse(raw) : [];
  } catch (_) {
    res.locals.sidebarHidden = [];
  }
  next();
});

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
app.use('/admin',   companySettingsRoutes);

// Artikel-Stamm
app.use('/articles', articleRoutes);

// Berichte & Auswertungen
app.use('/reports', reportsRoutes);
app.use('/ticker',  tickerRoutes);

// Lagerliste (Baustahl & Edelstahl)
app.use('/lager', lagerRoutes);

// Push-Benachrichtigungen (Subscription verwalten)
app.use('/push', pushRoutes);

app.use('/tasks', taskRoutes);

// ==========================================
// SIDEBAR-EINSTELLUNGEN (speichert Cookie)
// ==========================================
app.post('/sidebar-settings', (req, res) => {
  const hidden = Object.keys(req.body).filter(k => k.startsWith('hide_'));
  // Als JSON-Cookie speichern (30 Tage) – httpOnly:false damit EJS es lesen kann
  res.cookie('sidebar_hidden', JSON.stringify(hidden), {
    maxAge: 30 * 24 * 3600 * 1000,
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
  });
  // Zurück zur Seite von der der Request kam
  const redirect = req.body._redirect || req.headers.referer || '/';
  res.redirect(redirect);
});

// ==========================================
// MOBILE API (JSON – React Native App)
// ==========================================
const apiRoutes = require('./routes/apiRoutes');
app.use('/api/v2', apiRoutes);

// Admin: Backup manuell auslösen (zum Testen)
app.post('/admin/backup/run', require('./middleware/auth').requireAdmin, async (req, res) => {
  try {
    await runBackup();
    res.redirect('/admin/company-settings?saved=1');
  } catch (err) {
    res.status(500).send('Backup fehlgeschlagen: ' + err.message);
  }
});

// ==========================================
// GLOBALE SUCHE
// ==========================================
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  const like   = `%${q}%`;
  const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'CHEF';
  const likeOp  = isPg ? 'ILIKE' : 'LIKE';

  try {
    const [projRes, appRes, notesRes, custRes, usersRes, articlesRes] = await Promise.all([
      dbQuery(`
        SELECT p.id, p.title, p.status, p.description, c.company_name, c.contact_person
        FROM projects p LEFT JOIN customers c ON p.customer_id = c.id
        WHERE p.title ${likeOp} ? OR p.description ${likeOp} ?
           OR c.company_name ${likeOp} ? OR c.contact_person ${likeOp} ?
        ORDER BY p.created_at DESC LIMIT 6`, [like, like, like, like]),
      dbQuery(`
        SELECT a.id, a.title, a.start_date, a.description, c.company_name, c.contact_person
        FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id
        WHERE a.title ${likeOp} ? OR a.description ${likeOp} ?
           OR c.company_name ${likeOp} ? OR c.contact_person ${likeOp} ?
        ORDER BY a.start_date DESC LIMIT 4`, [like, like, like, like]),
      dbQuery(`
        SELECT n.id, n.note_text, n.project_id, p.title as project_title
        FROM project_notes n LEFT JOIN projects p ON n.project_id = p.id
        WHERE n.note_text ${likeOp} ?
        ORDER BY n.created_at DESC LIMIT 4`, [like]),
      isAdmin ? dbQuery(`
        SELECT id, company_name, contact_person, city
        FROM customers
        WHERE company_name ${likeOp} ? OR contact_person ${likeOp} ? OR city ${likeOp} ?
        ORDER BY company_name ASC LIMIT 5`, [like, like, like])
        : Promise.resolve({ rows: [] }),
      isAdmin ? dbQuery(`
        SELECT id, username, role FROM users
        WHERE username ${likeOp} ?
        ORDER BY username ASC LIMIT 4`, [like])
        : Promise.resolve({ rows: [] }),
      isAdmin ? dbQuery(`
        SELECT id, title, unit FROM articles
        WHERE title ${likeOp} ? OR description ${likeOp} ?
        ORDER BY title ASC LIMIT 4`, [like, like])
        : Promise.resolve({ rows: [] }),
    ]);

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
      })),
      ...(usersRes.rows || []).map(r => ({
        type: 'user', icon: '👷',
        label: r.username,
        sub:   r.role,
        url:   `/admin/users`
      })),
      ...(articlesRes.rows || []).map(r => ({
        type: 'article', icon: '📦',
        label: r.title,
        sub:   r.unit ? `Einheit: ${r.unit}` : '',
        url:   `/articles`
      })),
    ];

    res.json({ results });
  } catch (err) {
    console.error('Suche Fehler:', err.message);
    res.json({ results: [] });
  }
});

// ==========================================
// API: HEUTE GEARBEITETE STUNDEN (für Mitarbeiter-Dashboard)
// ==========================================
app.get('/api/today-hours', async (req, res) => {
  try {
    const userId = req.user.id;
    const sql = isPg
      ? `SELECT type, TO_CHAR(timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_ts
         FROM time_logs WHERE user_id = ? AND DATE(timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = CURRENT_DATE
         ORDER BY timestamp ASC`
      : `SELECT type, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_ts
         FROM time_logs WHERE user_id = ? AND date(timestamp) = date('now')
         ORDER BY timestamp ASC`;
    const result = await dbQuery(sql, [userId]);
    const logs   = result.rows || [];
    let totalMs  = 0;
    const now    = Date.now();
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].type !== 'IN') continue;
      const start = new Date((logs[i].local_ts || '').replace(' ', 'T')).getTime();
      const next  = logs[i + 1];
      const end   = (next && next.type === 'OUT')
        ? new Date((next.local_ts || '').replace(' ', 'T')).getTime()
        : (i === logs.length - 1 ? now : start);
      if (end > start) totalMs += end - start;
    }
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    res.json({ label: `${h} Std. ${m} Min.` });
  } catch (err) {
    res.json({ label: '–' });
  }
});

// ==========================================
// RFID-STEMPEL (Raspberry Pi Lesegerät)
// Kein JWT – gesichert per RFID_API_KEY in .env
// ==========================================
app.post('/api/rfid/stamp', async (req, res) => {
  // API-Key prüfen (Header: X-RFID-Key) – fail-closed
  const apiKey = process.env.RFID_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'RFID-Stempeluhr nicht konfiguriert.' });
  }
  if (req.headers['x-rfid-key'] !== apiKey) {
    return res.status(401).json({ ok: false, error: 'Ungültiger API-Key' });
  }

  const { uid, note } = req.body;
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    return res.status(400).json({ ok: false, error: 'UID fehlt' });
  }

  try {
    // Mitarbeiter anhand UID suchen
    const userRes = await dbQuery(
      `SELECT id, username, role FROM users WHERE rfid_uid = ?`,
      [uid.trim().toUpperCase()]
    );
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Unbekannte RFID-UID' });
    }

    // Letzten Stempel ermitteln → IN oder OUT
    const lastRes = await dbQuery(
      isPg
        ? `SELECT type FROM time_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`
        : `SELECT type FROM time_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [user.id]
    );
    const lastType  = lastRes.rows[0]?.type || 'OUT';
    const stampType = lastType === 'IN' ? 'OUT' : 'IN';

    // Eintrag speichern
    const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
    await dbQuery(
      `INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, ${tsExpr})`,
      [user.id, stampType, note || (stampType === 'IN' ? 'RFID Einstempel' : 'RFID Ausstempel')]
    );

    console.log(`[RFID] ${user.username} → ${stampType} (UID: ${uid})`);
    res.json({ ok: true, username: user.username, type: stampType });
  } catch (err) {
    console.error('[RFID] Fehler:', err.message);
    res.status(500).json({ ok: false, error: 'Datenbankfehler' });
  }
});

// ==========================================
// API: DARK-MODE serverseitig speichern
// ==========================================
app.post('/api/dark-mode', async (req, res) => {
  try {
    const { dark } = req.body;
    const val = dark === true || dark === 'true' ? 1 : 0;
    await dbQuery(
      isPg
        ? `UPDATE users SET dark_mode = ? WHERE id = ?`
        : `UPDATE users SET dark_mode = ? WHERE id = ?`,
      [val, req.user.id]
    ).catch(() => {}); // Spalte existiert ggf. noch nicht — still ignorieren
    res.json({ ok: true });
  } catch (_) {
    res.json({ ok: false });
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

app.post('/api/ai/offer-assistant', async (req, res) => {
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

app.post('/api/ai/offer-assistant-image',
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

app.post('/api/ai/article-suggest', async (req, res) => {
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
app.post('/api/ai/lager-price', async (req, res) => {
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

app.post('/api/ai/project-description', async (req, res) => {
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

app.post('/api/ai/defect-analyze',
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

app.post('/api/ai/expand-position', async (req, res) => {
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

app.post('/api/ai/payment-reminder', async (req, res) => {
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

// ==========================================
// SERVER START
// ==========================================
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Metallbau-App gestartet!`);
  console.log(`👉 Öffne im Browser: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
  // Automatisches Datenbank-Backup täglich um Mitternacht
  startBackupCron();
});
