const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./config/database');

// Universelle Hilfsfunktion für SQLite (lokal) und PostgreSQL (Render)
const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (process.env.DATABASE_URL) {
      let i = 0;
      let pgSql = sql.replace(/\?/g, () => `$${++i}`);
      
      // Bei INSERT-Abfragen sicherstellen, dass die ID zurückgegeben wird, falls nicht vorhanden
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

const { verifyToken, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup für Datei-Uploads (Baustellenfotos & Skizzen)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// 1. EJS & Middleware Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(uploadDir));

// 2. Öffentliche Routen (Login / Logout)
app.use('/', authRoutes);

// 3. ALLE DARAUFFOLGENDEN ROUTEN SCHÜTZEN
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
        SELECT * FROM time_logs 
        WHERE user_id = ? 
        ORDER BY timestamp ASC
      `;
      const result = await dbQuery(sqlMonthLogs, [userId]);
      const logs = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn = false;

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const nextLog = logs[i + 1];
            const startTime = new Date(logs[i].timestamp);
            const endTime = (nextLog && nextLog.type === 'OUT') ? new Date(nextLog.timestamp) : (i === logs.length - 1 ? new Date() : null);
            
            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
            }

            if (endTime) {
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
        SELECT documents.id, documents.doc_number, 'Angebot' as doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person
        FROM documents
        LEFT JOIN customers ON documents.customer_id = customers.id
        UNION ALL
        SELECT invoices.id, invoices.invoice_number as doc_number, 'Rechnung' as doc_type, invoices.total_amount, invoices.status, customers.company_name, customers.contact_person
        FROM invoices
        LEFT JOIN customers ON invoices.customer_id = customers.id
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
// ZEITERFASSUNG / STEMPELUHR
// ==========================================
app.get('/timetracking', async (req, res) => {
  const userId = req.user.id;

  try {
    const sqlToday = `
      SELECT * FROM time_logs 
      WHERE user_id = ? 
      ORDER BY timestamp ASC
    `;
    const result = await dbQuery(sqlToday, [userId]);
    const todayLogs = result.rows;

    const lastLog = todayLogs && todayLogs.length > 0 ? todayLogs[todayLogs.length - 1] : null;
    const isStampedIn = lastLog && lastLog.type === 'IN';
    
    let lastStampTime = '';
    if (isStampedIn) {
      lastStampTime = new Date(lastLog.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    let totalMilliseconds = 0;
    if (todayLogs) {
      for (let i = 0; i < todayLogs.length; i++) {
        if (todayLogs[i].type === 'IN') {
          const nextLog = todayLogs[i + 1];
          const startTime = new Date(todayLogs[i].timestamp);
          const endTime = (nextLog && nextLog.type === 'OUT') ? new Date(nextLog.timestamp) : (isStampedIn && i === todayLogs.length - 1 ? new Date() : null);
          
          if (endTime) {
            totalMilliseconds += (endTime - startTime);
          }
        }
      }
    }

    const todayTotalHours = (totalMilliseconds / (1000 * 60 * 60)).toFixed(2);

    res.render('timetracking', {
      todayLogs: todayLogs || [],
      isStampedIn,
      lastStampTime,
      todayTotalHours
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/timetracking/stamp', async (req, res) => {
  const userId = req.user.id;
  const { type, note } = req.body;

  if (!['IN', 'OUT'].includes(type)) {
    return res.status(400).send('Ungültiger Stempel-Typ');
  }

  try {
    const sql = `INSERT INTO time_logs (user_id, type, note) VALUES (?, ?, ?)`;
    await dbQuery(sql, [userId, type, note || null]);
    res.redirect('/timetracking');
  } catch (err) {
    console.error('Fehler beim Stempeln:', err.message);
    res.status(500).send('Fehler beim Speichern der Stempelzeit');
  }
});

// ==========================================
// KUNDENVERWALTUNG & DATEIUPLOAD
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
    const sql = `INSERT INTO customer_files (customer_id, filename, original_name, file_type) VALUES (?, ?, ?, ?)`;
    await dbQuery(sql, [customer_id, req.file.filename, req.file.originalname, req.file.mimetype]);
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
    const offerRes = await dbQuery('SELECT * FROM documents WHERE id = ? AND doc_type = "OFFER"', [offer_id]);
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

    await dbQuery('UPDATE documents SET status = "ANGENOMMEN" WHERE id = ?', [offer_id]);
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

    res.render('project-detail', {
      project,
      files: filesRes.rows || [],
      appointments: appRes.rows || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.post('/projects/:id/upload', upload.single('file'), async (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.redirect(`/projects/${projectId}`);

  try {
    const sql = `INSERT INTO project_files (project_id, filename, original_name, file_type) VALUES (?, ?, ?, ?)`;
    await dbQuery(sql, [projectId, req.file.filename, req.file.originalname, req.file.mimetype]);
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
// SERVER START
// ==========================================
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Sichere Metallbau-App gestartet!`);
  console.log(`👉 Öffne im Browser: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
