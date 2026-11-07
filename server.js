const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./config/database');
const { initChatServer, ensureChatTable } = require('./utils/chatSocket');

process.env.TZ = 'Europe/Berlin';

if (process.env.DATABASE_URL) {
  db.query("SET timezone = 'Europe/Berlin';").catch(() => {});
}

const isPg = !!process.env.DATABASE_URL;

function parseBerlinDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  if (/[zZ]$/.test(normalized) || /[+-]\d{2}:?\d{2}$/.test(normalized)) {
    return new Date(normalized);
  }
  return new Date(normalized + '+01:00');
}

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
        const rows = res.rows || [];
        const lastID = rows.length > 0 && rows[0].id ? rows[0].id : null;
        resolve({ rows, lastID });
      });
    } else {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        db.all(sql, params, function (err, rows) {
          if (err) return reject(err);
          resolve({ rows: rows || [], lastID: null });
        });
      } else {
        db.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve({ rows: [], lastID: this.lastID });
        });
      }
    }
  });
};

const { runMigrations } = require('./utils/migrations');
runMigrations().catch(err => {
  console.error('❌ Datenbank-Migration fehlgeschlagen:', err.message);
  process.exit(1);
});

dbQuery("DELETE FROM project_files  WHERE file_url LIKE '/uploads/%'").catch(() => {});
dbQuery("DELETE FROM customer_files WHERE file_url LIKE '/uploads/%'").catch(() => {});

const { v2: cloudinary } = require('cloudinary');
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const { verifyToken, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const projectRoutes = require('./routes/projectRoutes');
const customerRoutes = require('./routes/customerRoutes');
const calendarRoutes = require('./routes/calendarRoutes');
const timetrackingRoutes = require('./routes/timetrackingRoutes');
const vacationRoutes = require('./routes/vacationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const articleRoutes = require('./routes/articleRoutes');
const companySettingsRoutes = require('./routes/companySettingsRoutes');
const reportsRoutes = require('./routes/reportsRoutes');
const tickerRoutes = require('./routes/tickerRoutes');
const lagerRoutes = require('./routes/lagerRoutes');
const schnittlisteRoutes = require('./routes/schnittlisteRoutes');
const colorsRoutes = require('./routes/colorsRoutes');
const pushRoutes = require('./routes/pushRoutes');
const taskRoutes = require('./routes/taskRoutes');
const chatRoutes = require('./routes/chatRoutes');
const miscRoutes = require('./routes/miscRoutes');
const appApiRoutes = require('./routes/appApiRoutes');
const rfidRoutes = require('./routes/rfidRoutes');
const aiApiRoutes = require('./routes/aiApiRoutes');
const { startBackupCron } = require('./utils/backup');
const { startRetentionCron } = require('./utils/dataRetention');
const { startStampReminderCron } = require('./utils/stampReminder');
const { startDunningCron } = require('./utils/dunning');
const { startLagerAlertCron } = require('./utils/lagerAlert');
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use('/cad/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build'), { fallthrough: false }));
app.use('/cad/vendor/three-controls', express.static(path.join(__dirname, 'node_modules/three/examples/jsm/controls'), { fallthrough: false }));
app.use(express.static(path.join(__dirname, 'Public')));

app.use((req, res, next) => {
  const origRender = res.render.bind(res);
  res.render = function (view, options, callback) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return origRender(view, options, callback);
  };
  next();
});

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Zu viele Anmeldeversuche. Bitte warte 5 Minuten und versuche es erneut.'
});
app.use('/login', loginLimiter);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Zu viele Anfragen. Bitte kurz warten.'
});
app.use('/api/', apiLimiter);

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele KI-Anfragen. Bitte kurz warten.' }
});
const rfidLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Zu viele RFID-Anfragen.' }
});

app.use('/', authRoutes);
app.get('/health', async (req, res) => {
  try {
    await dbQuery('SELECT 1 AS ok');
    res.json({ ok: true, db: 'up', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

app.use('/cad-approval', require('./routes/cadApprovalRoutes'));
app.use('/api/v2/auth/login', loginLimiter);
app.use('/api/v2', require('./routes/apiRoutes'), (req, res) => res.status(404).json({ error: 'API-Endpunkt nicht gefunden' }));
app.use(verifyToken);

const { getFirma: _getFirmaLocals } = require('./utils/companySettings');
const { canSeeMoney: _canSeeMoney, hasPerm: _hasPerm } = require('./middleware/auth');
app.use(async (req, res, next) => {
  try {
    res.locals.firma = await _getFirmaLocals();
  } catch (_) {
    res.locals.firma = require('./utils/companySettings').DEFAULTS;
  }
  if (req.user && ['CHEF', 'ADMIN'].includes(req.user.role)) res.locals.backupStatus = require('./utils/backupStatus').summary(res.locals.firma);
  res.locals.canSeeMoney = req.user ? _canSeeMoney(req.user, res.locals.firma) : false;
  res.locals.hasPerm = (area, adminDef, employeeDef) =>
    _hasPerm(req.user, area, res.locals.firma, adminDef, employeeDef);
  try {
    const raw = req.cookies && req.cookies.sidebar_hidden;
    res.locals.sidebarHidden = raw ? JSON.parse(raw) : [];
  } catch (_) {
    res.locals.sidebarHidden = [];
  }
  next();
});

app.use('/documents', documentRoutes);
app.use('/', dashboardRoutes);
app.use('/auftragszentrale', require('./routes/workflowRoutes'));
app.use('/projects', projectRoutes);
app.use('/customers', customerRoutes);
app.use('/', calendarRoutes);
app.use('/timetracking', timetrackingRoutes);
app.use('/vacations', vacationRoutes);
app.use('/admin', adminRoutes);
app.use('/admin', companySettingsRoutes);
app.use('/articles', articleRoutes);
app.use('/reports', reportsRoutes);
app.use('/ticker', tickerRoutes);
app.use('/lager', lagerRoutes);
app.use('/schnittliste', schnittlisteRoutes);
app.use('/farben', colorsRoutes);
app.use('/push', pushRoutes);
app.use('/tasks', taskRoutes);
app.use('/chat', chatRoutes);
app.use('/', miscRoutes);
app.use('/api', appApiRoutes);
app.use('/api/rfid', rfidLimiter, rfidRoutes);
app.use('/api/ai', aiLimiter, aiApiRoutes);

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

const server = http.createServer(app);
initChatServer(server);
require('./utils/projectTrash').startTrashPurgeSchedule();
ensureChatTable();

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Metallbau-App gestartet!`);
  console.log(`👉 Öffne im Browser: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
  startBackupCron();
  startRetentionCron();
  startStampReminderCron();
  startDunningCron();
  startLagerAlertCron();
});
