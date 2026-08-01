const express = require('express');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./config/database');

// Automatische Einbindung von PDFKit (lädt es, falls im System vorhanden, ohne Shell-Befehl)
let PDFKit;
try {
  PDFKit = require('pdfkit');
} catch (e) {
  console.log('Hinweis: pdfkit Modul wird geladen...');
}

// Zeitzone für die Datenbankverbindung auf Deutschland / Berlin festlegen
db.query("SET timezone = 'Europe/Berlin';").catch(() => {});

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
      db.all(sql, params, function(err, rows) {
        if (err) return reject(err);
        resolve({ rows: rows || [], lastID: this?.lastID });
      });
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

// Automatische Ergänzung fehlender Spalten bei bestehenden Tabellen auf Render
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS angle TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS width TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS height TEXT`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1`).catch(() => {});
dbQuery(`ALTER TABLE project_measurements ADD COLUMN IF NOT EXISTS note TEXT`).catch(() => {});

// Automatische Ergänzung für time_logs (behebt den Spaltenfehler)
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
  limits: { fileSize: 15 * 1024 * 1024 } // 15 MB Limit
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
app.use(express.static('public'));

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
      const sqlMonthLogs = `
        SELECT *, 
               (timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
        FROM time_logs 
        WHERE user_id = ? 
        ORDER BY timestamp ASC
      `;
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
      const stats = { monthTotalHours, isStampedIn };
      const recentLogs = [...logs].reverse().slice(0, 5);

      res.render('dashboard-employee', { stats, recentLogs });

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

      res.render('dashboard', { stats, recentDocs: formattedDocs });
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
// KUNDEN-DATEIEN LÖSCHEN (Falls benötigt)
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
    const sqlToday = `
      SELECT time_logs.*, customers.company_name, customers.contact_person,
             TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp 
      FROM time_logs 
      LEFT JOIN customers ON time_logs.customer_id = customers.id
      WHERE time_logs.user_id = ? AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = CURRENT_DATE
      ORDER BY time_logs.timestamp ASC
    `;
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

    // Kunden für das Dropdown laden
    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');

    res.render('timetracking', {
      todayLogs: formattedLogs,
      isStampedIn,
      lastStampTime,
      todayTotalHours,
      customers: custRes.rows || []
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/timetracking/stamp', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role; // Rolle des Nutzers ermitteln
  const { type, note, customer_id, latitude, longitude } = req.body;

  if (!['IN', 'OUT'].includes(type)) {
    return res.status(400).send('Ungültiger Stempel-Typ');
  }

  // GPS-Prüfung nur durchführen, wenn es sich um einen normalen Mitarbeiter handelt
  if (type === 'IN' && userRole !== 'ADMIN') {
    if (!latitude || !longitude) {
      return res.status(400).send('Standort konnte nicht ermittelt werden. GPS ist für das Einstempeln erforderlich.');
    }

    const FIRM_LAT = 51.3069467;
    const FIRM_LNG = 6.9483845;
    const MAX_DISTANCE_METERS = 300;

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
    const sql = `INSERT INTO time_logs (user_id, type, note, customer_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, (NOW() AT TIME ZONE 'Europe/Berlin'))`;
    await dbQuery(sql, [userId, type, note || null, assignedCustomerId, latitude || null, longitude || null]);
    res.redirect('/timetracking');
  } catch (err) {
    try {
      const fallbackSql = `INSERT INTO time_logs (user_id, type, note, customer_id, timestamp) VALUES (?, ?, ?, ?, (NOW() AT TIME ZONE 'Europe/Berlin'))`;
      await dbQuery(fallbackSql, [userId, type, note || null, assignedCustomerId]);
      res.redirect('/timetracking');
    } catch (fallbackErr) {
      console.error('Fehler beim Stempeln:', fallbackErr.message);
      res.status(500).send('Fehler beim Speichern der Stempelzeit');
    }
  }
});

// ==========================================
// STEMPEL-EINTRAG LÖSCHEN (Nur für Admins)
// ==========================================
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
// ARBEITSZEITEN-ÜBERSICHT (Für Sekretariat / Admin)
// ==========================================
app.get('/admin/timetracking', verifyToken, requireAdmin, async (req, res) => {
  try {
    const selectedDate = req.query.date;
    const selectedUserId = req.query.user_id;

    const usersRes = await dbQuery('SELECT id, username FROM users ORDER BY username ASC');
    const users = usersRes.rows || [];

    let query = `
      SELECT time_logs.*, users.username, 
             (time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
      FROM time_logs 
      JOIN users ON time_logs.user_id = users.id 
      WHERE 1=1
    `;
    let queryParams = [];

    if (selectedDate) {
      query += ` AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = ? `;
      queryParams.push(selectedDate);
    }

    if (selectedUserId) {
      query += ` AND time_logs.user_id = ? `;
      queryParams.push(selectedUserId);
    }

    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    const logs = (result.rows || []).map(log => ({
      ...log,
      timestamp: log.local_timestamp || log.timestamp
    }));
    
    res.render('admin-timetracking', { 
      logs, 
      users,
      selectedDate: selectedDate || '',
      selectedUserId: selectedUserId || '',
      user: req.session ? req.session.user : req.user 
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err);
    res.status(500).send("Fehler beim Laden der Zeiterfassung");
  }
});

// ==========================================
// ARBEITSZEITEN PDF EXPORT ROUTE (KORRIGIERT)
// ==========================================
app.get('/admin/timetracking/pdf', verifyToken, requireAdmin, async (req, res) => {
  const { user_id, date } = req.query;

  try {
    let query = `
      SELECT time_logs.*, users.username, 
             (time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
      FROM time_logs 
      JOIN users ON time_logs.user_id = users.id 
      WHERE 1=1
    `;
    let queryParams = [];

    if (user_id) {
      query += ` AND time_logs.user_id = ?`;
      queryParams.push(user_id);
    }

    if (date) {
      query += ` AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = ?`;
      queryParams.push(date);
    }

    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    const logs = (result.rows || []).map(log => ({
      ...log,
      timestamp: log.local_timestamp || log.timestamp
    }));

    // Mitarbeiter-Namen für die Überschrift ermitteln
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

    // PDF-Kopfbereich
    doc.fontSize(18).font('Helvetica-Bold').text('Arbeitszeiten-Übersicht', { align: 'left' });
    doc.fontSize(12).font('Helvetica').text(`Mitarbeiter: ${employeeName}`, { align: 'left' });
    if (date) {
      doc.text(`Datum: ${date}`, { align: 'left' });
    }
    doc.fontSize(9).text(`Erstellt am: ${new Date().toLocaleDateString('de-DE')}`, { align: 'left' });
    doc.moveDown(1.5);

    // Tabellen-Header
    doc.fontSize(10).font('Helvetica-Bold');
    let startY = doc.y;
    doc.text('Datum / Uhrzeit', 50, startY, { width: 130 });
    doc.text('Aktion', 185, startY, { width: 150 });
    doc.text('Notiz', 345, startY, { width: 200 });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.8);

    // Tabelleneinträge
    doc.font('Helvetica').fontSize(9);
    if (logs && logs.length > 0) {
      logs.forEach(log => {
        const logDate = new Date(log.timestamp).toLocaleString('de-DE', {
          dateStyle: 'short',
          timeStyle: 'short'
        });
        const actionText = log.type === 'IN' ? 'Eingestempelt (IN)' : 'Ausgestempelt (OUT)';
        const noteText = log.log_note || log.note || '-';

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


// ==========================================
// STEMPELUHR: MONATSAUSWERTUNG & CSV-EXPORT
// ==========================================
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
      `SELECT *, (timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
       FROM time_logs 
       WHERE user_id = ? AND to_char(timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ? 
       ORDER BY timestamp ASC`,
      [targetUserId, month]
    );
    
    const entries = (entriesRes.rows || []).map(e => ({
      ...e,
      timestamp: e.local_timestamp || e.timestamp
    }));

    res.render('time-monthly', {
      currentUser: req.user,
      users,
      entries,
      selectedMonth: month,
      selectedUserId: targetUserId
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
      `SELECT t.*, u.username, (t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') as local_timestamp 
       FROM time_logs t
       JOIN users u ON t.user_id = u.id
       WHERE t.user_id = ? AND to_char(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
       ORDER BY t.timestamp ASC`,
      [targetUserId, month]
    );
    const entries = logsRes.rows;

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
        'INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, 1, "Psch", ?)',
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

    res.render('project-detail', {
      project,
      files: filesRes.rows || [],
      appointments: appRes.rows || [],
      photos: photosRes.rows || [],
      measurements: measurementsRes.rows || [],
      notes: notesRes.rows || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
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

