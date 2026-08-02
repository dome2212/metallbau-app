const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { v2: cloudinary } = require('cloudinary');
const db = require('./config/database');
const dbQuery = require('./utils/dbQuery');

// ==========================================
// GLOBALE ZEITZONE AUF DEUTSCHLAND FESTLEGEN
// ==========================================
process.env.TZ = 'Europe/Berlin';

// Datenbank-Zeitzone explizit auf Berlin setzen
db.query("SET timezone = 'Europe/Berlin';").catch(() => {});

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

// NEU: project_tasks fehlte komplett als Migration, obwohl projectRoutes.js
// diese Tabelle für die Aufgaben-/Restarbeiten-Funktion voraussetzt.
dbQuery(`
  CREATE TABLE IF NOT EXISTS project_tasks (
    id SERIAL PRIMARY KEY,
    project_id INT,
    title TEXT NOT NULL,
    category TEXT DEFAULT 'Restarbeit',
    description TEXT,
    photo_url TEXT,
    status TEXT DEFAULT 'Offen',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle project_tasks existiert bereits:', err.message));

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

// Tabelle für den Live-Ticker / Pinnwand
dbQuery(`
  CREATE TABLE IF NOT EXISTS tickers (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    author TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabelle tickers existiert bereits:', err.message));

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

// ==========================================
// CLOUDINARY KONFIGURATION
// ==========================================
// WICHTIG: cloudinary ist ein Singleton (Node-Modul-Cache). Diese Konfiguration
// hier reicht aus - auch die CloudinaryStorage-Instanzen in customerRoutes.js,
// projectRoutes.js und vacationRoutes.js nutzen automatisch dieselbe Konfiguration,
// weil sie dasselbe 'cloudinary'-Modul importieren. NICHT entfernen, auch wenn
// hier lokal kein 'upload' mehr benutzt wird!
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const { verifyToken, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const customerRoutes = require('./routes/customerRoutes');
const projectRoutes = require('./routes/projectRoutes');
const timetrackingRoutes = require('./routes/timetrackingRoutes');
const vacationRoutes = require('./routes/vacationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const tickerRoutes = require('./routes/tickerRoutes');
const articleRoutes = require('./routes/articleRoutes');
const calendarRoutes = require('./routes/calendarRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');

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
app.use('/customers', customerRoutes);
app.use('/projects', projectRoutes);
app.use('/timetracking', timetrackingRoutes);
app.use('/vacations', vacationRoutes);
app.use('/admin', adminRoutes);
app.use('/ticker', tickerRoutes);
app.use('/articles', articleRoutes);
app.use('/calendar', calendarRoutes);
app.use('/api/appointments', appointmentRoutes);

// ==========================================
// DASHBOARD (Rollenspezifisch: Chef vs. Mitarbeiter)
// ==========================================
app.get('/', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    if (userRole !== 'ADMIN') {
      const sqlMonthLogs = `
        SELECT time_logs.*,
               TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
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
// ANGEBOTSVERWALTUNG & UMWANDLUNG
// (TODO Phase 2: in eigene routes/offerRoutes.js + routes/invoiceRoutes.js auslagern -
//  bewusst noch nicht in diesem Schritt gemacht, siehe Migrations-Anleitung)
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
