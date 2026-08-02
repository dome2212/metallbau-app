const express = require('express');
const path = require('path');
const https = require('https');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./config/database');

// ==========================================
// GLOBALE ZEITZONE AUF DEUTSCHLAND FESTLEGEN
// ==========================================
process.env.TZ = 'Europe/Berlin';

// Automatische Einbindung von PDFKit
let PDFKit;
try {
  PDFKit = require('pdfkit');
} catch (e) {
  console.log('Hinweis: pdfkit Modul wird geladen...');
}

// PostgreSQL-Verbindung auf UTC halten (Timestamps werden als UTC gespeichert,
// Anzeige-Konvertierung erfolgt per AT TIME ZONE 'Europe/Berlin' in den Abfragen)
if (process.env.DATABASE_URL) {
  db.query("SET timezone = 'UTC';").catch(() => {});
}

// ==========================================
// DB-HILFSKONSTANTE
// ==========================================
const isPg = !!process.env.DATABASE_URL;

// ==========================================
// HILFSFUNKTION (Muss ganz oben stehen!)
// ==========================================
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
        // SELECT queries — db.all returns rows
        db.all(sql, params, function(err, rows) {
          if (err) return reject(err);
          resolve({ rows: rows || [], lastID: null });
        });
      } else {
        // INSERT / UPDATE / DELETE — db.run provides this.lastID and this.changes
        db.run(sql, params, function(err) {
          if (err) return reject(err);
          resolve({ rows: [], lastID: this.lastID });
        });
      }
    }
  });
};

// ==========================================
// AUTOMATISCHE TABELLEN-ERSTELLUNG BEIM START
// ==========================================
dbQuery(`
  CREATE TABLE IF NOT EXISTS articles (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    unit TEXT,
    unit_price NUMERIC(10,2) DEFAULT 0,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle articles existiert bereits:', err.message));

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_photos (
    id SERIAL PRIMARY KEY,
    project_id INT,
    file_url TEXT NOT NULL,
    original_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_photos existiert bereits:', err.message));

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_measurements (
    id SERIAL PRIMARY KEY,
    project_id INT,
    component_name TEXT NOT NULL,
    width TEXT,
    height TEXT,
    angle TEXT,
    quantity INT DEFAULT 1,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_measurements existiert bereits:', err.message));

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_notes (
    id SERIAL PRIMARY KEY,
    project_id INT,
    note_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_notes existiert bereits:', err.message));

// Audio-Notizen: Spalte audio_url nachrüsten (idempotent)
dbQuery(`ALTER TABLE project_notes ADD COLUMN IF NOT EXISTS audio_url TEXT`)
  .catch(() => {});

dbQuery(`
  CREATE TABLE IF NOT EXISTS vacations (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    reason TEXT,
    type TEXT DEFAULT 'Urlaub',
    file_url TEXT,
    status TEXT DEFAULT 'Beantragt',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle vacations existiert bereits:', err.message));

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_tasks (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'Restarbeit',
    status TEXT DEFAULT 'Offen',
    photo_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_tasks existiert bereits:', err.message));

// Automatische Ergänzung fehlender Spalten bei bestehenden Tabellen auf Render
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

// Baustellenkoordinaten für Geo-Fencing
dbQuery(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lat NUMERIC(10,8)`).catch(() => {});
dbQuery(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lng NUMERIC(11,8)`).catch(() => {});
dbQuery(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_radius INT DEFAULT 200`).catch(() => {});

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_sketches (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL,
    title TEXT,
    image_data TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_sketches existiert bereits:', err.message));

// Feature: Firmen-Ticker (Schwarzes Brett)
dbQuery(`
  CREATE TABLE IF NOT EXISTS tickers (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    author TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(() => {});

// Feature: Urlaubskonto – Jahrestage pro Mitarbeiter
dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vacation_allowance INT DEFAULT 30`).catch(() => {});

// ==========================================
// CLOUDINARY & MULTER KONFIGURATION
// ==========================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'metallbau-management',
    allowed_formats: ['jpg', 'png', 'jpeg', 'pdf', 'webp'],
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 }
});

// Hilfsfunktion zur Distanzberechnung in Metern (Haversine-Formel)
function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ==========================================
// WETTER-FRÜHWARNSYSTEM (Open-Meteo, kostenlos, kein API-Key)
// ==========================================

// WMO-Wettercodes → deutschen Kurztext
function wmoCodeToText(code) {
  if (code === 0) return 'Klar';
  if (code <= 3) return 'Bewölkt';
  if (code <= 9) return 'Nebelfelder';
  if (code <= 19) return 'Niederschlag';
  if (code <= 29) return 'Gewitter (Nähe)';
  if (code <= 39) return 'Staubnebel';
  if (code <= 49) return 'Nebel';
  if (code <= 59) return 'Nieselregen';
  if (code <= 69) return 'Regen';
  if (code <= 79) return 'Schnee / Graupel';
  if (code <= 84) return 'Schauer';
  if (code <= 94) return 'Gewitter';
  return 'Heftiger Sturm';
}

/**
 * Ruft Open-Meteo Daily-Wetterdaten ab.
 * @param {number} lat
 * @param {number} lng
 * @param {string} dateStr  ISO-Datum "YYYY-MM-DD"
 * @returns {Promise<object|null>}  Wetterdaten oder null bei Fehler / Datum > 16 Tage
 */
function fetchWeather(lat, lng, dateStr) {
  return new Promise((resolve) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr);
    const diffDays = Math.round((target - today) / 86400000);
    // Open-Meteo liefert max. 16 Tage voraus; vergangene Daten ebenfalls abrufbar
    if (diffDays > 16) return resolve(null);

    const params = new URLSearchParams({
      latitude: lat,
      longitude: lng,
      daily: 'weathercode,windspeed_10m_max,windgusts_10m_max,precipitation_sum',
      timezone: 'Europe/Berlin',
      start_date: dateStr,
      end_date: dateStr,
      wind_speed_unit: 'kmh'
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params}`;
    https.get(url, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          const d = json.daily;
          if (!d || !d.time || d.time.length === 0) return resolve(null);

          const windspeed   = d.windspeed_10m_max[0]   || 0;
          const windgusts   = d.windgusts_10m_max[0]   || 0;
          const precip      = d.precipitation_sum[0]   || 0;
          const wcode       = d.weathercode[0]         || 0;

          // Warnstufen für Kranarbeiten / Montage
          // Rot:  Böen ≥ 55 km/h ODER Dauerregen ≥ 10 mm ODER Gewitter
          // Gelb: Böen ≥ 40 km/h ODER Niederschlag ≥ 5 mm ODER starker Regen
          let warningLevel = 'ok'; // 'ok' | 'warn' | 'danger'
          if (windgusts >= 55 || precip >= 10 || wcode >= 80) warningLevel = 'danger';
          else if (windgusts >= 40 || precip >= 5 || wcode >= 61) warningLevel = 'warn';

          resolve({
            windspeed: Math.round(windspeed),
            windgusts: Math.round(windgusts),
            precipitation: Math.round(precip * 10) / 10,
            weathercode: wcode,
            weatherText: wmoCodeToText(wcode),
            warningLevel
          });
        } catch (e) {
          resolve(null);
        }
      });
      resp.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

const { verifyToken, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// EJS & Middleware Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'Public')));

// Öffentliche Routen (Login / Logout)
app.use('/', authRoutes);

// ALLE DARAUFFOLGENDEN ROUTEN SCHÜTZEN
app.use(verifyToken);
app.use('/documents', documentRoutes);

// ==========================================
// DASHBOARD (Rollenspezifisch: Chef vs. Mitarbeiter)
// ==========================================
app.get('/', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    if (userRole !== 'ADMIN') {
      const now = new Date();

      // Aktueller Monat – Grenzen berechnen
      const curYear  = now.getFullYear();
      const curMonth = now.getMonth(); // 0-based
      const monthStart = new Date(curYear, curMonth, 1);
      const monthEnd   = new Date(curYear, curMonth + 1, 0); // letzter Tag

      const sqlMonthLogs = isPg
        ? `SELECT time_logs.*,
                  TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ?
           AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')
               BETWEEN ? AND ?
           ORDER BY timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ?
           AND date(timestamp) BETWEEN ? AND ?
           ORDER BY timestamp ASC`;
      const monthStr = `${curYear}-${String(curMonth + 1).padStart(2, '0')}`;
      const monthStartStr = `${monthStr}-01`;
      const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
      const monthEndStr  = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;

      const result = await dbQuery(sqlMonthLogs, [userId, monthStartStr, monthEndStr]);
      const logs = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn = false;

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const currentLogTime = new Date((logs[i].local_timestamp || logs[i].timestamp).replace(' ', 'T'));
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const nextLog = logs[i + 1];
            const startTime = currentLogTime.getTime();
            let endTime;

            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
              endTime = new Date((nextLog.local_timestamp || nextLog.timestamp).replace(' ', 'T')).getTime();
            } else if (i === logs.length - 1) {
              endTime = now.getTime();
            } else {
              endTime = startTime;
            }

            if (endTime > startTime) {
              totalMilliseconds += (endTime - startTime);
            }
          } else if (logs[i].type === 'OUT') {
            isStampedIn = false;
          }
        }
      }

      const monthTotalHours = (totalMilliseconds / 3600000).toFixed(2);

      // ── Soll-Stunden: Werktage (Mo–Fr) im laufenden Monat bis heute ──────
      const dailyHours = 8; // Standard-Arbeitstag
      let workdaysSoFar = 0;
      const todayDate = new Date(curYear, curMonth, now.getDate());
      for (let d = 1; d <= now.getDate(); d++) {
        const dow = new Date(curYear, curMonth, d).getDay();
        if (dow !== 0 && dow !== 6) workdaysSoFar++;
      }
      const targetHours    = workdaysSoFar * dailyHours;
      const overtimeHours  = parseFloat(monthTotalHours) - targetHours; // positiv = Über, negativ = Minus
      const overtimeAbs    = Math.abs(overtimeHours);
      const overtimeH      = Math.floor(overtimeAbs);
      const overtimeM      = Math.round((overtimeAbs - overtimeH) * 60);

      // Ampel-Logik: grün = ±2h, gelb = -2 bis -6h, rot = < -6h
      let trafficLight, trafficColor, trafficBorder, trafficBg, trafficText;
      if (overtimeHours >= -2) {
        trafficLight  = '🟢';
        trafficColor  = 'text-emerald-700';
        trafficBorder = 'border-emerald-500';
        trafficBg     = 'bg-emerald-50';
        trafficText   = overtimeHours >= 0
          ? `+${overtimeH} Std. ${overtimeM} Min. Überstunden`
          : `${overtimeH} Std. ${overtimeM} Min. unter Soll (OK)`;
      } else if (overtimeHours >= -6) {
        trafficLight  = '🟡';
        trafficColor  = 'text-amber-700';
        trafficBorder = 'border-amber-400';
        trafficBg     = 'bg-amber-50';
        trafficText   = `−${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      } else {
        trafficLight  = '🔴';
        trafficColor  = 'text-red-700';
        trafficBorder = 'border-red-500';
        trafficBg     = 'bg-red-50';
        trafficText   = `−${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      }

      // Fortschrittsbalken: wie viel % der Soll-Zeit ist erreicht?
      const progressPct = targetHours > 0
        ? Math.min(120, Math.round((parseFloat(monthTotalHours) / targetHours) * 100))
        : 0;
      const progressColor = overtimeHours >= -2 ? '#10b981' : overtimeHours >= -6 ? '#f59e0b' : '#ef4444';

      // Wochenstunden berechnen (ab Montag dieser Woche)
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=Mo
      const mondayStart = new Date(now);
      mondayStart.setHours(0, 0, 0, 0);
      mondayStart.setDate(mondayStart.getDate() - dayOfWeek);

      let weekMs = 0;
      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const t = new Date((logs[i].local_timestamp || logs[i].timestamp).replace(' ', 'T'));
          if (t < mondayStart) continue;
          if (logs[i].type !== 'IN') continue;
          const start = t.getTime();
          const next = logs[i + 1];
          let end;
          if (next && next.type === 'OUT') {
            end = new Date((next.local_timestamp || next.timestamp).replace(' ', 'T')).getTime();
          } else if (i === logs.length - 1) {
            end = now.getTime();
          } else {
            end = start;
          }
          if (end > start) weekMs += (end - start);
        }
      }
      const weekTotalHours = (weekMs / 3600000).toFixed(2);

      const stats = {
        monthTotalHours, weekTotalHours, isStampedIn,
        targetHours, overtimeHours: overtimeHours.toFixed(2),
        trafficLight, trafficColor, trafficBorder, trafficBg, trafficText,
        progressPct, progressColor,
        monthLabel: now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
      };
      const recentLogs = [...logs].reverse().slice(0, 5);

      // Ticker für Mitarbeiter laden
      const tickerRes = await dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 5');

      res.render('dashboard-employee', { stats, recentLogs, tickers: tickerRes.rows || [] });

    } else {
      // ── Offene Angebote ─────────────────────────────────────────
      const sqlOffers = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
        FROM documents
        WHERE doc_type = 'OFFER' AND status != 'ANGENOMMEN' AND status != 'ABGELEHNT'
      `;
      // ── Unbezahlte Rechnungen ───────────────────────────────────
      const sqlInvoices = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
        FROM invoices
        WHERE status != 'Bezahlt'
      `;
      // ── Kunden Gesamt ───────────────────────────────────────────
      const sqlCustomers = `SELECT COUNT(*) as count FROM customers`;

      // ── Aktive Aufträge ─────────────────────────────────────────
      const sqlActiveProjects = `
        SELECT COUNT(*) as count FROM projects
        WHERE status NOT IN ('Abgeschlossen')
      `;

      // ── Fällige Rechnungen (Fälligkeitsdatum <= heute) ──────────
      const sqlOverdueInvoices = isPg
        ? `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
           FROM invoices
           WHERE status != 'Bezahlt'
             AND due_date IS NOT NULL AND due_date != ''
             AND due_date::date <= CURRENT_DATE`
        : `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
           FROM invoices
           WHERE status != 'Bezahlt'
             AND due_date IS NOT NULL AND due_date != ''
             AND due_date <= date('now')`;

      // ── Offene Aufgaben / Mängel ────────────────────────────────
      const sqlOpenTasks = `
        SELECT COUNT(*) as count FROM project_tasks
        WHERE status = 'Offen'
      `;

      // ── Letzte Vorgänge ─────────────────────────────────────────
      const sqlRecentDocs = `
        SELECT * FROM (
          SELECT documents.id, documents.doc_number, 'OFFER' as doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person
          FROM documents
          LEFT JOIN customers ON documents.customer_id = customers.id
          UNION ALL
          SELECT invoices.id, invoices.invoice_number as doc_number, 'INVOICE' as doc_type, invoices.total_amount, invoices.status, customers.company_name, customers.contact_person
          FROM invoices
          LEFT JOIN customers ON invoices.customer_id = customers.id
        ) combined
        ORDER BY id DESC LIMIT 5
      `;

      const [offerRes, invoiceRes, customerRes, activeProjectsRes, overdueRes, openTasksRes, recentDocsRes, tickerRes, settingsRes] = await Promise.all([
        dbQuery(sqlOffers),
        dbQuery(sqlInvoices),
        dbQuery(sqlCustomers),
        dbQuery(sqlActiveProjects),
        dbQuery(sqlOverdueInvoices),
        dbQuery(sqlOpenTasks),
        dbQuery(sqlRecentDocs),
        dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 10'),
        dbQuery('SELECT settings_json FROM user_settings WHERE user_id = ?', [userId]),
      ]);

      const fmt = (n) => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 });

      const stats = {
        openOffersCount:      offerRes.rows[0]?.count ?? 0,
        openOffersSum:        fmt(offerRes.rows[0]?.total),
        openInvoicesCount:    invoiceRes.rows[0]?.count ?? 0,
        openInvoicesSum:      fmt(invoiceRes.rows[0]?.total),
        totalCustomers:       customerRes.rows[0]?.count ?? 0,
        activeProjectsCount:  activeProjectsRes.rows[0]?.count ?? 0,
        overdueInvoicesCount: overdueRes.rows[0]?.count ?? 0,
        overdueInvoicesSum:   fmt(overdueRes.rows[0]?.total),
        openTasksCount:       openTasksRes.rows[0]?.count ?? 0,
      };

      const formattedDocs = (recentDocsRes.rows || []).map(doc => ({
        ...doc,
        customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
      }));

      // Widget-Einstellungen aus DB laden (Fallback: alle sichtbar)
      let widgetSettings = {};
      if (settingsRes.rows[0]?.settings_json) {
        try { widgetSettings = JSON.parse(settingsRes.rows[0].settings_json); } catch (_) {}
      }

      res.render('dashboard', { stats, recentDocs: formattedDocs, tickers: tickerRes.rows || [], widgetSettings });
    }
  } catch (err) {
    console.error('Fehler im Dashboard:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// WIDGET-EINSTELLUNGEN (DB-basiert)
// ==========================================
app.post('/api/user-settings', async (req, res) => {
  try {
    const userId = req.user.id;
    const { settings } = req.body; // { w-openOffers: true, ... }
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'Ungültige Daten' });

    const json = JSON.stringify(settings);
    const sql = isPg
      ? `INSERT INTO user_settings (user_id, settings_json, updated_at)
         VALUES (?, ?, NOW())
         ON CONFLICT (user_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()`
      : `INSERT INTO user_settings (user_id, settings_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = datetime('now')`;

    await dbQuery(sql, [userId, json]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Fehler beim Speichern der Widget-Einstellungen:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==========================================
// BAUSTELLEN-FOTOS (Abschlussfotos)
// ==========================================
app.post('/projects/:id/photos/upload', upload.single('photo'), async (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.redirect(`/projects/${projectId}`);

  try {
    const sql = `INSERT INTO project_photos (project_id, file_url, original_name) VALUES (?, ?, ?)`;
    await dbQuery(sql, [projectId, req.file.path, req.file.originalname]);
  } catch (err) {
    console.error('Fehler beim Foto-Upload:', err.message);
  }
  res.redirect(`/projects/${projectId}`);
});

// ==========================================
// DIGITALES AUFMASS (Mobil / Baustelle)
// ==========================================
app.post('/projects/:id/measurements/add', async (req, res) => {
  const projectId = req.params.id;
  const { component_name, width, height, angle, quantity, note } = req.body;

  if (!component_name) return res.redirect(`/projects/${projectId}`);

  try {
    const sql = `
      INSERT INTO project_measurements (project_id, component_name, width, height, angle, quantity, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    await dbQuery(sql, [
      projectId, 
      component_name, 
      width || null, 
      height || null, 
      angle || null, 
      parseInt(quantity || '1', 10), 
      note || null
    ]);
  } catch (err) {
    console.error('Fehler beim Speichern des Aufmaßes:', err.message);
  }
  res.redirect(`/projects/${projectId}`);
});

app.post('/projects/measurements/delete', async (req, res) => {
  const { measurement_id, project_id } = req.body;
  try {
    await dbQuery('DELETE FROM project_measurements WHERE id = ?', [measurement_id]);
  } catch (err) {
    console.error('Fehler beim Löschen des Aufmaßes:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// BAUSTELLEN-NOTIZBUCH
// ==========================================
app.post('/projects/:id/notes/add', async (req, res) => {
  const projectId = req.params.id;
  const { note_text } = req.body;

  if (!note_text || note_text.trim() === '') return res.redirect(`/projects/${projectId}`);

  try {
    const sql = `INSERT INTO project_notes (project_id, note_text) VALUES (?, ?)`;
    await dbQuery(sql, [projectId, note_text.trim()]);
  } catch (err) {
    console.error('Fehler beim Speichern der Notiz:', err.message);
  }
  res.redirect(`/projects/${projectId}`);
});

app.post('/projects/notes/delete', async (req, res) => {
  const { note_id, project_id } = req.body;
  try {
    await dbQuery('DELETE FROM project_notes WHERE id = ?', [note_id]);
  } catch (err) {
    console.error('Fehler beim Löschen der Notiz:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// BAUSTELLEN-FOTOS LÖSCHEN
// ==========================================
app.post('/projects/photos/delete', async (req, res) => {
  const { photo_id, project_id } = req.body;
  try {
    await dbQuery('DELETE FROM project_photos WHERE id = ?', [photo_id]);
  } catch (err) {
    console.error('Fehler beim Löschen des Fotos:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// PROJEKT-DATEIEN LÖSCHEN
// ==========================================
app.post('/projects/files/delete', async (req, res) => {
  const { file_id, project_id } = req.body;
  try {
    await dbQuery('DELETE FROM project_files WHERE id = ?', [file_id]);
  } catch (err) {
    console.error('Fehler beim Löschen der Datei:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// KUNDEN-DATEIEN LÖSCHEN
// ==========================================
app.post('/customers/files/delete', async (req, res) => {
  const { file_id, customer_id } = req.body;
  try {
    await dbQuery('DELETE FROM customer_files WHERE id = ?', [file_id]);
  } catch (err) {
    console.error('Fehler beim Löschen der Kundendatei:', err.message);
  }
  res.redirect(`/customers/${customer_id}/projects`);
});

// ==========================================
// ZEITERFASSUNG / STEMPELUHR
// ==========================================
app.get('/timetracking', async (req, res) => {
  const userId = req.user.id;

  try {
    const sqlToday = isPg
      ? `SELECT time_logs.*, customers.company_name, customers.contact_person,
                projects.title as project_title,
                TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
         FROM time_logs
         LEFT JOIN customers ON time_logs.customer_id = customers.id
         LEFT JOIN projects ON time_logs.project_id = projects.id
         WHERE time_logs.user_id = ? AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = CURRENT_DATE
         ORDER BY time_logs.timestamp ASC`
      : `SELECT time_logs.*, customers.company_name, customers.contact_person,
                projects.title as project_title,
                strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
         FROM time_logs
         LEFT JOIN customers ON time_logs.customer_id = customers.id
         LEFT JOIN projects ON time_logs.project_id = projects.id
         WHERE time_logs.user_id = ? AND date(timestamp) = date('now')
         ORDER BY time_logs.timestamp ASC`;
    const result = await dbQuery(sqlToday, [userId]);
    const todayLogs = result.rows;

    const lastLog = todayLogs && todayLogs.length > 0 ? todayLogs[todayLogs.length - 1] : null;
    const isStampedIn = lastLog && lastLog.type === 'IN';
    
    let lastStampTime = '';
    if (isStampedIn && lastLog && lastLog.local_timestamp) {
      const parts = lastLog.local_timestamp.split(' ')[1].split(':');
      lastStampTime = `${parts[0]}:${parts[1]}`;
    }

    let totalMilliseconds = 0;
    const now = new Date();

    if (todayLogs && todayLogs.length > 0) {
      for (let i = 0; i < todayLogs.length; i++) {
        if (!todayLogs[i].local_timestamp) continue;
        const currentLogTime = new Date(todayLogs[i].local_timestamp.replace(' ', 'T'));
        
        if (todayLogs[i].type === 'IN') {
          const nextLog = todayLogs[i + 1];
          const startTime = currentLogTime.getTime();
          let endTime;

          if (nextLog && nextLog.type === 'OUT' && nextLog.local_timestamp) {
            endTime = new Date(nextLog.local_timestamp.replace(' ', 'T')).getTime();
          } else if (i === todayLogs.length - 1 && isStampedIn) {
            endTime = now.getTime();
          } else {
            endTime = startTime;
          }

          if (endTime > startTime) {
            totalMilliseconds += (endTime - startTime);
          }
        }
      }
    }

    const todayTotalHours = (totalMilliseconds / (1000 * 60 * 60)).toFixed(2);

    const formattedLogs = todayLogs.map(log => ({
      ...log,
      display_time: log.local_timestamp ? log.local_timestamp.split(' ')[1].substring(0, 5) : ''
    }));

    // Alle aktiven Projekte für das Dropdown
    const projectsRes = await dbQuery(`
      SELECT projects.id, projects.title, projects.status,
             projects.site_lat, projects.site_lng, projects.site_radius,
             customers.id as customer_id, customers.company_name, customers.contact_person
      FROM projects
      LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.status != 'Abgeschlossen'
      ORDER BY projects.title ASC
    `);

    const allProjects = projectsRes.rows || [];
    // Geo-Fencing: nur Projekte mit Koordinaten (fürs clientseitige JS)
    const geoProjects = allProjects.filter(p => p.site_lat && p.site_lng);

    // Aktives Projekt aus dem letzten IN-Eintrag ermitteln
    const activeProjectId   = isStampedIn && lastLog ? (lastLog.project_id   || null) : null;
    const activeProjectTitle = isStampedIn && lastLog ? (lastLog.project_title || null) : null;

    res.render('timetracking', {
      todayLogs: formattedLogs,
      isStampedIn,
      lastStampTime,
      todayTotalHours,
      projects: allProjects,
      geoProjects,
      activeProjectId,
      activeProjectTitle
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/timetracking/stamp', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  let { type, note, project_id, latitude, longitude } = req.body;

  // SWITCH = erst OUT (altes Projekt), dann IN (neues Projekt) in einem Request
  if (type === 'SWITCH') {
    // 1. OUT ohne Projekt eintragen (aktuelles Projekt automatisch beendet)
    try {
      const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
      await dbQuery(
        `INSERT INTO time_logs (user_id, type, note, latitude, longitude, timestamp) VALUES (?, 'OUT', ?, ?, ?, ${tsExpr})`,
        [userId, 'Baustelle gewechselt', latitude || null, longitude || null]
      );
    } catch (_) {}
    // 2. Weiter als normales IN
    type = 'IN';
  }

  if (!['IN', 'OUT'].includes(type)) {
    return res.status(400).send('Ungültiger Stempel-Typ');
  }

  // GPS-Prüfung: Firma ODER bekannte Baustelle
  if (type === 'IN' && userRole !== 'ADMIN') {
    if (!latitude || !longitude) {
      return res.status(400).send('Standort konnte nicht ermittelt werden. GPS ist für das Einstempeln erforderlich.');
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    // 1. Firmensitz prüfen
    const FIRM_LAT = parseFloat(process.env.FIRM_LAT || '51.3069467');
    const FIRM_LNG = parseFloat(process.env.FIRM_LNG || '6.9483845');
    const FIRM_RADIUS = parseInt(process.env.FIRM_RADIUS_METERS || '300', 10);
    const distFirm = getDistanceFromLatLonInMeters(lat, lng, FIRM_LAT, FIRM_LNG);
    const atFirm = distFirm <= FIRM_RADIUS;

    // 2. Baustellen prüfen (alle Projekte mit Koordinaten)
    let atSite = false;
    if (!atFirm) {
      const siteRes = await dbQuery(`
        SELECT id, site_lat, site_lng, site_radius FROM projects
        WHERE site_lat IS NOT NULL AND site_lng IS NOT NULL AND status != 'Abgeschlossen'
      `);
      for (const proj of (siteRes.rows || [])) {
        const d = getDistanceFromLatLonInMeters(lat, lng, parseFloat(proj.site_lat), parseFloat(proj.site_lng));
        if (d <= (proj.site_radius || 200)) { atSite = true; break; }
      }
    }

    if (!atFirm && !atSite) {
      return res.status(400).send(`Einstempeln verweigert: Du befindest dich weder an der Firma noch auf einer bekannten Baustelle (ca. ${Math.round(distFirm)} m von der Firma entfernt).`);
    }
  }

  // Projekt → customer_id ableiten
  let assignedProjectId = project_id && project_id !== '' ? parseInt(project_id, 10) : null;
  let assignedCustomerId = null;
  if (assignedProjectId) {
    try {
      const pRes = await dbQuery('SELECT customer_id FROM projects WHERE id = ?', [assignedProjectId]);
      assignedCustomerId = pRes.rows[0]?.customer_id || null;
    } catch (_) {}
  }

  try {
    const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
    const sql = `INSERT INTO time_logs (user_id, type, note, project_id, customer_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ${tsExpr})`;
    await dbQuery(sql, [userId, type, note || null, assignedProjectId, assignedCustomerId, latitude || null, longitude || null]);
    res.redirect('/timetracking');
  } catch (err) {
    try {
      const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
      const fallbackSql = `INSERT INTO time_logs (user_id, type, note, project_id, customer_id, timestamp) VALUES (?, ?, ?, ?, ?, ${tsExpr})`;
      await dbQuery(fallbackSql, [userId, type, note || null, assignedProjectId, assignedCustomerId]);
      res.redirect('/timetracking');
    } catch (fallbackErr) {
      console.error('Fehler beim Stempeln:', fallbackErr.message);
      res.status(500).send('Fehler beim Speichern der Stempelzeit');
    }
  }
});

app.post('/timetracking/admin/delete', verifyToken, requireAdmin, async (req, res) => {
  const { log_id } = req.body;
  try {
    await dbQuery('DELETE FROM time_logs WHERE id = ?', [log_id]);
    res.redirect('back');
  } catch (err) {
    console.error('Fehler beim Löschen des Stempel-Eintrags:', err.message);
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// URLAUBSVERWALTUNG (Vacations)
// ==========================================
app.get('/vacations', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    let vacationsRes;
    if (userRole === 'ADMIN') {
      vacationsRes = await dbQuery(`
        SELECT vacations.*, users.username
        FROM vacations
        JOIN users ON vacations.user_id = users.id
        ORDER BY vacations.created_at DESC
      `);
    } else {
      vacationsRes = await dbQuery(`
        SELECT vacations.*, users.username
        FROM vacations
        JOIN users ON vacations.user_id = users.id
        WHERE vacations.user_id = ?
        ORDER BY vacations.created_at DESC
      `, [userId]);
    }

    const usersRes = await dbQuery('SELECT id, username, role, COALESCE(vacation_allowance, 30) as vacation_allowance FROM users ORDER BY username ASC');

    // Urlaubskonto: verbrauchte Urlaubstage (genehmigte Urlaube) pro User berechnen
    const currentYear = new Date().getFullYear();
    const vacationBalances = {};
    for (const u of (usersRes.rows || [])) {
      const approvedRes = await dbQuery(
        `SELECT start_date, end_date FROM vacations WHERE user_id = ? AND type = 'Urlaub' AND status = 'Genehmigt'`,
        [u.id]
      );
      let usedDays = 0;
      for (const v of (approvedRes.rows || [])) {
        const start = new Date(v.start_date);
        const end = new Date(v.end_date);
        // Nur Tage des aktuellen Jahres zählen
        if (end.getFullYear() < currentYear || start.getFullYear() > currentYear) continue;
        const s = new Date(Math.max(start, new Date(currentYear, 0, 1)));
        const e = new Date(Math.min(end, new Date(currentYear, 11, 31)));
        // Arbeitstage (Mo–Fr) zählen
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
          const dow = d.getDay();
          if (dow !== 0 && dow !== 6) usedDays++;
        }
      }
      vacationBalances[u.id] = {
        allowance: u.vacation_allowance || 30,
        used: usedDays,
        remaining: (u.vacation_allowance || 30) - usedDays
      };
    }

    res.render('vacations', {
      vacations: vacationsRes.rows || [],
      users: usersRes.rows || [],
      user: req.user,
      currentUser: req.user,
      vacationBalances,
      currentYear
    });
  } catch (err) {
    console.error('Fehler beim Laden der Urlaubsübersicht:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/vacations/add', upload.single('document'), async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, start_date, end_date, reason } = req.body;
    
    let fileUrl = null;
    if (req.file) {
      fileUrl = req.file.path; 
    }

    const sql = `
      INSERT INTO vacations (user_id, type, start_date, end_date, reason, file_url, status) 
      VALUES (?, ?, ?, ?, ?, ?, 'Beantragt')
    `;
    
    await dbQuery(sql, [
      userId, 
      type || 'Urlaub', 
      start_date, 
      end_date, 
      reason || null, 
      fileUrl
    ]);

    res.redirect('/vacations');
  } catch (err) {
    console.error('Fehler beim Speichern des Urlaubsantrags:', err.message);
    res.status(500).send("Fehler beim Speichern der Abwesenheit.");
  }
});

app.post('/vacations/status', verifyToken, requireAdmin, async (req, res) => {
  const { id, status } = req.body;
  try {
    await dbQuery('UPDATE vacations SET status = ? WHERE id = ?', [status, id]);
    res.redirect('/vacations');
  } catch (err) {
    console.error('Fehler beim Aktualisieren des Urlaubsstatus:', err.message);
    res.status(500).send('Fehler beim Aktualisieren des Status');
  }
});

app.post('/vacations/delete', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM vacations WHERE id = ?', [id]);
    res.redirect('/vacations');
  } catch (err) {
    console.error('Fehler beim Löschen des Urlaubsantrags:', err.message);
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// ADMIN ZEITERFASSUNG & ZEITEN NACHTRAGEN
// ==========================================
app.get('/admin/timetracking', verifyToken, requireAdmin, async (req, res) => {
  try {
    const activeTab    = req.query.tab || 'daily';
    const selectedDate = req.query.date || '';
    const selectedUserId = req.query.user_id || '';

    const usersRes = await dbQuery('SELECT id, username FROM users ORDER BY username ASC');
    const users = usersRes.rows || [];

    // ── Tab 1: Tagesansicht (alle Einträge, filterbar) ──────────────────────
    const tsCol = isPg
      ? `TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')`
      : `strftime('%Y-%m-%d %H:%M:%S', time_logs.timestamp)`;
    const dateFilter = isPg
      ? `DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')`
      : `date(time_logs.timestamp)`;

    let logsQuery = `SELECT time_logs.*, users.username, ${tsCol} as local_timestamp
      FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1`;
    const logsParams = [];

    if (selectedDate) {
      logsQuery += ` AND ${dateFilter} = ?`;
      logsParams.push(selectedDate);
    }
    if (selectedUserId) {
      logsQuery += ` AND time_logs.user_id = ?`;
      logsParams.push(selectedUserId);
    }
    logsQuery += ` ORDER BY time_logs.timestamp DESC`;

    const logsResult = await dbQuery(logsQuery, logsParams);
    const logs = (logsResult.rows || []).map(log => ({
      ...log,
      timestamp: log.local_timestamp || log.timestamp
    }));

    // ── Tab 2: Monatsauswertung (KPIs + Einträge für gewählten MA/Monat) ────
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const monthUserId = req.query.month_user_id || (users.length > 0 ? users[0].id : req.user.id);
    const dailyHours = parseFloat(req.query.daily_hours || '8');

    const monthlyEntriesRes = await dbQuery(
      isPg
        ? `SELECT time_logs.*, TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ? AND to_char(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
           ORDER BY time_logs.timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ? AND strftime('%Y-%m', timestamp) = ?
           ORDER BY time_logs.timestamp ASC`,
      [monthUserId, month]
    );
    const monthlyEntries = (monthlyEntriesRes.rows || []).map(e => ({
      ...e,
      timestamp: e.local_timestamp || e.timestamp
    }));

    // Gearbeitete Stunden aus IN/OUT-Paaren
    let workedMs = 0;
    for (let i = 0; i < monthlyEntries.length; i++) {
      if (monthlyEntries[i].type !== 'IN') continue;
      const start = new Date(monthlyEntries[i].timestamp).getTime();
      const next  = monthlyEntries[i + 1];
      if (next && next.type === 'OUT') {
        const end = new Date(next.timestamp).getTime();
        if (end > start) workedMs += (end - start);
      }
    }
    const workedHours = workedMs / 3600000;

    // Werktage im Monat (Mo–Fr)
    const [yyyy, mm] = month.split('-').map(Number);
    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    let workdaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(yyyy, mm - 1, d).getDay();
      if (dow !== 0 && dow !== 6) workdaysInMonth++;
    }
    const targetHours   = workdaysInMonth * dailyHours;
    const overtimeHours = workedHours - targetHours;

    res.render('admin-timetracking', {
      // Gemeinsam
      users,
      user: req.user,
      activeTab,
      // Tab 1 – Tagesansicht
      logs,
      selectedDate,
      selectedUserId,
      // Tab 2 – Monatsauswertung
      month,
      monthUserId,
      monthlyEntries,
      dailyHours,
      workedHours:   workedHours.toFixed(2),
      targetHours:   targetHours.toFixed(2),
      overtimeHours: overtimeHours.toFixed(2)
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err);
    res.status(500).send('Fehler beim Laden der Zeiterfassung');
  }
});

app.post('/admin/timetracking/add', verifyToken, requireAdmin, async (req, res) => {
  const { user_id, type, date, time, note } = req.body;

  if (!user_id || !type || !date || !time) {
    return res.status(400).send('Alle Pflichtfelder müssen ausgefüllt werden.');
  }

  try {
    const timestampString = `${date} ${time}:00`;

    const sql = isPg
      ? `INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, (TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS') AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'UTC')`
      : `INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, ?)`;
    
    await dbQuery(sql, [user_id, type, note || null, timestampString]);
    res.redirect('/admin/timetracking');
  } catch (err) {
    console.error('Fehler beim Nachtragen der Arbeitszeit:', err.message);
    res.status(500).send('Fehler beim Speichern des Eintrags.');
  }
});

app.get('/admin/timetracking/pdf', verifyToken, requireAdmin, async (req, res) => {
  const { user_id, date } = req.query;

  try {
    const tsColPdf = isPg
      ? `TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')`
      : `strftime('%Y-%m-%d %H:%M:%S', time_logs.timestamp)`;
    const dateFilterPdf = isPg
      ? `DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')`
      : `date(time_logs.timestamp)`;

    let query = `SELECT time_logs.*, users.username, ${tsColPdf} as local_timestamp
      FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1`;
    let queryParams = [];

    if (user_id) {
      query += ` AND time_logs.user_id = ?`;
      queryParams.push(user_id);
    }

    if (date) {
      query += ` AND ${dateFilterPdf} = ?`;
      queryParams.push(date);
    }

    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    const logs = (result.rows || []).map(log => ({
      ...log,
      timestamp: log.local_timestamp || log.timestamp
    }));

    let employeeName = 'Alle Mitarbeiter';
    if (user_id) {
      const userRes = await dbQuery('SELECT username FROM users WHERE id = ?', [user_id]);
      if (userRes.rows && userRes.rows.length > 0) {
        employeeName = userRes.rows[0].username;
      }
    }

    if (!PDFKit) {
      return res.status(500).send('PDF-Generator Modul ist nicht geladen.');
    }

    const doc = new PDFKit({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Arbeitszeiten_${employeeName.replace(/\s+/g, '_')}.pdf`);

    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Arbeitszeiten-Übersicht', { align: 'left' });
    doc.fontSize(12).font('Helvetica').text(`Mitarbeiter: ${employeeName}`, { align: 'left' });
    if (date) {
      doc.text(`Datum: ${date}`, { align: 'left' });
    }
    doc.fontSize(9).text(`Erstellt am: ${new Date().toLocaleDateString('de-DE')}`, { align: 'left' });
    doc.moveDown(1.5);

    doc.fontSize(10).font('Helvetica-Bold');
    let startY = doc.y;
    doc.text('Datum / Uhrzeit', 50, startY, { width: 130 });
    doc.text('Aktion', 185, startY, { width: 150 });
    doc.text('Notiz', 345, startY, { width: 200 });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.8);

    doc.font('Helvetica').fontSize(9);
    if (logs && logs.length > 0) {
      logs.forEach(log => {
        const logDate = new Date(log.timestamp).toLocaleString('de-DE', {
          dateStyle: 'short',
          timeStyle: 'short'
        });
        const actionText = log.type === 'IN' ? 'Eingestempelt (IN)' : 'Ausgestempelt (OUT)';
        const noteText = log.note || '-';

        if (doc.y > 750) {
          doc.addPage();
        }

        const rowY = doc.y;
        doc.text(logDate, 50, rowY, { width: 130, lineBreak: false });
        doc.text(actionText, 185, rowY, { width: 150, lineBreak: false });
        doc.text(noteText, 345, rowY, { width: 200 });
        
        doc.moveDown(1.2);
      });
    } else {
      doc.text('Keine Einträge für diesen Filter gefunden.', 50, doc.y);
    }

    doc.end();

  } catch (err) {
    console.error('Fehler beim PDF-Export:', err.message);
    res.status(500).send('Fehler beim Generieren der PDF.');
  }
});

app.get('/timetracking/admin/monthly', async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    const month = req.query.month || new Date().toISOString().slice(0, 7);

    let users = [];
    if (role === 'ADMIN') {
      const userRes = await dbQuery('SELECT id, username FROM users');
      users = userRes.rows;
    }

    const targetUserId = req.query.user_id || userId;

    const entriesRes = await dbQuery(
      isPg
        ? `SELECT time_logs.*, TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ? AND to_char(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
           ORDER BY time_logs.timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ? AND strftime('%Y-%m', timestamp) = ?
           ORDER BY time_logs.timestamp ASC`,
      [targetUserId, month]
    );
    
    const entries = (entriesRes.rows || []).map(e => ({
      ...e,
      timestamp: e.local_timestamp || e.timestamp
    }));

    // Überstunden-Berechnung: Gearbeitete Stunden vs. Soll (8h pro Werktag)
    let workedMs = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type !== 'IN') continue;
      const start = new Date(entries[i].timestamp).getTime();
      const next = entries[i + 1];
      if (next && next.type === 'OUT') {
        const end = new Date(next.timestamp).getTime();
        if (end > start) workedMs += (end - start);
      }
    }
    const workedHours = workedMs / 3600000;

    // Anzahl Werktage (Mo–Fr) im gewählten Monat
    const [yyyy, mm] = month.split('-').map(Number);
    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    let workdaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(yyyy, mm - 1, d).getDay();
      if (dow !== 0 && dow !== 6) workdaysInMonth++;
    }
    const dailyHours = parseFloat(req.query.daily_hours || '8');
    const targetHours = workdaysInMonth * dailyHours;
    const overtimeHours = workedHours - targetHours;

    res.render('time-monthly', {
      currentUser: req.user,
      users,
      entries,
      selectedMonth: month,
      selectedUserId: targetUserId,
      workedHours: workedHours.toFixed(2),
      targetHours: targetHours.toFixed(2),
      overtimeHours: overtimeHours.toFixed(2),
      dailyHours
    });
  } catch (err) {
    console.error('Fehler bei Monatsauswertung:', err);
    res.status(500).send('Interner Serverfehler');
  }
});

app.get('/timetracking/admin/export-csv', async (req, res) => {
  try {
    const targetUserId = req.query.user_id || req.user.id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const logsRes = await dbQuery(
      isPg
        ? `SELECT t.*, u.username, TO_CHAR(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs t JOIN users u ON t.user_id = u.id
           WHERE t.user_id = ? AND to_char(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
           ORDER BY t.timestamp ASC`
        : `SELECT t.*, u.username, strftime('%Y-%m-%d %H:%M:%S', t.timestamp) as local_timestamp
           FROM time_logs t JOIN users u ON t.user_id = u.id
           WHERE t.user_id = ? AND strftime('%Y-%m', t.timestamp) = ?
           ORDER BY t.timestamp ASC`,
      [targetUserId, month]
    );
    const entries = logsRes.rows || [];

    let csv = 'Mitarbeiter;Datum;Typ;Notiz;Zeitpunkt\n';

    entries.forEach(e => {
      const dateObj = new Date(e.local_timestamp || e.timestamp);
      const dateStr = dateObj.toLocaleDateString('de-DE');
      const timeStr = dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const typeStr = e.type === 'IN' ? 'Kommen (IN)' : 'Gehen (OUT)';

      csv += `"${e.username}","${dateStr}","${typeStr}","${e.note || ''}","${timeStr}"\n`;
    });

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`Zeiterfassung_${month}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Fehler beim CSV-Export:', err);
    res.status(500).send('Fehler beim Generieren der CSV-Datei.');
  }
});

// ==========================================
// KUNDENVERWALTUNG & UPLOAD (Cloudinary)
// ==========================================
app.post('/customers/edit', async (req, res) => {
  const { id, company_name, contact_person, email, phone, street, zip, city } = req.body;
  try {
    const sql = `
      UPDATE customers 
      SET company_name = ?, contact_person = ?, email = ?, phone = ?, street = ?, zip = ?, city = ?
      WHERE id = ?
    `;
    await dbQuery(sql, [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null, id]);
    res.redirect('/customers');
  } catch (err) {
    res.status(500).send('Fehler beim Aktualisieren');
  }
});

app.post('/customers/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM customers WHERE id = ?', [id]);
    res.redirect('/customers');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

app.get('/customers/:id/projects', async (req, res) => {
  const { id } = req.params;
  try {
    const custRes = await dbQuery('SELECT * FROM customers WHERE id = ?', [id]);
    const customer = custRes.rows[0];
    if (!customer) return res.status(404).send('Kunde nicht gefunden');

    const offersRes = await dbQuery("SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'OFFER' ORDER BY created_at DESC", [id]);
    const invoicesRes = await dbQuery("SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC", [id]);
    const appointmentsRes = await dbQuery("SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC", [id]);
    const filesRes = await dbQuery("SELECT * FROM customer_files WHERE customer_id = ? ORDER BY created_at DESC", [id]);

    res.render('customer-projects', {
      customer,
      offers: offersRes.rows || [],
      invoices: invoicesRes.rows || [],
      appointments: appointmentsRes.rows || [],
      files: filesRes.rows || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/customers/:id/upload', upload.single('file'), async (req, res) => {
  const customer_id = req.params.id;
  if (!req.file) return res.redirect(`/customers/${customer_id}/projects`);

  try {
    const sql = `INSERT INTO customer_files (customer_id, filename, original_name, file_type, file_url) VALUES (?, ?, ?, ?, ?)`;
    await dbQuery(sql, [customer_id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.path]);
  } catch (err) {
    console.error('Fehler beim Dateiupload:', err.message);
  }
  res.redirect(`/customers/${customer_id}/projects`);
});

app.get('/customers', async (req, res) => {
  try {
    const result = await dbQuery('SELECT * FROM customers ORDER BY created_at DESC');
    res.render('customers', { customers: result.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/customers/add', async (req, res) => {
  const { company_name, contact_person, email, phone, street, zip, city } = req.body;
  try {
    const sql = `
      INSERT INTO customers (company_name, contact_person, email, phone, street, zip, city)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    await dbQuery(sql, [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null]);
    res.redirect('/customers');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// ANGEBOTSVERWALTUNG & UMWANDLUNG
// ==========================================
app.get('/documents/offers', async (req, res) => {
  try {
    const query = `
      SELECT documents.*, customers.company_name, customers.contact_person 
      FROM documents 
      LEFT JOIN customers ON documents.customer_id = customers.id
      WHERE doc_type = 'OFFER'
      ORDER BY documents.created_at DESC`;
      
    const offersRes = await dbQuery(query);
    const customersRes = await dbQuery('SELECT * FROM customers');
    const articlesRes = await dbQuery('SELECT * FROM articles ORDER BY title ASC');

    res.render('offers', { 
      offers: offersRes.rows || [], 
      customers: customersRes.rows || [],
      articles: articlesRes.rows || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/documents/create-offer', async (req, res) => {
  let { customer_id, title, quantity, unit, price } = req.body;
  const docNumber = 'ANG-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);

  const titles = Array.isArray(title) ? title : [title];
  const quantities = Array.isArray(quantity) ? quantity : [quantity];
  const units = Array.isArray(unit) ? unit : [unit];
  const prices = Array.isArray(price) ? price : [price];

  let totalAmount = 0;
  const itemsToInsert = [];

  for (let i = 0; i < titles.length; i++) {
    if (!titles[i] || titles[i].trim() === '') continue;

    const parsedQty = parseFloat(String(quantities[i] || '1').replace(',', '.')) || 1;
    const parsedPrice = parseFloat(String(prices[i] || '0').replace(',', '.')) || 0;

    totalAmount += parsedQty * parsedPrice;

    itemsToInsert.push({
      description: titles[i],
      quantity: parsedQty,
      unit: units[i] || 'Stk',
      price: parsedPrice
    });
  }

  try {
    const sqlOffer = `
      INSERT INTO documents (doc_type, doc_number, customer_id, total_amount, status)
      VALUES ('OFFER', ?, ?, ?, 'GESENDET')
    `;
    const offerInsertRes = await dbQuery(sqlOffer, [docNumber, customer_id, totalAmount]);
    const offerId = offerInsertRes.lastID;

    if (offerId) {
      for (const item of itemsToInsert) {
        await dbQuery('INSERT INTO offer_items (offer_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)', 
          [offerId, item.description, item.quantity, item.unit, item.price]);
      }
    }

    res.redirect('/documents/offers');
  } catch (err) {
    console.error('❌ Fehler beim Erstellen des Angebots:', err.message);
    res.status(500).send('Fehler beim Speichern des Angebots');
  }
});

app.post('/documents/offers/delete', async (req, res) => {
  const { offer_id } = req.body;
  try {
    await dbQuery(`DELETE FROM offer_items WHERE offer_id = ?`, [offer_id]);
    await dbQuery(`DELETE FROM documents WHERE id = ? AND doc_type = 'OFFER'`, [offer_id]);
    res.redirect('/documents/offers');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen des Angebots');
  }
});

app.post('/documents/offers/convert-to-invoice', async (req, res) => {
  const { offer_id } = req.body;
  try {
    const offerRes = await dbQuery("SELECT * FROM documents WHERE id = ? AND doc_type = 'OFFER'", [offer_id]);
    const offer = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden');

    const invoiceNumber = 'RE-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 14);

    const sqlInvoice = `
      INSERT INTO invoices (invoice_number, customer_id, total_amount, status, due_date)
      VALUES (?, ?, ?, 'Gesendet', ?)
    `;
    const invRes = await dbQuery(sqlInvoice, [invoiceNumber, offer.customer_id, offer.total_amount, dueDate.toISOString().split('T')[0]]);
    const invoiceId = invRes.lastID;

    const itemsRes = await dbQuery('SELECT * FROM offer_items WHERE offer_id = ?', [offer_id]);
    const items = itemsRes.rows;

    if (!items || items.length === 0) {
      await dbQuery(
        "INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, 1, 'Psch', ?)",
        [invoiceId, 'Übernahme aus Angebot #' + offer.doc_number, offer.total_amount]
      );
    } else {
      for (const item of items) {
        await dbQuery('INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)',
          [invoiceId, item.description, item.quantity, item.unit, item.price]);
      }
    }

    await dbQuery("UPDATE documents SET status = 'ANGENOMMEN' WHERE id = ?", [offer_id]);
    res.redirect('/documents/invoices/' + invoiceId);
  } catch (err) {
    res.status(500).send('Fehler beim Umwandeln des Angebots');
  }
});

// ==========================================
// RECHNUNGSVERWALTUNG & MAHNWESEN
// ==========================================

// PDF-Download für Angebote (PDFKit)
app.get('/documents/offers/:id/pdf', async (req, res) => {
  const { id } = req.params;
  try {
    if (!PDFKit) return res.status(500).send('PDFKit nicht geladen.');

    const offerRes = await dbQuery(`
      SELECT documents.*, customers.company_name, customers.contact_person,
             customers.street, customers.zip, customers.city, customers.email, customers.phone
      FROM documents
      LEFT JOIN customers ON documents.customer_id = customers.id
      WHERE documents.id = ? AND documents.doc_type = 'OFFER'`, [id]);
    const offer = offerRes.rows[0];
    if (!offer) return res.status(404).send('Angebot nicht gefunden');

    const itemsRes = await dbQuery('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY id ASC', [id]);
    const items = itemsRes.rows || [];

    const doc = new PDFKit({ margin: 50, size: 'A4' });
    const safeNum = (offer.doc_number || 'Angebot').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Angebot_${safeNum}.pdf`);
    doc.pipe(res);

    const L = 50, W = 495;
    const today = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const customerName = offer.company_name || offer.contact_person || '-';
    const addr = [offer.street, [offer.zip, offer.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

    // Briefkopf
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#1e293b').text('METALLBAU GEHRMANN', L, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('Stahlbau - Edelstahlverarbeitung - Gelaender & Tore', L, 74);
    doc.moveTo(L, 88).lineTo(L + W, 88).lineWidth(1.5).strokeColor('#3b82f6').stroke();

    // Angebots-Box rechts
    doc.rect(360, 50, 185, 60).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#64748b').text('ANGEBOTS-NR.', 368, 56);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e293b').text(offer.doc_number || '-', 368, 67);
    doc.fontSize(8).font('Helvetica').fillColor('#64748b').text(`Datum: ${today}`, 368, 84);
    doc.text(`Status: ${offer.status || 'Offen'}`, 368, 94);

    // Empfaenger
    let y = 110;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#94a3b8').text('EMPFAENGER', L, y);
    y += 12;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(customerName, L, y);
    y += 14;
    doc.fontSize(9).font('Helvetica').fillColor('#475569');
    if (addr) { doc.text(addr, L, y); y += 13; }
    if (offer.email) { doc.text(offer.email, L, y); y += 13; }
    y += 10;

    // Betreff
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e293b').text(`Angebot ${offer.doc_number}`, L, y);
    y += 22;
    doc.fontSize(9).font('Helvetica').fillColor('#475569')
      .text('Sehr geehrte Damen und Herren,\nvielen Dank fuer Ihre Anfrage. Wir unterbreiten Ihnen folgendes Angebot:', L, y, { width: W });
    y += 36;

    // Tabellen-Header
    doc.rect(L, y, W, 18).fillColor('#1e293b').fill();
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff');
    doc.text('Pos.', L + 4, y + 5, { width: 25 });
    doc.text('Bezeichnung', L + 30, y + 5, { width: 230 });
    doc.text('Menge', L + 265, y + 5, { width: 55, align: 'right' });
    doc.text('Einzelpreis', L + 325, y + 5, { width: 75, align: 'right' });
    doc.text('Gesamt', L + 405, y + 5, { width: 80, align: 'right' });
    y += 22;

    // Positionen
    let subtotalOffer = 0;
    doc.fontSize(9).font('Helvetica').fillColor('#1e293b');
    items.forEach((item, idx) => {
      if (y > 720) { doc.addPage(); y = 50; }
      const rowTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0);
      subtotalOffer += rowTotal;
      const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
      doc.rect(L, y - 2, W, 18).fillColor(bg).fill();
      doc.fillColor('#1e293b');
      doc.text(String(idx + 1), L + 4, y + 2, { width: 25 });
      doc.text(item.description || '-', L + 30, y + 2, { width: 230 });
      doc.text(`${parseFloat(item.quantity || 1).toLocaleString('de-DE')} ${item.unit || ''}`, L + 265, y + 2, { width: 55, align: 'right' });
      doc.text(`${parseFloat(item.price || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, L + 325, y + 2, { width: 75, align: 'right' });
      doc.text(`${rowTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, L + 405, y + 2, { width: 80, align: 'right' });
      y += 20;
    });

    // Summenblock
    y += 8;
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    y += 10;
    const taxOffer = subtotalOffer * 0.19;
    const grandOffer = subtotalOffer + taxOffer;
    const col1o = L + 300;
    doc.fontSize(9).font('Helvetica').fillColor('#64748b');
    doc.text('Zwischensumme (Netto):', col1o, y, { width: 100 });
    doc.text(`${subtotalOffer.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, col1o + 100, y, { width: 90, align: 'right' });
    y += 16;
    doc.text('19% MwSt.:', col1o, y, { width: 100 });
    doc.text(`${taxOffer.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, col1o + 100, y, { width: 90, align: 'right' });
    y += 8;
    doc.moveTo(col1o, y).lineTo(L + W - 5, y).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    y += 8;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b');
    doc.text('Gesamtbetrag (Brutto):', col1o, y, { width: 100 });
    doc.text(`${grandOffer.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, col1o + 100, y, { width: 90, align: 'right' });

    // Fusszeile
    y += 40;
    if (y > 720) { doc.addPage(); y = 50; }
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
    y += 10;
    doc.fontSize(8).font('Helvetica').fillColor('#94a3b8');
    doc.text('Dieses Angebot ist 30 Tage gueltig. Bei Fragen stehen wir Ihnen gerne zur Verfuegung.', L, y, { width: W });
    y += 16;
    doc.text('Mit freundlichen Gruessen - Metallbau Gehrmann', L, y, { width: W });

    doc.end();
  } catch (err) {
    console.error('Fehler beim Angebots-PDF:', err);
    res.status(500).send('Fehler beim Erstellen des PDFs');
  }
});

// PDF-Download fuer Rechnungen (PDFKit)
app.get('/documents/invoices/:id/pdf-download', async (req, res) => {
  const { id } = req.params;
  try {
    if (!PDFKit) return res.status(500).send('PDFKit nicht geladen.');

    const invRes = await dbQuery(`
      SELECT invoices.*, customers.company_name, customers.contact_person,
             customers.street, customers.zip, customers.city, customers.email, customers.phone
      FROM invoices
      LEFT JOIN customers ON invoices.customer_id = customers.id
      WHERE invoices.id = ?`, [id]);
    const invoice = invRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden');

    const itemsRes = await dbQuery('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC', [id]);
    const items = itemsRes.rows || [];

    const doc = new PDFKit({ margin: 50, size: 'A4' });
    const safeNum = (invoice.invoice_number || 'Rechnung').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Rechnung_${safeNum}.pdf`);
    doc.pipe(res);

    const L = 50, W = 495;
    const today = new Date(invoice.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const dueStr = invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'sofort';
    const customerName = invoice.company_name || invoice.contact_person || '-';
    const addr = [invoice.street, [invoice.zip, invoice.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

    // Briefkopf
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#1e293b').text('METALLBAU GEHRMANN', L, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('Stahlbau - Edelstahlverarbeitung - Gelaender & Tore', L, 74);
    doc.moveTo(L, 88).lineTo(L + W, 88).lineWidth(1.5).strokeColor('#3b82f6').stroke();

    // Rechnungs-Box rechts
    const boxBg = invoice.dunning_level > 0 ? '#fef2f2' : '#f8fafc';
    const boxBorder = invoice.dunning_level > 0 ? '#fca5a5' : '#cbd5e1';
    doc.rect(360, 50, 185, 72).lineWidth(0.5).strokeColor(boxBorder).fillAndStroke(boxBg, boxBorder);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#64748b').text('RECHNUNGS-NR.', 368, 56);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(invoice.invoice_number, 368, 67);
    doc.fontSize(8).font('Helvetica').fillColor('#64748b').text(`Datum: ${today}`, 368, 82);
    doc.text(`Faellig: ${dueStr}`, 368, 92);
    doc.text(`Status: ${invoice.status}`, 368, 102);

    // Mahnung-Banner
    if (invoice.dunning_level > 0) {
      const mahnText = invoice.dunning_level === 1 ? '1. ZAHLUNGSERINNERUNG' : invoice.dunning_level === 2 ? '2. MAHNUNG' : '3. LETZTE MAHNUNG';
      doc.rect(L, 50, 295, 20).fillColor('#fef2f2').fill();
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#dc2626').text(mahnText, L + 4, 55, { width: 290 });
    }

    // Empfaenger
    let y = 130;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#94a3b8').text('EMPFAENGER', L, y);
    y += 12;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(customerName, L, y);
    y += 14;
    doc.fontSize(9).font('Helvetica').fillColor('#475569');
    if (invoice.company_name && invoice.contact_person) { doc.text(`z. Hd. ${invoice.contact_person}`, L, y); y += 13; }
    if (addr) { doc.text(addr, L, y); y += 13; }
    if (invoice.email) { doc.text(invoice.email, L, y); y += 13; }
    y += 10;

    // Betreff
    const betreff = invoice.dunning_level > 0
      ? `Mahnung zu Rechnung ${invoice.invoice_number}`
      : `Rechnung Nr. ${invoice.invoice_number}`;
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e293b').text(betreff, L, y);
    y += 22;
    if (!invoice.dunning_level || invoice.dunning_level === 0) {
      doc.fontSize(9).font('Helvetica').fillColor('#475569')
        .text('Sehr geehrte Damen und Herren,\nwir erlauben uns, folgende Leistungen in Rechnung zu stellen:', L, y, { width: W });
    } else {
      doc.fontSize(9).font('Helvetica').fillColor('#dc2626')
        .text(`Trotz unserer Rechnung vom ${today} haben wir bisher keinen Zahlungseingang verzeichnen koennen. Wir bitten um umgehende Zahlung.`, L, y, { width: W });
    }
    y += 36;

    // Tabellen-Header
    doc.rect(L, y, W, 18).fillColor('#1e293b').fill();
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff');
    doc.text('Pos.', L + 4, y + 5, { width: 25 });
    doc.text('Bezeichnung', L + 30, y + 5, { width: 230 });
    doc.text('Menge', L + 265, y + 5, { width: 55, align: 'right' });
    doc.text('Einzelpreis', L + 325, y + 5, { width: 75, align: 'right' });
    doc.text('Gesamt', L + 405, y + 5, { width: 80, align: 'right' });
    y += 22;

    // Positionen
    let subtotalInv = 0;
    doc.fontSize(9).font('Helvetica').fillColor('#1e293b');
    items.forEach((item, idx) => {
      if (y > 700) { doc.addPage(); y = 50; }
      const rowTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0);
      subtotalInv += rowTotal;
      const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
      doc.rect(L, y - 2, W, 18).fillColor(bg).fill();
      doc.fillColor('#1e293b');
      doc.text(String(idx + 1), L + 4, y + 2, { width: 25 });
      doc.text(item.description || '-', L + 30, y + 2, { width: 230 });
      doc.text(`${parseFloat(item.quantity || 1).toLocaleString('de-DE')} ${item.unit || ''}`, L + 265, y + 2, { width: 55, align: 'right' });
      doc.text(`${parseFloat(item.price || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, L + 325, y + 2, { width: 75, align: 'right' });
      doc.text(`${rowTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, L + 405, y + 2, { width: 80, align: 'right' });
      y += 20;
    });

    // Summenblock
    y += 8;
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    y += 10;
    const taxInv = subtotalInv * 0.19;
    const grandInv = subtotalInv + taxInv;
    const col1i = L + 300;
    doc.fontSize(9).font('Helvetica').fillColor('#64748b');
    doc.text('Zwischensumme (Netto):', col1i, y, { width: 100 });
    doc.text(`${subtotalInv.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, col1i + 100, y, { width: 90, align: 'right' });
    y += 16;
    doc.text('19% MwSt.:', col1i, y, { width: 100 });
    doc.text(`${taxInv.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, col1i + 100, y, { width: 90, align: 'right' });
    y += 8;
    doc.moveTo(col1i, y).lineTo(L + W - 5, y).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    y += 8;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b');
    doc.text('Gesamtbetrag (Brutto):', col1i, y, { width: 100 });
    doc.text(`${grandInv.toLocaleString('de-DE', { minimumFractionDigits: 2 })} EUR`, col1i + 100, y, { width: 90, align: 'right' });

    // Bankdaten & Fusszeile
    y += 40;
    if (y > 700) { doc.addPage(); y = 50; }
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
    y += 12;
    doc.fontSize(8).font('Helvetica').fillColor('#475569');
    doc.text(`Bitte ueberweisen Sie den Betrag unter Angabe der Rechnungsnummer ${invoice.invoice_number} innerhalb von 14 Tagen.`, L, y, { width: W });
    y += 20;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e293b').text('Bankverbindung:', L, y);
    doc.font('Helvetica').fillColor('#475569').text('  IBAN: DE12 3456 7890 1234 5678 90  -  BIC: MUBADE12  -  Musterbank DE', L + 80, y, { width: 370 });

    doc.end();
  } catch (err) {
    console.error('Fehler beim Rechnungs-PDF:', err);
    res.status(500).send('Fehler beim Erstellen des PDFs');
  }
});

app.get('/documents/invoices/:id/pdf', async (req, res) => {
  const { id } = req.params;
  try {
    const sqlInvoice = `
      SELECT invoices.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city 
      FROM invoices 
      LEFT JOIN customers ON invoices.customer_id = customers.id
      WHERE invoices.id = ?
    `;
    const invRes = await dbQuery(sqlInvoice, [id]);
    const invoice = invRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden');

    const itemsRes = await dbQuery('SELECT * FROM invoice_items WHERE invoice_id = ?', [id]);
    res.render('invoice-pdf', { invoice, items: itemsRes.rows || [] });
  } catch (err) {
    res.status(500).send('Fehler beim Laden der PDF-Ansicht');
  }
});

app.get('/documents/invoices/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const sqlInvoice = `
      SELECT invoices.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city 
      FROM invoices 
      LEFT JOIN customers ON invoices.customer_id = customers.id
      WHERE invoices.id = ?
    `;
    const invRes = await dbQuery(sqlInvoice, [id]);
    const invoice = invRes.rows[0];
    if (!invoice) return res.status(404).send('Rechnung nicht gefunden');

    const itemsRes = await dbQuery('SELECT * FROM invoice_items WHERE invoice_id = ?', [id]);
    res.render('invoice-detail', { invoice, items: itemsRes.rows || [] });
  } catch (err) {
    res.status(500).send('Fehler beim Laden der Rechnung');
  }
});

app.get('/documents/invoices', async (req, res) => {
  const statusFilter = req.query.status;
  try {
    let sqlInvoices = `
      SELECT invoices.*, customers.company_name, customers.contact_person 
      FROM invoices 
      LEFT JOIN customers ON invoices.customer_id = customers.id
    `;
    let params = [];

    if (statusFilter && statusFilter !== 'Alle') {
      sqlInvoices += " WHERE invoices.status = ?";
      params.push(statusFilter);
    }

    sqlInvoices += " ORDER BY invoices.created_at DESC";

    const invRes = await dbQuery(sqlInvoices, params);
    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');
    const artRes = await dbQuery('SELECT * FROM articles ORDER BY title ASC');

    res.render('invoices', {
      invoices: invRes.rows || [],
      customers: custRes.rows || [],
      articles: artRes.rows || [],
      currentStatus: statusFilter || 'Alle'
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/documents/create-invoice', async (req, res) => {
  let { customer_id, title, quantity, unit, price, due_days } = req.body;
  const invoiceNumber = 'RE-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);

  const titles = Array.isArray(title) ? title : [title];
  const quantities = Array.isArray(quantity) ? quantity : [quantity];
  const units = Array.isArray(unit) ? unit : [unit];
  const prices = Array.isArray(price) ? price : [price];

  let totalAmount = 0;
  const itemsToInsert = [];

  for (let i = 0; i < titles.length; i++) {
    if (!titles[i] || titles[i].trim() === '') continue;

    const parsedQty = parseFloat(String(quantities[i] || '1').replace(',', '.')) || 1;
    const parsedPrice = parseFloat(String(prices[i] || '0').replace(',', '.')) || 0;

    totalAmount += parsedQty * parsedPrice;

    itemsToInsert.push({
      description: titles[i],
      quantity: parsedQty,
      unit: units[i] || 'Stk',
      price: parsedPrice
    });
  }

  const days = parseInt(due_days || '14', 10);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + days);

  try {
    const sqlInvoice = `
      INSERT INTO invoices (invoice_number, customer_id, total_amount, status, due_date)
      VALUES (?, ?, ?, 'Gesendet', ?)
    `;
    const invRes = await dbQuery(sqlInvoice, [invoiceNumber, customer_id, totalAmount, dueDate.toISOString().split('T')[0]]);
    const invoiceId = invRes.lastID;

    if (invoiceId) {
      for (const item of itemsToInsert) {
        await dbQuery('INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)',
          [invoiceId, item.description, item.quantity, item.unit, item.price]);
      }
    }

    res.redirect('/documents/invoices');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern der Rechnung');
  }
});

app.post('/documents/invoices/increase-dunning', async (req, res) => {
  const { invoice_id } = req.body;
  try {
    const sql = `UPDATE invoices SET dunning_level = dunning_level + 1, status = 'Überfällig' WHERE id = ?`;
    await dbQuery(sql, [invoice_id]);
    res.redirect('/documents/invoices');
  } catch (err) {
    res.status(500).send('Fehler beim Aktualisieren');
  }
});

app.post('/documents/invoices/update-status', async (req, res) => {
  const { invoice_id, status, status_note } = req.body;
  try {
    const sql = `UPDATE invoices SET status = ?, status_note = ? WHERE id = ?`;
    await dbQuery(sql, [status, status_note || null, invoice_id]);
    res.redirect('/documents/invoices');
  } catch (err) {
    res.status(500).send('Fehler beim Aktualisieren');
  }
});

app.post('/documents/invoices/delete', async (req, res) => {
  const { invoice_id } = req.body;
  try {
    await dbQuery(`DELETE FROM invoice_items WHERE invoice_id = ?`, [invoice_id]);
    await dbQuery(`DELETE FROM invoices WHERE id = ?`, [invoice_id]);
    res.redirect('/documents/invoices');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// ARTIKEL- & MATERIALSTAMM
// ==========================================
app.get('/articles', async (req, res) => {
  try {
    const result = await dbQuery('SELECT * FROM articles ORDER BY title ASC');
    res.render('articles', { articles: result.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/articles/add', async (req, res) => {
  const { title, unit, unit_price, description } = req.body;
  const parsedPrice = String(unit_price).replace(',', '.');
  try {
    const sql = `INSERT INTO articles (title, unit, unit_price, description) VALUES (?, ?, ?, ?)`;
    await dbQuery(sql, [title, unit, parseFloat(parsedPrice) || 0, description || null]);
    res.redirect('/articles');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern');
  }
});

app.post('/articles/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM articles WHERE id = ?', [id]);
    res.redirect('/articles');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// KALENDER & TERMINE
// ==========================================
app.get('/calendar', async (req, res) => {
  try {
    const result = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');
    res.render('calendar', { customers: result.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// GET /api/weather?lat=&lng=&date=YYYY-MM-DD
app.get('/api/weather', async (req, res) => {
  const { lat, lng, date } = req.query;
  if (!lat || !lng || !date) return res.status(400).json({ error: 'lat, lng und date erforderlich' });
  try {
    const weather = await fetchWeather(parseFloat(lat), parseFloat(lng), date);
    if (!weather) return res.json({ available: false });
    res.json({ available: true, ...weather });
  } catch (e) {
    res.status(500).json({ error: 'Wetterdaten nicht abrufbar' });
  }
});

app.get('/api/appointments', async (req, res) => {
  try {
    // Koordinaten des Termins: Firmenstandort des Projekts (falls vorhanden), sonst Firmensitz aus Env
    const FIRM_LAT = parseFloat(process.env.FIRM_LAT || '51.3069467');
    const FIRM_LNG = parseFloat(process.env.FIRM_LNG || '6.9483845');

    const query = `
      SELECT appointments.id, appointments.title, appointments.start_date as start,
             appointments.end_date as end, appointments.description,
             customers.company_name, customers.contact_person,
             projects.site_lat, projects.site_lng
      FROM appointments
      LEFT JOIN customers ON appointments.customer_id = customers.id
      LEFT JOIN projects ON projects.customer_id = appointments.customer_id
        AND projects.site_lat IS NOT NULL AND projects.site_lng IS NOT NULL
    `;
    const result = await dbQuery(query);
    const rows = result.rows || [];

    // Wetter parallel für alle Termine mit bekanntem Datum abrufen
    const weatherPromises = rows.map(app => {
      if (!app.start) return Promise.resolve(null);
      const dateStr = app.start.split('T')[0];
      const lat = app.site_lat || FIRM_LAT;
      const lng = app.site_lng || FIRM_LNG;
      return fetchWeather(lat, lng, dateStr);
    });
    const weatherResults = await Promise.all(weatherPromises);

    const events = rows.map((app, i) => {
      const w = weatherResults[i];
      // FullCalendar Ereignisfarbe je Warnstufe
      let backgroundColor, borderColor, textColor;
      if (w && w.warningLevel === 'danger') {
        backgroundColor = '#fee2e2'; borderColor = '#dc2626'; textColor = '#7f1d1d';
      } else if (w && w.warningLevel === 'warn') {
        backgroundColor = '#fef9c3'; borderColor = '#ca8a04'; textColor = '#713f12';
      } else {
        backgroundColor = '#dbeafe'; borderColor = '#2563eb'; textColor = '#1e3a5f';
      }

      return {
        id: app.id,
        title: `${app.title} (${app.company_name || app.contact_person || 'Privat'})`,
        start: app.start,
        end: app.end,
        description: app.description,
        backgroundColor,
        borderColor,
        textColor,
        extendedProps: { weather: w || null }
      };
    });
    res.json(events);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post('/api/appointments/add', async (req, res) => {
  const { title, customer_id, start_date, end_date, description } = req.body;
  try {
    const sql = `
      INSERT INTO appointments (title, customer_id, start_date, end_date, description)
      VALUES (?, ?, ?, ?, ?)
    `;
    await dbQuery(sql, [title, customer_id || null, start_date, end_date || null, description]);
    res.redirect('/calendar');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern');
  }
});

app.post('/api/appointments/delete/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await dbQuery('DELETE FROM appointments WHERE id = ?', [id]);
    res.redirect('/calendar');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// AUFTRÄGE & BAUSTELLEN
// ==========================================
app.get('/projects', async (req, res) => {
  try {
    const sql = `
      SELECT projects.*, customers.company_name, customers.contact_person, customers.street, customers.city
      FROM projects
      LEFT JOIN customers ON projects.customer_id = customers.id
      ORDER BY projects.created_at DESC
    `;
    const projRes = await dbQuery(sql);
    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');
    res.render('projects', { projects: projRes.rows || [], customers: custRes.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/projects/add', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  
  const { customer_id, title, description, total_price, status } = req.body;
  const parsedPrice = parseFloat(String(total_price || '0').replace(',', '.')) || 0;

  try {
    const sql = `
      INSERT INTO projects (customer_id, title, description, total_price, status)
      VALUES (?, ?, ?, ?, ?)
    `;
    await dbQuery(sql, [customer_id || null, title, description || null, parsedPrice, status || 'In Planung']);
    res.redirect('/projects');
  } catch (err) {
    res.status(500).send('Fehler beim Erstellen des Auftrags');
  }
});

app.post('/projects/update-status', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');

  const { id, status } = req.body;
  try {
    await dbQuery('UPDATE projects SET status = ? WHERE id = ?', [status, id]);
    res.redirect('back');
  } catch (err) {
    console.error('Fehler beim Aktualisieren des Status:', err.message);
    res.status(500).send('Fehler beim Aktualisieren des Status');
  }
});

app.post('/projects/:id/edit', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id } = req.params;
  const { title, description, total_price, status } = req.body;
  const parsedPrice = parseFloat(String(total_price || '0').replace(',', '.')) || 0;

  try {
    await dbQuery(
      'UPDATE projects SET title = ?, description = ?, total_price = ?, status = ? WHERE id = ?',
      [title, description || null, parsedPrice, status || 'In Planung', id]
    );
    res.redirect(`/projects/${id}`);
  } catch (err) {
    console.error('Fehler beim Bearbeiten des Auftrags:', err.message);
    res.status(500).send('Fehler beim Speichern der Änderungen');
  }
});

app.get('/projects/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const sqlProject = `
      SELECT projects.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city
      FROM projects
      LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.id = ?
    `;
    const projRes = await dbQuery(sqlProject, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).send('Auftrag nicht gefunden');

    const filesRes = await dbQuery('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at DESC', [id]);
    const appRes = await dbQuery('SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC', [project.customer_id]);
    const photosRes = await dbQuery('SELECT * FROM project_photos WHERE project_id = ? ORDER BY created_at DESC', [id]);
    const measurementsRes = await dbQuery('SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at DESC', [id]);
    const notesRes = await dbQuery('SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC', [id]);
    const tasksRes = await dbQuery('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC', [id]);

    // Wetterdaten für die Termine dieses Projekts anreichern
    const FIRM_LAT = parseFloat(process.env.FIRM_LAT || '51.3069467');
    const FIRM_LNG = parseFloat(process.env.FIRM_LNG || '6.9483845');
    const appointmentsWithWeather = await Promise.all(
      (appRes.rows || []).map(async (app) => {
        if (!app.start_date) return { ...app, weather: null };
        const dateStr = app.start_date.split('T')[0];
        const lat = project.site_lat || FIRM_LAT;
        const lng = project.site_lng || FIRM_LNG;
        const weather = await fetchWeather(lat, lng, dateStr);
        return { ...app, weather };
      })
    );

    res.render('project-detail', {
      project,
      files: filesRes.rows || [],
      appointments: appointmentsWithWeather,
      photos: photosRes.rows || [],
      measurements: measurementsRes.rows || [],
      notes: notesRes.rows || [],
      tasks: tasksRes.rows || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// LIEFERSCHEIN / STUNDENNACHWEIS PDF
// ==========================================
app.get('/projects/:id/pdf', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    if (!PDFKit) return res.status(500).send('PDFKit nicht geladen.');

    // ── Projektdaten ────────────────────────────────────────────────────────
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person,
             customers.street, customers.zip, customers.city, customers.phone, customers.email
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).send('Auftrag nicht gefunden');

    // ── Arbeitsstunden des Projekts (time_logs mit customer_id des Projekts) ─
    // Fallback: alle Logs im Projekt-Zeitraum (angelegt bis heute)
    const logsRes = await dbQuery(`
      SELECT tl.*, u.username,
        TO_CHAR(tl.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_ts
      FROM time_logs tl
      JOIN users u ON tl.user_id = u.id
      WHERE tl.customer_id = ?
      ORDER BY tl.timestamp ASC`, [project.customer_id || -1]);
    const logs = logsRes.rows;

    // ── Aufmaße ─────────────────────────────────────────────────────────────
    const measRes = await dbQuery(
      'SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at ASC', [id]);

    // ── Aufgaben / Mängel ────────────────────────────────────────────────────
    const tasksRes = await dbQuery(
      'SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at ASC', [id]);

    // ── Notizen ──────────────────────────────────────────────────────────────
    const notesRes = await dbQuery(
      'SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC', [id]);

    // ── Geleistete Stunden (IN/OUT Paare) ────────────────────────────────────
    let totalWorkedMs = 0;
    const logRows = logs.map(l => ({ ...l, ts: l.local_ts || String(l.timestamp) }));
    for (let i = 0; i < logRows.length; i++) {
      if (logRows[i].type !== 'IN') continue;
      const next = logRows[i + 1];
      if (next && next.type === 'OUT') {
        const s = new Date(logRows[i].ts.replace(' ', 'T')).getTime();
        const e = new Date(next.ts.replace(' ', 'T')).getTime();
        if (e > s) totalWorkedMs += (e - s);
      }
    }
    const totalHours = (totalWorkedMs / 3600000).toFixed(2);

    // ────────────────────────────────────────────────────────────────────────
    // PDF aufbauen
    // ────────────────────────────────────────────────────────────────────────
    const doc = new PDFKit({ margin: 50, size: 'A4' });
    const safeTitle = project.title.replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '_').slice(0, 60);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=Lieferschein_${safeTitle}.pdf`);
    doc.pipe(res);

    const L = 50;   // left margin
    const W = 495;  // usable width
    const today = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // ── Kopfzeile ────────────────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#1e293b')
       .text('Metallbau-Gehrmann', L, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#64748b')
       .text('Auftragsdokumentation · Stundennachweis · Lieferschein', L, 74);

    // Trennlinie
    doc.moveTo(L, 88).lineTo(L + W, 88).lineWidth(1.5).strokeColor('#3b82f6').stroke();

    // ── Auftrag-Box (oben rechts) ────────────────────────────────────────────
    doc.rect(360, 50, 185, 60).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#64748b')
       .text('AUFTRAGS-NR.', 368, 56);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e293b')
       .text(`#${project.id}`, 368, 67);
    doc.fontSize(8).font('Helvetica').fillColor('#64748b')
       .text(`Erstellt: ${today}`, 368, 84);
    doc.text(`Status: ${project.status}`, 368, 94);

    // ── Projektdetails ────────────────────────────────────────────────────────
    doc.moveDown(0.5);
    let y = 110;
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e293b')
       .text(project.title, L, y);
    y += 20;

    const customer = project.company_name || project.contact_person || '–';
    const addr = [project.street, [project.zip, project.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

    doc.fontSize(9).font('Helvetica').fillColor('#475569');
    doc.text(`Kunde:  ${customer}`, L, y);
    if (addr) { y += 13; doc.text(`Adresse:  ${addr}`, L, y); }
    if (project.description) { y += 13; doc.text(`Beschreibung:  ${project.description}`, L, y, { width: W }); }
    y += 20;

    // ── Stundenübersicht kompakt ──────────────────────────────────────────────
    const boxW = 140;
    doc.rect(L, y, boxW, 38).lineWidth(0.5).strokeColor('#cbd5e1').fillAndStroke('#f0fdf4', '#cbd5e1');
    doc.fontSize(8).font('Helvetica').fillColor('#166534').text('Geleistete Stunden', L + 8, y + 6);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#166534').text(`${totalHours} Std.`, L + 8, y + 17);

    doc.rect(L + boxW + 10, y, boxW, 38).lineWidth(0.5).strokeColor('#cbd5e1').fillAndStroke('#eff6ff', '#cbd5e1');
    doc.fontSize(8).font('Helvetica').fillColor('#1d4ed8').text('Aufmaß-Positionen', L + boxW + 18, y + 6);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#1d4ed8').text(`${measRes.rows.length}`, L + boxW + 18, y + 17);

    doc.rect(L + (boxW + 10) * 2, y, boxW, 38).lineWidth(0.5).strokeColor('#cbd5e1').fillAndStroke('#fefce8', '#cbd5e1');
    doc.fontSize(8).font('Helvetica').fillColor('#854d0e').text('Aufgaben / Mängel', L + (boxW + 10) * 2 + 8, y + 6);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#854d0e').text(`${tasksRes.rows.length}`, L + (boxW + 10) * 2 + 8, y + 17);

    y += 55;

    // ── Hilfsfunktionen ───────────────────────────────────────────────────────
    function sectionHeader(title, yPos) {
      doc.rect(L, yPos, W, 16).fillColor('#1e293b').fill();
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff')
         .text(title.toUpperCase(), L + 6, yPos + 4);
      return yPos + 20;
    }

    function checkPage(neededHeight) {
      if (doc.y + neededHeight > 780) { doc.addPage(); return 50; }
      return doc.y;
    }

    function tableRow(cols, widths, startY, isHeader) {
      let x = L;
      doc.fontSize(8).font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
         .fillColor(isHeader ? '#475569' : '#1e293b');
      cols.forEach((text, i) => {
        doc.text(String(text ?? '–'), x + 3, startY + 3, { width: widths[i] - 6, lineBreak: false });
        x += widths[i];
      });
      // underline
      doc.moveTo(L, startY + 14).lineTo(L + W, startY + 14)
         .lineWidth(0.3).strokeColor(isHeader ? '#94a3b8' : '#e2e8f0').stroke();
      return startY + 16;
    }

    // ────────────────────────────────────────────────────────────────────────
    // ABSCHNITT 1: ARBEITSSTUNDEN DETAIL
    // ────────────────────────────────────────────────────────────────────────
    doc.y = y;
    y = checkPage(60);
    y = sectionHeader('1. Arbeitsstunden-Nachweis', y);

    const colW1 = [110, 90, 90, 85, 120];
    y = tableRow(['Datum', 'Uhrzeit', 'Typ', 'Mitarbeiter', 'Notiz'], colW1, y, true);

    if (logRows.length === 0) {
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
         .text('Keine Stempelzeiten für diesen Kunden erfasst.', L + 3, y + 3);
      y += 20;
    } else {
      logRows.forEach(log => {
        y = checkPage(20);
        const ts = log.ts || '';
        const datePart = ts.substring(0, 10).split('-').reverse().join('.');
        const timePart = ts.substring(11, 16);
        const typeLabel = log.type === 'IN' ? '▶ Kommen' : '◀ Gehen';
        y = tableRow([datePart, timePart + ' Uhr', typeLabel, log.username || '–', log.note || '–'], colW1, y, false);
      });
    }

    // Stundensumme
    y = checkPage(24);
    doc.rect(L, y, W, 18).fillColor('#f8fafc').fill();
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e293b')
       .text(`Gesamt geleistete Stunden (alle IN/OUT-Paare): ${totalHours} Std.`, L + 6, y + 5);
    y += 24;

    // ────────────────────────────────────────────────────────────────────────
    // ABSCHNITT 2: AUFMASS
    // ────────────────────────────────────────────────────────────────────────
    y = checkPage(40);
    y += 8;
    y = sectionHeader('2. Digitales Aufmaß', y);

    const colW2 = [150, 70, 80, 55, 55, 85];
    y = tableRow(['Bauteil / Element', 'Breite (mm)', 'Höhe / Länge (mm)', 'Winkel', 'Anz.', 'Bemerkung'], colW2, y, true);

    if (measRes.rows.length === 0) {
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
         .text('Keine Aufmaße erfasst.', L + 3, y + 3);
      y += 20;
    } else {
      measRes.rows.forEach(m => {
        y = checkPage(20);
        y = tableRow([
          m.component_name,
          m.width  ? m.width + ' mm'  : '–',
          m.height ? m.height + ' mm' : '–',
          m.angle  ? m.angle + '°'    : '–',
          m.quantity || 1,
          m.note || '–'
        ], colW2, y, false);
      });
    }

    // ────────────────────────────────────────────────────────────────────────
    // ABSCHNITT 3: AUFGABEN & MÄNGEL
    // ────────────────────────────────────────────────────────────────────────
    y = checkPage(40);
    y += 8;
    y = sectionHeader('3. Aufgaben & Mängel', y);

    const colW3 = [155, 80, 65, W - 155 - 80 - 65];
    y = tableRow(['Titel', 'Kategorie', 'Status', 'Beschreibung'], colW3, y, true);

    if (tasksRes.rows.length === 0) {
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
         .text('Keine Aufgaben oder Mängel erfasst.', L + 3, y + 3);
      y += 20;
    } else {
      tasksRes.rows.forEach(t => {
        y = checkPage(20);
        y = tableRow([t.title, t.category || '–', t.status || '–', t.description || '–'], colW3, y, false);
      });
    }

    // ────────────────────────────────────────────────────────────────────────
    // ABSCHNITT 4: NOTIZEN
    // ────────────────────────────────────────────────────────────────────────
    if (notesRes.rows.length > 0) {
      y = checkPage(40);
      y += 8;
      y = sectionHeader('4. Baustellen-Notizen', y);
      notesRes.rows.forEach(n => {
        y = checkPage(30);
        doc.fontSize(8).font('Helvetica').fillColor('#475569')
           .text(new Date(n.created_at).toLocaleDateString('de-DE') + '  ', L + 3, y + 2,
             { continued: true, width: 60 });
        doc.font('Helvetica').fillColor('#1e293b')
           .text(n.note_text, { width: W - 70 });
        y = doc.y + 4;
        doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
        y += 4;
      });
    }

    // ── Fußzeile auf jeder Seite ──────────────────────────────────────────────
    const pageCount = doc.bufferedPageRange ? doc.bufferedPageRange().count : 1;
    const range = doc.bufferedPageRange ? doc.bufferedPageRange() : null;
    if (range) {
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.moveTo(L, 820).lineTo(L + W, 820).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
        doc.fontSize(7).font('Helvetica').fillColor('#94a3b8')
           .text(`Metallbau-Gehrmann · Auftrag #${project.id} · ${project.title} · Seite ${i + 1} von ${range.count} · Erstellt: ${today}`,
             L, 826, { width: W, align: 'center' });
      }
    }

    doc.end();

  } catch (err) {
    console.error('Fehler beim Erzeugen des Lieferschein-PDF:', err.message);
    res.status(500).send('Fehler beim Erstellen des PDF.');
  }
});

// ==========================================
// ==========================================
// BAUSTELLENKOORDINATEN (Geo-Fencing)
// ==========================================
app.post('/projects/:id/set-location', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id } = req.params;
  const { site_lat, site_lng, site_radius } = req.body;

  try {
    await dbQuery(
      'UPDATE projects SET site_lat = ?, site_lng = ?, site_radius = ? WHERE id = ?',
      [
        site_lat && site_lat !== '' ? parseFloat(site_lat) : null,
        site_lng && site_lng !== '' ? parseFloat(site_lng) : null,
        parseInt(site_radius || '200', 10),
        id
      ]
    );
  } catch (err) {
    console.error('Fehler beim Speichern der Baustellenkoordinaten:', err.message);
  }
  res.redirect(`/projects/${id}`);
});

// ==========================================
// BAUSTELLEN-AUFGABEN & MÄNGEL
// ==========================================
app.post('/projects/:id/tasks/add', upload.single('photo'), async (req, res) => {
  const projectId = req.params.id;
  const { title, category, description } = req.body;

  if (!title || title.trim() === '') return res.redirect(`/projects/${projectId}`);

  let photoUrl = null;
  if (req.file) {
    photoUrl = req.file.path;
  }

  try {
    const sql = `
      INSERT INTO project_tasks (project_id, title, description, category, status, photo_url)
      VALUES (?, ?, ?, ?, 'Offen', ?)
    `;
    await dbQuery(sql, [
      projectId,
      title.trim(),
      description ? description.trim() : null,
      category || 'Restarbeit',
      photoUrl
    ]);
  } catch (err) {
    console.error('Fehler beim Speichern der Aufgabe:', err.message);
  }
  res.redirect(`/projects/${projectId}`);
});

app.post('/projects/tasks/status', async (req, res) => {
  const { task_id, project_id, status } = req.body;
  try {
    await dbQuery('UPDATE project_tasks SET status = ? WHERE id = ?', [status, task_id]);
  } catch (err) {
    console.error('Fehler beim Aktualisieren der Aufgabe:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

app.post('/projects/tasks/delete', async (req, res) => {
  const { task_id, project_id } = req.body;
  try {
    await dbQuery('DELETE FROM project_tasks WHERE id = ?', [task_id]);
  } catch (err) {
    console.error('Fehler beim Löschen der Aufgabe:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

app.post('/projects/:id/upload', upload.single('file'), async (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.redirect(`/projects/${projectId}`);

  try {
    const sql = `INSERT INTO project_files (project_id, filename, original_name, file_type, file_url) VALUES (?, ?, ?, ?, ?)`;
    await dbQuery(sql, [projectId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.path]);
  } catch (err) {
    console.error('Fehler beim Upload:', err.message);
  }
  res.redirect(`/projects/${projectId}`);
});

app.post('/projects/delete', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM project_files WHERE project_id = ?', [id]);
    await dbQuery('DELETE FROM projects WHERE id = ?', [id]);
    res.redirect('/projects');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// MITARBEITER-VERWALTUNG (Nur für Chefs)
// ==========================================
app.get('/admin/users', verifyToken, requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
    res.render('admin-users', { users: result.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/admin/users/add', verifyToken, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).send('Benutzername und Passwort erforderlich');

  const hashedPassword = bcrypt.hashSync(password, 10);
  const userRole = role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';

  try {
    const sql = `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`;
    await dbQuery(sql, [username, hashedPassword, userRole]);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Benutzername existiert möglicherweise bereits.');
  }
});

app.post('/admin/users/change-password', verifyToken, requireAdmin, async (req, res) => {
  const { user_id, new_password } = req.body;
  if (!user_id || !new_password || new_password.length < 6) {
    return res.status(400).send('Ungültige Eingabe. Passwort muss mindestens 6 Zeichen haben.');
  }
  const hashedPassword = bcrypt.hashSync(new_password, 10);
  try {
    await dbQuery('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, user_id]);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Fehler beim Ändern des Passworts');
  }
});

app.post('/admin/users/delete', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.body;
  if (parseInt(id) === req.user.id) {
    return res.status(400).send('Du kannst deinen eigenen Account nicht löschen.');
  }

  try {
    await dbQuery('DELETE FROM users WHERE id = ?', [id]);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// FIRMEN-TICKER (Schwarzes Brett)
// ==========================================
app.post('/ticker/add', verifyToken, requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim() === '') return res.redirect('/');
  try {
    await dbQuery(
      'INSERT INTO tickers (message, author) VALUES (?, ?)',
      [message.trim(), req.user.username]
    );
  } catch (err) {
    console.error('Fehler beim Speichern des Tickers:', err.message);
  }
  res.redirect('/');
});

app.post('/ticker/delete', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM tickers WHERE id = ?', [id]);
  } catch (err) {
    console.error('Fehler beim Löschen des Tickers:', err.message);
  }
  res.redirect('/');
});

// ==========================================
// URLAUBSKONTO – JAHRESANSPRUCH ANPASSEN
// ==========================================
app.post('/admin/users/set-vacation-allowance', verifyToken, requireAdmin, async (req, res) => {
  const { user_id, vacation_allowance } = req.body;
  const days = parseInt(vacation_allowance || '30', 10);
  try {
    await dbQuery('UPDATE users SET vacation_allowance = ? WHERE id = ?', [days, user_id]);
  } catch (err) {
    console.error('Fehler beim Setzen des Urlaubsanspruchs:', err.message);
  }
  res.redirect('/vacations');
});

// ==========================================
// GLOBALE SUCHE
// ==========================================
app.get('/api/search', verifyToken, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  const like = `%${q}%`;
  const isAdmin = req.user.role === 'ADMIN';

  try {
    // Aufträge
    const projRes = await dbQuery(`
      SELECT p.id, p.title, p.status, p.description,
             c.company_name, c.contact_person
      FROM projects p LEFT JOIN customers c ON p.customer_id = c.id
      WHERE p.title ILIKE ? OR p.description ILIKE ?
         OR c.company_name ILIKE ? OR c.contact_person ILIKE ?
      ORDER BY p.created_at DESC LIMIT 6`, [like, like, like, like]);

    // Kunden (nur Admin)
    const custRes = isAdmin ? await dbQuery(`
      SELECT id, company_name, contact_person, city, phone
      FROM customers
      WHERE company_name ILIKE ? OR contact_person ILIKE ? OR city ILIKE ?
      ORDER BY company_name ASC LIMIT 5`, [like, like, like])
      : { rows: [] };

    // Termine
    const appRes = await dbQuery(`
      SELECT a.id, a.title, a.start_date, a.description,
             c.company_name, c.contact_person
      FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id
      WHERE a.title ILIKE ? OR a.description ILIKE ?
         OR c.company_name ILIKE ? OR c.contact_person ILIKE ?
      ORDER BY a.start_date DESC LIMIT 4`, [like, like, like, like]);

    // Notizen
    const notesRes = await dbQuery(`
      SELECT n.id, n.note_text, n.project_id, p.title as project_title
      FROM project_notes n LEFT JOIN projects p ON n.project_id = p.id
      WHERE n.note_text ILIKE ?
      ORDER BY n.created_at DESC LIMIT 4`, [like]);

    const results = [
      ...projRes.rows.map(r => ({
        type: 'project', icon: '🏗️',
        label: r.title,
        sub: [r.company_name || r.contact_person, r.status].filter(Boolean).join(' · '),
        url: `/projects/${r.id}`
      })),
      ...custRes.rows.map(r => ({
        type: 'customer', icon: '👤',
        label: r.company_name || r.contact_person,
        sub: [r.contact_person, r.city].filter(Boolean).join(' · '),
        url: `/customers`
      })),
      ...appRes.rows.map(r => ({
        type: 'appointment', icon: '📅',
        label: r.title,
        sub: [r.company_name || r.contact_person,
              r.start_date ? new Date(r.start_date).toLocaleDateString('de-DE') : ''].filter(Boolean).join(' · '),
        url: `/calendar`
      })),
      ...notesRes.rows.map(r => ({
        type: 'note', icon: '📝',
        label: r.note_text.length > 70 ? r.note_text.slice(0, 70) + '…' : r.note_text,
        sub: r.project_title ? `Auftrag: ${r.project_title}` : '',
        url: r.project_id ? `/projects/${r.project_id}` : `/projects`
      }))
    ];

    res.json({ results });
  } catch (err) {
    console.error('Suche Fehler:', err.message);
    res.json({ results: [] });
  }
});

// ==========================================
// AUTOMATISCHE BEREINIGUNG DER ALTEN UPLOADS
// ==========================================
dbQuery("DELETE FROM project_files WHERE file_url LIKE '/uploads/%'").catch(() => {});
dbQuery("DELETE FROM customer_files WHERE file_url LIKE '/uploads/%'").catch(() => {});

// ==========================================
// SERVER START
// ==========================================
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Sichere Metallbau-App gestartet!`);
  console.log(`👉 Öffne im Browser: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
