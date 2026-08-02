const express = require('express');
const path = require('path');
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
      const sqlMonthLogs = isPg
        ? `SELECT time_logs.*,
                  TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ? ORDER BY timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ? ORDER BY timestamp ASC`;
      const result = await dbQuery(sqlMonthLogs, [userId]);
      const logs = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn = false;
      const now = new Date();

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const currentLogTime = new Date(logs[i].local_timestamp || logs[i].timestamp);
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const nextLog = logs[i + 1];
            const startTime = currentLogTime.getTime();
            let endTime;

            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
              endTime = new Date(nextLog.local_timestamp || nextLog.timestamp).getTime();
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

      const monthTotalHours = (totalMilliseconds / (1000 * 60 * 60)).toFixed(2);

      // Wochenstunden berechnen (ab Montag dieser Woche)
      const today = new Date();
      const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1; // 0=Mo
      const mondayStart = new Date(today);
      mondayStart.setHours(0, 0, 0, 0);
      mondayStart.setDate(mondayStart.getDate() - dayOfWeek);

      let weekMs = 0;
      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const t = new Date(logs[i].local_timestamp || logs[i].timestamp);
          if (t < mondayStart) continue;
          if (logs[i].type !== 'IN') continue;
          const start = t.getTime();
          const next = logs[i + 1];
          let end;
          if (next && next.type === 'OUT') {
            end = new Date(next.local_timestamp || next.timestamp).getTime();
          } else if (i === logs.length - 1) {
            end = now.getTime();
          } else {
            end = start;
          }
          if (end > start) weekMs += (end - start);
        }
      }
      const weekTotalHours = (weekMs / (1000 * 60 * 60)).toFixed(2);

      const stats = { monthTotalHours, weekTotalHours, isStampedIn };
      const recentLogs = [...logs].reverse().slice(0, 5);

      // Ticker für Mitarbeiter laden
      const tickerRes = await dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 5');

      res.render('dashboard-employee', { stats, recentLogs, tickers: tickerRes.rows || [] });

    } else {
      const sqlOffers = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
        FROM documents 
        WHERE doc_type = 'OFFER' AND status != 'ANGENOMMEN' AND status != 'ABGELEHNT'
      `;
      const sqlInvoices = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
        FROM invoices 
        WHERE status != 'Bezahlt'
      `;
      const sqlCustomers = `SELECT COUNT(*) as count FROM customers`;
      
      const sqlRecentDocs = `
        SELECT * FROM (
          SELECT documents.id, documents.doc_number, 'Angebot' as doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person
          FROM documents
          LEFT JOIN customers ON documents.customer_id = customers.id
          UNION ALL
          SELECT invoices.id, invoices.invoice_number as doc_number, 'Rechnung' as doc_type, invoices.total_amount, invoices.status, customers.company_name, customers.contact_person
          FROM invoices
          LEFT JOIN customers ON invoices.customer_id = customers.id
        ) combined
        ORDER BY id DESC LIMIT 5
      `;

      const offerRes = await dbQuery(sqlOffers);
      const invoiceRes = await dbQuery(sqlInvoices);
      const customerRes = await dbQuery(sqlCustomers);
      const recentDocsRes = await dbQuery(sqlRecentDocs);

      const offerData = offerRes.rows[0];
      const invoiceData = invoiceRes.rows[0];
      const customerData = customerRes.rows[0];

      const stats = {
        openOffersCount: offerData ? offerData.count : 0,
        openOffersSum: offerData ? Number(offerData.total).toLocaleString('de-DE', { minimumFractionDigits: 2 }) : '0,00',
        openInvoicesCount: invoiceData ? invoiceData.count : 0,
        openInvoicesSum: invoiceData ? Number(invoiceData.total).toLocaleString('de-DE', { minimumFractionDigits: 2 }) : '0,00',
        totalCustomers: customerData ? customerData.count : 0
      };

      const formattedDocs = (recentDocsRes.rows || []).map(doc => ({
        ...doc,
        customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
      }));

      // Ticker für Admin-Dashboard laden
      const tickerRes = await dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 10');

      res.render('dashboard', { stats, recentDocs: formattedDocs, tickers: tickerRes.rows || [] });
    }
  } catch (err) {
    console.error('Fehler im Dashboard:', err.message);
    res.status(500).send('Datenbankfehler');
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
                TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
         FROM time_logs LEFT JOIN customers ON time_logs.customer_id = customers.id
         WHERE time_logs.user_id = ? AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = CURRENT_DATE
         ORDER BY time_logs.timestamp ASC`
      : `SELECT time_logs.*, customers.company_name, customers.contact_person,
                strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
         FROM time_logs LEFT JOIN customers ON time_logs.customer_id = customers.id
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

    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');

    // Aktive Projekte mit Baustellenkoordinaten für clientseitiges Geo-Fencing laden
    const geoRes = await dbQuery(`
      SELECT projects.id, projects.title, projects.site_lat, projects.site_lng, projects.site_radius,
             customers.id as customer_id, customers.company_name, customers.contact_person
      FROM projects
      LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.status != 'Abgeschlossen'
        AND projects.site_lat IS NOT NULL
        AND projects.site_lng IS NOT NULL
    `);

    res.render('timetracking', {
      todayLogs: formattedLogs,
      isStampedIn,
      lastStampTime,
      todayTotalHours,
      customers: custRes.rows || [],
      geoProjects: geoRes.rows || []
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/timetracking/stamp', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const { type, note, customer_id, latitude, longitude } = req.body;

  if (!['IN', 'OUT'].includes(type)) {
    return res.status(400).send('Ungültiger Stempel-Typ');
  }

  if (type === 'IN' && userRole !== 'ADMIN') {
    if (!latitude || !longitude) {
      return res.status(400).send('Standort konnte nicht ermittelt werden. GPS ist für das Einstempeln erforderlich.');
    }

    const FIRM_LAT = parseFloat(process.env.FIRM_LAT || '51.3069467');
    const FIRM_LNG = parseFloat(process.env.FIRM_LNG || '6.9483845');
    const MAX_DISTANCE_METERS = parseInt(process.env.FIRM_RADIUS_METERS || '300', 10);

    const distance = getDistanceFromLatLonInMeters(
      parseFloat(latitude), 
      parseFloat(longitude), 
      FIRM_LAT, 
      FIRM_LNG
    );

    if (distance > MAX_DISTANCE_METERS) {
      return res.status(400).send(`Einstempeln verweigert: Du bist ca. ${Math.round(distance)} Meter von der Firma entfernt (Erlaubt: max. ${MAX_DISTANCE_METERS}m).`);
    }
  }

  const assignedCustomerId = customer_id && customer_id !== '' ? customer_id : null;

  try {
    const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
    const sql = `INSERT INTO time_logs (user_id, type, note, customer_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, ${tsExpr})`;
    await dbQuery(sql, [userId, type, note || null, assignedCustomerId, latitude || null, longitude || null]);
    res.redirect('/timetracking');
  } catch (err) {
    try {
      const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
      const fallbackSql = `INSERT INTO time_logs (user_id, type, note, customer_id, timestamp) VALUES (?, ?, ?, ?, ${tsExpr})`;
      await dbQuery(fallbackSql, [userId, type, note || null, assignedCustomerId]);
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
    const selectedDate = req.query.date;
    const selectedUserId = req.query.user_id;

    const usersRes = await dbQuery('SELECT id, username FROM users ORDER BY username ASC');
    const users = usersRes.rows || [];

    const tsCol = isPg
      ? `TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')`
      : `strftime('%Y-%m-%d %H:%M:%S', time_logs.timestamp)`;
    const dateFilter = isPg
      ? `DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')`
      : `date(time_logs.timestamp)`;

    let query = `SELECT time_logs.*, users.username, ${tsCol} as local_timestamp
      FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1`;
    let queryParams = [];

    if (selectedDate) {
      query += ` AND ${dateFilter} = ?`;
      queryParams.push(selectedDate);
    }

    if (selectedUserId) {
      query += ` AND time_logs.user_id = ? `;
      queryParams.push(selectedUserId);
    }

    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    
    const logs = (result.rows || []).map(log => {
      let formattedTimestamp = log.timestamp;
      if (log.local_timestamp) {
        formattedTimestamp = log.local_timestamp;
      }
      return {
        ...log,
        timestamp: formattedTimestamp
      };
    });
    
    res.render('admin-timetracking', { 
      logs, 
      users,
      selectedDate: selectedDate || '',
      selectedUserId: selectedUserId || '',
      user: req.user
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err);
    res.status(500).send("Fehler beim Laden der Zeiterfassung");
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
// KANBAN-BOARD FÜR DIE WERKSTATT
// ==========================================
app.get('/projects/board', async (req, res) => {
  try {
    const sql = `
      SELECT projects.*, customers.company_name, customers.contact_person
      FROM projects
      LEFT JOIN customers ON projects.customer_id = customers.id
      ORDER BY projects.created_at DESC
    `;
    const projRes = await dbQuery(sql);
    const projects = projRes.rows || [];

    const columns = {
      'In Planung': projects.filter(p => p.status === 'In Planung' || !p.status),
      'Avor / Vorbereitung': projects.filter(p => p.status === 'Avor / Vorbereitung'),
      'In Produktion': projects.filter(p => p.status === 'In Produktion'),
      'Oberfläche': projects.filter(p => p.status === 'Oberfläche'),
      'Montagebereit': projects.filter(p => p.status === 'Montagebereit'),
      'Montage läuft': projects.filter(p => p.status === 'Montage läuft'),
      'Abgeschlossen': projects.filter(p => p.status === 'Abgeschlossen')
    };

    res.render('project-board', { columns });
  } catch (err) {
    console.error('Fehler beim Laden des Kanban-Boards:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// RECHNUNGSVERWALTUNG & MAHNWESEN
// ==========================================
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

app.get('/api/appointments', async (req, res) => {
  try {
    const query = `
      SELECT appointments.id, appointments.title, appointments.start_date as start, 
             appointments.end_date as end, appointments.description,
             customers.company_name, customers.contact_person
      FROM appointments
      LEFT JOIN customers ON appointments.customer_id = customers.id
    `;
    const result = await dbQuery(query);
    const events = (result.rows || []).map(app => ({
      id: app.id,
      title: `${app.title} (${app.company_name || app.contact_person || 'Privat'})`,
      start: app.start,
      end: app.end,
      description: app.description
    }));
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
    const sketchesRes = await dbQuery('SELECT id, title, image_data, created_by, created_at FROM project_sketches WHERE project_id = ? ORDER BY created_at DESC', [id]);

    res.render('project-detail', {
      project,
      files: filesRes.rows || [],
      appointments: appRes.rows || [],
      photos: photosRes.rows || [],
      measurements: measurementsRes.rows || [],
      notes: notesRes.rows || [],
      tasks: tasksRes.rows || [],
      sketches: sketchesRes.rows || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// HANDSKIZZEN (Canvas)
// ==========================================
app.post('/projects/:id/sketches/save', async (req, res) => {
  const projectId = req.params.id;
  const { image_data, title } = req.body;
  const createdBy = req.user ? req.user.username : 'Unbekannt';

  if (!image_data || !image_data.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Kein gültiges Bild.' });
  }
  // Base64-Größe grob prüfen: max ~2 MB
  if (image_data.length > 2 * 1024 * 1024 * 1.37) {
    return res.status(400).json({ error: 'Skizze zu groß (max. 2 MB).' });
  }

  try {
    await dbQuery(
      'INSERT INTO project_sketches (project_id, title, image_data, created_by) VALUES (?, ?, ?, ?)',
      [projectId, title ? title.trim() : null, image_data, createdBy]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Fehler beim Speichern der Skizze:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/projects/sketches/delete', async (req, res) => {
  const { sketch_id, project_id } = req.body;
  try {
    await dbQuery('DELETE FROM project_sketches WHERE id = ?', [sketch_id]);
  } catch (err) {
    console.error('Fehler beim Löschen der Skizze:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

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
