const express = require('express');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./config/database');

// Automatische Einbindung von PDFKit
let PDFKit;
try {
  PDFKit = require('pdfkit');
} catch (e) {
  console.log('Hinweis: pdfkit Modul wird geladen...');
}

// Zeitzone für die Datenbankverbindung festlegen
db.query("SET timezone = 'Europe/Berlin';").catch(() => {});

// ==========================================
// HILFSFUNKTION (Datenbank-Abstraktion)
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
      db.all(sql, params, function(err, rows) {
        if (err) return reject(err);
        resolve({ rows: rows || [], lastID: this?.lastID });
      });
    }
  });
};

// ==========================================
// AUTOMATISCHE TABELLEN- & SPALTEN-ERSTELLUNG
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
`).catch(() => {});

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_photos (
    id SERIAL PRIMARY KEY,
    project_id INT,
    file_url TEXT NOT NULL,
    original_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(() => {});

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
`).catch(() => {});

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_notes (
    id SERIAL PRIMARY KEY,
    project_id INT,
    note_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(() => {});

// Spaltenergänzungen sicherstellen
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS angle TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS width TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS height TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS note TEXT`).catch(() => {});

dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS customer_id INT`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,8)`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8)`).catch(() => {});
dbQuery(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS note TEXT`).catch(() => {});

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

// Haversine-Formel zur Distanzberechnung
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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

app.use('/', authRoutes);

app.use(verifyToken);
app.use('/documents', documentRoutes);

// ==========================================
// DASHBOARD
// ==========================================
app.get('/', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    if (userRole !== 'ADMIN') {
      const sqlMonthLogs = `
        SELECT *, (timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
        FROM time_logs WHERE user_id = ? ORDER BY timestamp ASC
      `;
      const result = await dbQuery(sqlMonthLogs, [userId]);
      const logs = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn = false;

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const currentLogTime = new Date(logs[i].local_timestamp || logs[i].timestamp);
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const nextLog = logs[i + 1];
            const startTime = currentLogTime;
            const nextLogTime = nextLog ? new Date(nextLog.local_timestamp || nextLog.timestamp) : null;
            const endTime = (nextLog && nextLog.type === 'OUT') ? nextLogTime : (i === logs.length - 1 ? new Date() : null);
            
            if (nextLog && nextLog.type === 'OUT') isStampedIn = false;
            if (endTime) totalMilliseconds += (endTime - startTime);
          } else if (logs[i].type === 'OUT') {
            isStampedIn = false;
          }
        }
      }

      const monthTotalHours = (totalMilliseconds / (1000 * 60 * 60)).toFixed(2);
      res.render('dashboard-employee', { stats: { monthTotalHours, isStampedIn }, recentLogs: [...logs].reverse().slice(0, 5) });
    } else {
      const offerRes = await dbQuery("SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM documents WHERE doc_type = 'OFFER' AND status NOT IN ('ANGENOMMEN', 'ABGELEHNT')");
      const invoiceRes = await dbQuery("SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM invoices WHERE status != 'Bezahlt'");
      const customerRes = await dbQuery("SELECT COUNT(*) as count FROM customers");
      
      const recentDocsRes = await dbQuery(`
        SELECT * FROM (
          SELECT documents.id, documents.doc_number, 'Angebot' as doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person
          FROM documents LEFT JOIN customers ON documents.customer_id = customers.id
          UNION ALL
          SELECT invoices.id, invoices.invoice_number as doc_number, 'Rechnung' as doc_type, invoices.total_amount, invoices.status, customers.company_name, customers.contact_person
          FROM invoices LEFT JOIN customers ON invoices.customer_id = customers.id
        ) combined ORDER BY id DESC LIMIT 5
      `);

      const offerData = offerRes.rows[0];
      const invoiceData = invoiceRes.rows[0];

      const stats = {
        openOffersCount: offerData?.count || 0,
        openOffersSum: Number(offerData?.total || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 }),
        openInvoicesCount: invoiceData?.count || 0,
        openInvoicesSum: Number(invoiceData?.total || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 }),
        totalCustomers: customerRes.rows[0]?.count || 0
      };

      const recentDocs = (recentDocsRes.rows || []).map(doc => ({
        ...doc,
        customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
      }));

      res.render('dashboard', { stats, recentDocs });
    }
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// ZEITERFASSUNG / STEMPELUHR
// ==========================================
app.get('/timetracking', async (req, res) => {
  const userId = req.user.id;

  try {
    const sqlToday = `
      SELECT time_logs.*, customers.company_name, customers.contact_person,
             (time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
      FROM time_logs LEFT JOIN customers ON time_logs.customer_id = customers.id
      WHERE time_logs.user_id = ? ORDER BY time_logs.timestamp ASC
    `;
    const result = await dbQuery(sqlToday, [userId]);
    const todayLogs = result.rows || [];

    const lastLog = todayLogs.length > 0 ? todayLogs[todayLogs.length - 1] : null;
    const isStampedIn = lastLog && lastLog.type === 'IN';
    
    let lastStampTime = '';
    if (isStampedIn && lastLog) {
      lastStampTime = new Date(lastLog.local_timestamp || lastLog.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    let totalMilliseconds = 0;
    for (let i = 0; i < todayLogs.length; i++) {
      const currentLogTime = new Date(todayLogs[i].local_timestamp || todayLogs[i].timestamp);
      if (todayLogs[i].type === 'IN') {
        const nextLog = todayLogs[i + 1];
        const endTime = (nextLog && nextLog.type === 'OUT') ? new Date(nextLog.local_timestamp || nextLog.timestamp) : (isStampedIn && i === todayLogs.length - 1 ? new Date() : null);
        if (endTime) totalMilliseconds += (endTime - currentLogTime);
      }
    }

    const todayTotalHours = (totalMilliseconds / (1000 * 60 * 60)).toFixed(2);
    const formattedLogs = todayLogs.map(log => ({ ...log, timestamp: log.local_timestamp || log.timestamp }));
    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');

    res.render('timetracking', {
      todayLogs: formattedLogs,
      isStampedIn,
      lastStampTime,
      todayTotalHours,
      customers: custRes.rows || [],
      currentUser: req.user
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/timetracking/stamp', async (req, res) => {
  const userId = req.user.id;
  const { type, note, customer_id, latitude, longitude } = req.body;

  if (!['IN', 'OUT'].includes(type)) return res.status(400).send('Ungültiger Stempel-Typ');

  if (type === 'IN') {
    if (!latitude || !longitude) return res.status(400).send('GPS-Standort erforderlich.');
    const distance = getDistanceFromLatLonInMeters(parseFloat(latitude), parseFloat(longitude), 51.3069467, 6.9483845);
    if (distance > 300) return res.status(400).send(`Einstempeln verweigert: ${Math.round(distance)} Meter entfernt (max. 300m).`);
  }

  const assignedCustomerId = customer_id || null;

  try {
    await dbQuery(`INSERT INTO time_logs (user_id, type, note, customer_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, NOW())`, [userId, type, note || null, assignedCustomerId, latitude || null, longitude || null]);
    res.redirect('/timetracking');
  } catch (err) {
    try {
      await dbQuery(`INSERT INTO time_logs (user_id, type, note, customer_id) VALUES (?, ?, ?, ?)`, [userId, type, note || null, assignedCustomerId]);
      res.redirect('/timetracking');
    } catch (fallbackErr) {
      res.status(500).send('Fehler beim Speichern');
    }
  }
});

app.post('/timetracking/admin/delete', verifyToken, requireAdmin, async (req, res) => {
  try {
    await dbQuery('DELETE FROM time_logs WHERE id = ?', [req.body.log_id]);
    res.redirect('back');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// Einheitlicher Endpunkt für Monatsauswertung (ersetzt veraltete /admin/timetracking und /monthly Dubletten)
app.get('/timetracking/admin/report', verifyToken, requireAdmin, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const targetUserId = req.query.user_id;

    const usersRes = await dbQuery('SELECT id, username FROM users ORDER BY username ASC');
    let query = `
      SELECT t.*, u.username, (t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
      FROM time_logs t JOIN users u ON t.user_id = u.id 
      WHERE to_char(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
    `;
    let params = [month];

    if (targetUserId) {
      query += ` AND t.user_id = ?`;
      params.push(targetUserId);
    }

    query += ` ORDER BY t.timestamp ASC`;
    const result = await dbQuery(query, params);

    res.render('admin-timetracking', {
      logs: (result.rows || []).map(l => ({ ...l, timestamp: l.local_timestamp || l.timestamp })),
      users: usersRes.rows || [],
      selectedMonth: month,
      selectedUserId: targetUserId || '',
      currentUser: req.user
    });
  } catch (err) {
    res.status(500).send("Fehler beim Laden");
  }
});

app.get('/timetracking/admin/export-csv', verifyToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = req.query.user_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);

    let query = `
      SELECT t.*, u.username, (t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
      FROM time_logs t JOIN users u ON t.user_id = u.id
      WHERE to_char(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
    `;
    let params = [month];
    if (targetUserId) {
      query += ` AND t.user_id = ?`;
      params.push(targetUserId);
    }
    query += ` ORDER BY t.timestamp ASC`;

    const logsRes = await dbQuery(query, params);
    let csv = 'Mitarbeiter;Datum;Typ;Notiz;Zeitpunkt\n';

    logsRes.rows.forEach(e => {
      const dateObj = new Date(e.local_timestamp || e.timestamp);
      csv += `"${e.username}","${dateObj.toLocaleDateString('de-DE')}","${e.type === 'IN' ? 'Kommen' : 'Gehen'}","${e.note || ''}","${dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}"\n`;
    });

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`Zeiterfassung_${month}.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).send('Fehler beim CSV-Export.');
  }
});

// Standard-Routen beibehalten (Projekte, Kunden, Artikel etc. funktional gekürzt für Übersicht)
app.get('/customers', async (req, res) => {
  const result = await dbQuery('SELECT * FROM customers ORDER BY created_at DESC');
  res.render('customers', { customers: result.rows || [] });
});

app.get('/projects', async (req, res) => {
  const projRes = await dbQuery('SELECT projects.*, customers.company_name FROM projects LEFT JOIN customers ON projects.customer_id = customers.id');
  res.render('projects', { projects: projRes.rows || [] });
});

app.listen(PORT, () => {
  console.log(`🚀 Metallbau-App läuft auf Port ${PORT}`);
});
