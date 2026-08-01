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

// Datenbank-Zeitzone explizit auf Berlin setzen
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
    user_id INT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'Restarbeit', -- 'Restarbeit' oder 'Mangel'
    status TEXT DEFAULT 'Offen',       -- 'Offen', 'In Bearbeitung', 'Erledigt'
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
        SELECT time_logs.* 
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
          const currentLogTime = new Date(logs[i].timestamp);
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const nextLog = logs[i + 1];
            const startTime = currentLogTime.getTime();
            let endTime;

            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
              endTime = new Date(nextLog.timestamp).getTime();
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

// Aufgabe / Restarbeit / Mangel hinzufügen
app.post('/projects/:id/tasks/add', upload.single('photo'), async (req, res) => {
  const projectId = req.params.id;
  const userId = req.user.id;
  const { title, description, category } = req.body;

  if (!title) return res.redirect(`/projects/${projectId}`);

  let photoUrl = null;
  if (req.file) {
    photoUrl = req.file.path; // Cloudinary URL
  }

  try {
    const sql = `
      INSERT INTO project_tasks (project_id, user_id, title, description, category, photo_url, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Offen')
    `;
    await dbQuery(sql, [projectId, userId, title, description || null, category || 'Restarbeit', photoUrl]);
  } catch (err) {
    console.error('Fehler beim Speichern der Aufgabe:', err.message);
  }
  res.redirect(`/projects/${projectId}`);
});

// Status einer Aufgabe ändern (z.B. Erledigt)
app.post('/projects/tasks/status', async (req, res) => {
  const { task_id, project_id, status } = req.body;
  try {
    await dbQuery('UPDATE project_tasks SET status = ? WHERE id = ?', [status, task_id]);
  } catch (err) {
    console.error('Fehler beim Aktualisieren der Aufgabe:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

// Aufgabe löschen
app.post('/projects/tasks/delete', async (req, res) => {
  const { task_id, project_id } = req.body;
  try {
    await dbQuery('DELETE FROM project_tasks WHERE id = ?', [task_id]);
  } catch (err) {
    console.error('Fehler beim Löschen der Aufgabe:', err.message);
  }
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// ZEITERFASSUNG / STEMPELUHR
// ==========================================
app.get('/timetracking', async (req, res) => {
  const userId = req.user.id;

  try {
    const sqlToday = `
      SELECT time_logs.*, customers.company_name, customers.contact_person
      FROM time_logs 
      LEFT JOIN customers ON time_logs.customer_id = customers.id
      WHERE time_logs.user_id = ? AND DATE(time_logs.timestamp) = CURRENT_DATE
      ORDER BY time_logs.timestamp ASC
    `;
    const result = await dbQuery(sqlToday, [userId]);
    const todayLogs = result.rows;

    const lastLog = todayLogs && todayLogs.length > 0 ? todayLogs[todayLogs.length - 1] : null;
    const isStampedIn = lastLog && lastLog.type === 'IN';
    
    let lastStampTime = '';
    if (isStampedIn && lastLog && lastLog.timestamp) {
      const d = new Date(lastLog.timestamp);
      lastStampTime = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    let totalMilliseconds = 0;
    const now = new Date();

    if (todayLogs && todayLogs.length > 0) {
      for (let i = 0; i < todayLogs.length; i++) {
        if (!todayLogs[i].timestamp) continue;
        const currentLogTime = new Date(todayLogs[i].timestamp);
        
        if (todayLogs[i].type === 'IN') {
          const nextLog = todayLogs[i + 1];
          const startTime = currentLogTime.getTime();
          let endTime;

          if (nextLog && nextLog.type === 'OUT' && nextLog.timestamp) {
            endTime = new Date(nextLog.timestamp).getTime();
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

    const formattedLogs = todayLogs.map(log => {
      const d = new Date(log.timestamp);
      return {
        ...log,
        display_time: d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      };
    });

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
  const userRole = req.user.role;
  const { type, note, customer_id, latitude, longitude } = req.body;

  if (!['IN', 'OUT'].includes(type)) {
    return res.status(400).send('Ungültiger Stempel-Typ');
  }

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
    const sql = `INSERT INTO time_logs (user_id, type, note, customer_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
    await dbQuery(sql, [userId, type, note || null, assignedCustomerId, latitude || null, longitude || null]);
    res.redirect('/timetracking');
  } catch (err) {
    try {
      const fallbackSql = `INSERT INTO time_logs (user_id, type, note, customer_id, timestamp) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`;
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
        SELECT * FROM vacations 
        WHERE user_id = ? 
        ORDER BY created_at DESC
      `, [userId]);
    }

    const usersRes = await dbQuery('SELECT id, username, role FROM users ORDER BY username ASC');

    res.render('vacations', { 
      vacations: vacationsRes.rows || [],
      users: usersRes.rows || [], 
      user: req.user,
      currentUser: req.user 
    });
  } catch (err) {
    console.error('Fehler beim Laden der Urlaubsübersicht:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/vacations/add', upload.single('document'), async (req, res) => {
  try {
    const userId = req.user ? req.user.id : (req.body.user_id || req.session?.userId);
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

    let query = `
      SELECT time_logs.*, users.username 
      FROM time_logs 
      JOIN users ON time_logs.user_id = users.id 
      WHERE 1=1
    `;
    let queryParams = [];

    if (selectedDate) {
      query += ` AND DATE(time_logs.timestamp) = ? `;
      queryParams.push(selectedDate);
    }

    if (selectedUserId) {
      query += ` AND time_logs.user_id = ? `;
      queryParams.push(selectedUserId);
    }

    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    const logs = result.rows || [];
    
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

app.post('/admin/timetracking/add', verifyToken, requireAdmin, async (req, res) => {
  const { user_id, type, date, time, note } = req.body;

  if (!user_id || !type || !date || !time) {
    return res.status(400).send('Alle Pflichtfelder müssen ausgefüllt werden.');
  }

  try {
    const timestampString = `${date} ${time}:00`;

    const sql = `
      INSERT INTO time_logs (user_id, type, note, timestamp) 
      VALUES (?, ?, ?, ?::timestamp)
    `;
    
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
    let query = `
      SELECT time_logs.*, users.username 
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
      query += ` AND DATE(time_logs.timestamp) = ?`;
      queryParams.push(date);
    }

    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    const logs = result.rows || [];

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
        const d = new Date(log.timestamp);
        const logDate = d.toLocaleString('de-DE', {
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
      `SELECT time_logs.* 
       FROM time_logs 
       WHERE user_id = ? AND to_char(time_logs.timestamp, 'YYYY-MM') = ? 
       ORDER BY time_logs.timestamp ASC`,
      [targetUserId, month]
    );
    
    const entries = entriesRes.rows || [];

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
      `SELECT t.*, u.username 
       FROM time_logs t
       JOIN users u ON t.user_id = u.id
       WHERE t.user_id = ? AND to_char(t.timestamp, 'YYYY-MM') = ?
       ORDER BY t.timestamp ASC`,
      [targetUserId, month]
    );
    const entries = logsRes.rows;

    let csv = 'Mitarbeiter;Datum;Typ;Notiz;Zeitpunkt\n';

    entries.forEach(e => {
      const dateObj = new Date(e.timestamp);
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

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
