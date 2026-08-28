const express      = require('express');
const http         = require('http');
const path         = require('path');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const cors         = require('cors');
const db           = require('./config/database');
const { initChatServer, ensureChatTable } = require('./utils/chatSocket');

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
const schnittlisteRoutes        = require('./routes/schnittlisteRoutes');
const colorsRoutes              = require('./routes/colorsRoutes');
const pushRoutes                = require('./routes/pushRoutes');
const taskRoutes                = require('./routes/taskRoutes');
const chatRoutes                = require('./routes/chatRoutes');
const miscRoutes                = require('./routes/miscRoutes');
const appApiRoutes              = require('./routes/appApiRoutes');
const rfidRoutes                = require('./routes/rfidRoutes');
const aiApiRoutes               = require('./routes/aiApiRoutes');
const { startBackupCron } = require('./utils/backup');
const { startRetentionCron } = require('./utils/dataRetention');
const { startStampReminderCron } = require('./utils/stampReminder');
const { startDunningCron } = require('./utils/dunning');
const { startLagerAlertCron } = require('./utils/lagerAlert');
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
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.json({ limit: '15mb' }));
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

// Schnittliste (Baustahl/Edelstahl-Zuschnitt: Upload, PDF-Export, Bild-Erkennung)
app.use('/schnittliste', schnittlisteRoutes);
app.use('/farben', colorsRoutes);

// Push-Benachrichtigungen (Subscription verwalten)
app.use('/push', pushRoutes);

app.use('/tasks', taskRoutes);

app.use('/chat', chatRoutes);
app.use('/', miscRoutes);

// Baustellenkarte (Leaflet)
// ==========================================
// MOBILE API (JSON – React Native App)
// ==========================================
const apiRoutes = require('./routes/apiRoutes');
app.use('/api/v2', apiRoutes);
app.use('/api', appApiRoutes);  // search, today-hours, dark-mode
app.use('/api/rfid', rfidRoutes);
app.use('/api/ai', aiApiRoutes);


// ==========================================
// API: HEUTE GEARBEITETE STUNDEN (für Mitarbeiter-Dashboard)
// ==========================================
// ==========================================
// RFID-STEMPEL (Raspberry Pi Lesegerät)
// Kein JWT – gesichert per RFID_API_KEY in .env
// ==========================================



// ==========================================
// ERROR PAGES
// ==========================================
app.use((req, res) => {
  res.status(404).render('error', {
    status: 404,
    title: 'Seite nicht gefunden',
    message: 'Die angeforderte Seite existiert nicht oder wurde verschoben.'
  });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err && err.stack ? err.stack : err);
  const status = err.status || err.statusCode || 500;
  if (req.accepts('html')) {
    return res.status(status).render('error', {
      status,
      title: status === 403 ? 'Zugriff verweigert' : 'Serverfehler',
      message: process.env.NODE_ENV === 'production'
        ? 'Ein interner Fehler ist aufgetreten. Bitte später erneut versuchen.'
        : (err.message || 'Unbekannter Fehler')
    });
  }
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

// ==========================================
// SERVER START
// ==========================================
// http.createServer statt app.listen direkt, damit der WebSocket-Server
// (Echtzeit-Chat) sich an denselben HTTP-Server anhängen kann (nötig für
// den "upgrade"-Handshake von WebSocket-Verbindungen).
const server = http.createServer(app);
initChatServer(server);
ensureChatTable(); // sofort beim Start prüfen/anlegen, sichtbar in den Start-Logs

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Metallbau-App gestartet!`);
  console.log(`👉 Öffne im Browser: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
  // Automatisches Datenbank-Backup täglich um Mitternacht
  startBackupCron();
  // Automatische Löschung alter Zeiterfassungs-Einträge nach Aufbewahrungsfrist (täglich 01:00 Uhr)
  startRetentionCron();
  // Erinnerung bei vergessenem Ausstempeln (alle 30 Minuten)
  startStampReminderCron();
  // Automatisches Mahnwesen bei überfälligen Rechnungen (täglich 08:00 Uhr)
  startDunningCron();
  // Proaktive Lagerbestand-Warnung (täglich 07:00 Uhr)
  startLagerAlertCron();
});
