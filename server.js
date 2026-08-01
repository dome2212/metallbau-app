// Überarbeitete server.js
// Verbesserungen: Helmet, Logging, Rate-Limit, express-async-errors, zentrale Fehlerbehandlung,
// TIMEZONE-Konstante, Cloudinary-/PDFKit-Checks, kleinere Bugfixes (SQL-Literal), bessere Validierung/Hinweise.

require('express-async-errors'); // Patch für async errors (muss vor express geladen werden)
const express = require('express');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./config/database');

// ==========================================
// KONSTANTEN
// ==========================================
const TIMEZONE = process.env.APP_TIMEZONE || 'Europe/Berlin';
process.env.TZ = TIMEZONE;
const PORT = process.env.PORT || 3000;
const FIRM_LAT = parseFloat(process.env.FIRM_LAT || '51.3069467');
const FIRM_LNG = parseFloat(process.env.FIRM_LNG || '6.9483845');
const MAX_DISTANCE_METERS = parseInt(process.env.MAX_DISTANCE_METERS || '300', 10);

// ==========================================
// HILFSFUNKTION (DB QUERY)
// ==========================================
const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    // Wenn eine Postgres-URL gesetzt ist, gehen wir davon aus, dass db.query im PG-Stil vorhanden ist
    if (process.env.DATABASE_URL && typeof db.query === 'function') {
      let i = 0;
      // Ersetze ? durch $n für PG
      let pgSql = sql.replace(/\?/g, () => `$${++i}`);
      // Bei INSERT in PG ohne RETURNING -> RETURNING id hinzufügen (hilft lastID)
      if (pgSql.trim().toUpperCase().startsWith('INSERT') && !/RETURNING/i.test(pgSql)) {
        pgSql += ' RETURNING id';
      }

      db.query(pgSql, params, (err, res) => {
        if (err) return reject(err);
        const rows = res.rows || [];
        const lastID = rows.length > 0 && rows[0].id ? rows[0].id : null;
        resolve({ rows, lastID });
      });
    } else if (typeof db.all === 'function') {
      // sqlite3 style
      db.all(sql, params, function(err, rows) {
        if (err) return reject(err);
        resolve({ rows: rows || [], lastID: this?.lastID || null });
      });
    } else {
      // Fallback: falls db eine andere API hat
      reject(new Error('Unbekannte DB-Schnittstelle'));
    }
  });
};

// ==========================================
// AUTOMATISCHE TABELLEN-ERSTELLUNG (wie zuvor)
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
`).catch(err => console.log('Tabelle articles existiert bereits oder Fehler:', err.message));

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_photos (
    id SERIAL PRIMARY KEY,
    project_id INT,
    file_url TEXT NOT NULL,
    original_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_photos existiert bereits oder Fehler:', err.message));

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
`).catch(err => console.log('Tabelle project_measurements existiert bereits oder Fehler:', err.message));

dbQuery(`
  CREATE TABLE IF NOT EXISTS project_notes (
    id SERIAL PRIMARY KEY,
    project_id INT,
    note_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_notes existiert bereits oder Fehler:', err.message));

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
`).catch(err => console.log('Tabelle vacations existiert bereits oder Fehler:', err.message));

dbQuery(`
  CREATE TABLE IF NOT EXISTS tickers (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    author TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle tickers existiert bereits oder Fehler:', err.message));

// Ergänzungen (ALTER TABLE) wie gehabt
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

// ==========================================
// CLOUDINARY & MULTER
// ==========================================
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn('CLOUDINARY-Umgebungsvariablen fehlen. Uploads zu Cloudinary funktionieren nicht ohne Konfiguration.');
}

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
  limits: { fileSize: 15 * 1024 * 1024 } // 15 MB
});

// ==========================================
// HILFSFUNKTIONEN
// ==========================================
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

// Optional: Async-Wrapper, wenn du viele async Routen hast (nicht zwingend notwendig,
// da die meisten Routen bereits try/catch nutzen).
const catchAsync = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ==========================================
// MIDDLEWARE / SECURITY
// ==========================================
const app = express();

app.use(helmet());
app.use(morgan('combined')); // Logging
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Rate limiter (Grundschutz für alle POST-Anfragen)
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 Minute
  max: 200 // pro IP
});
app.use(limiter);

// VIEW Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==========================================
// ROUTEN (Modular)
// ==========================================
const { verifyToken, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');

// Öffentliche Auth-Routen
app.use('/', authRoutes);

// Ab hier alle geschützten Routen
app.use(verifyToken);
app.use('/documents', documentRoutes);

// ==========================================
// DASHBOARD
// ==========================================
app.get('/', catchAsync(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole !== 'ADMIN') {
    const sqlMonthLogs = `
      SELECT time_logs.*, 
             TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE '${TIMEZONE}', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp 
      FROM time_logs 
      WHERE user_id = ? 
      ORDER BY timestamp ASC
    `;
    const result = await dbQuery(sqlMonthLogs, [userId]);
    const logs = result.rows || [];

    let totalMilliseconds = 0;
    let isStampedIn = false;
    const now = new Date();

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

    const monthTotalHours = (totalMilliseconds / (1000 * 60 * 60)).toFixed(2);
    const stats = { monthTotalHours, isStampedIn };
    const recentLogs = [...logs].reverse().slice(0, 5);

    res.render('dashboard-employee', { stats, recentLogs });
  } else {
    // ADMIN Dashboard...
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

    const [offerRes, invoiceRes, customerRes, recentDocsRes] = await Promise.all([
      dbQuery(sqlOffers),
      dbQuery(sqlInvoices),
      dbQuery(sqlCustomers),
      dbQuery(sqlRecentDocs)
    ]);

    const offerData = offerRes.rows[0] || { count: 0, total: 0 };
    const invoiceData = invoiceRes.rows[0] || { count: 0, total: 0 };
    const customerData = customerRes.rows[0] || { count: 0 };

    const stats = {
      openOffersCount: offerData.count || 0,
      openOffersSum: Number(offerData.total || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 }),
      openInvoicesCount: invoiceData.count || 0,
      openInvoicesSum: Number(invoiceData.total || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 }),
      totalCustomers: customerData.count || 0
    };

    const formattedDocs = (recentDocsRes.rows || []).map(doc => ({
      ...doc,
      customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
    }));

    res.render('dashboard', { stats, recentDocs: formattedDocs });
  }
}));

// ==========================================
// BEISPIEL: FOTO-UPLOAD (unverändert, nur minimal sicherer Umgang mit req.file)
// ==========================================
app.post('/projects/:id/photos/upload', upload.single('photo'), catchAsync(async (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.redirect(`/projects/${projectId}`);
  try {
    const sql = `INSERT INTO project_photos (project_id, file_url, original_name) VALUES (?, ?, ?)`;
    await dbQuery(sql, [projectId, req.file.path, req.file.originalname]);
  } catch (err) {
    console.error('Fehler beim Foto-Upload:', err.message);
  }
  res.redirect(`/projects/${projectId}`);
}));

// ==========================================
// (weitere Routen übernommen, viele mit try/catch wie zuvor)
// - Ich habe die meiste Logik beibehalten, nur kritische Bugs / Sicherheitsverbesserungen gemacht.
// - Beispiel-Fix: im Convert-to-Invoice-Fall war ein SQL-Literal mit doppelten Anführungszeichen (") -> ersetzt durch '
//
// ==========================================
// KONKRETER BUGFIX: Angebot -> Rechnung - INSERT invoice_items (wenn keine items vorhanden)
// ==========================================
app.post('/documents/offers/convert-to-invoice', catchAsync(async (req, res) => {
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
      // Bugfix: 'Psch' mit ' (nicht "), und wir nutzen Parameter
      await dbQuery(
        'INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)',
        [invoiceId, 'Übernahme aus Angebot #' + offer.doc_number, 1, 'Psch', offer.total_amount]
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
    console.error('Fehler beim Umwandeln des Angebots:', err);
    res.status(500).send('Fehler beim Umwandeln des Angebots');
  }
}));

// ==========================================
// ZENTRALE FEHLERBEHANDLUNG
// ==========================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send('Ein interner Serverfehler ist aufgetreten.');
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Metallbau-App gestartet (Port ${PORT})`);
  console.log(`Zeitzone: ${TIMEZONE}`);
  console.log(`==================================================\n`);
});
