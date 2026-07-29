const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./config/database');
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
app.use('/uploads', express.static(uploadDir)); // statischer Ordner für Bilder/Dateien

// 2. Öffentliche Routen (Login / Logout)
app.use('/', authRoutes);

// 3. ALLE DARAUFFOLGENDEN ROUTEN SCHÜTZEN
app.use(verifyToken); 
app.use('/documents', documentRoutes);

// ==========================================
// DASHBOARD (Rollenspezifisch: Chef vs. Mitarbeiter)
// ==========================================
app.get('/', (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  // Wenn der Nutzer ein normaler Mitarbeiter ist -> Monatsstunden & eigene Stempel anzeigen
  if (userRole !== 'ADMIN') {
    const sqlMonthLogs = `
      SELECT * FROM time_logs 
      WHERE user_id = ? AND strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
      ORDER BY timestamp ASC
    `;

    db.all(sqlMonthLogs, [userId], (err, logs) => {
      if (err) {
        console.error('Fehler beim Laden der Monatsstunden:', err.message);
        return res.status(500).send('Datenbankfehler');
      }

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

      const stats = {
        monthTotalHours: monthTotalHours,
        isStampedIn: isStampedIn
      };

      const recentLogs = (logs || []).reverse().slice(0, 5);

      res.render('dashboard-employee', { stats, recentLogs });
    });

  } else {
    // Wenn es der Chef (ADMIN) ist -> Originale Geschäftsdaten anzeigen
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

    db.get(sqlOffers, [], (err, offerData) => {
      db.get(sqlInvoices, [], (err, invoiceData) => {
        db.get(sqlCustomers, [], (err, customerData) => {
          db.all(sqlRecentDocs, [], (err, recentDocs) => {
            
            const stats = {
              openOffersCount: offerData ? offerData.count : 0,
              openOffersSum: offerData ? offerData.total.toLocaleString('de-DE', { minimumFractionDigits: 2 }) : '0,00',
              openInvoicesCount: invoiceData ? invoiceData.count : 0,
              openInvoicesSum: invoiceData ? invoiceData.total.toLocaleString('de-DE', { minimumFractionDigits: 2 }) : '0,00',
              totalCustomers: customerData ? customerData.count : 0
            };

            const formattedDocs = (recentDocs || []).map(doc => ({
              ...doc,
              customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
            }));

            res.render('dashboard', { stats, recentDocs: formattedDocs });
          });
        });
      });
    });
  }
});

// ==========================================
// ZEITERFASSUNG / STEMPELUHR
// ==========================================
app.get('/timetracking', (req, res) => {
  const userId = req.user.id;

  const sqlToday = `
    SELECT * FROM time_logs 
    WHERE user_id = ? AND DATE(timestamp) = DATE('now', 'localtime')
    ORDER BY timestamp ASC
  `;

  db.all(sqlToday, [userId], (err, todayLogs) => {
    if (err) return res.status(500).send('Datenbankfehler');

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
  });
});

app.post('/timetracking/stamp', (req, res) => {
  const userId = req.user.id;
  const { type, note } = req.body;

  if (!['IN', 'OUT'].includes(type)) {
    return res.status(400).send('Ungültiger Stempel-Typ');
  }

  const sql = `INSERT INTO time_logs (user_id, type, note) VALUES (?, ?, ?)`;
  db.run(sql, [userId, type, note || null], (err) => {
    if (err) {
      console.error('Fehler beim Stempeln:', err.message);
      return res.status(500).send('Fehler beim Speichern der Stempelzeit');
    }
    res.redirect('/timetracking');
  });
});

// ==========================================
// KUNDENVERWALTUNG & DATEIUPLOAD
// ==========================================
app.post('/customers/edit', (req, res) => {
  const { id, company_name, contact_person, email, phone, street, zip, city } = req.body;

  const sql = `
    UPDATE customers 
    SET company_name = ?, contact_person = ?, email = ?, phone = ?, street = ?, zip = ?, city = ?
    WHERE id = ?
  `;

  db.run(sql, [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null, id], (err) => {
    if (err) return res.status(500).send('Fehler beim Aktualisieren');
    res.redirect('/customers');
  });
});

app.post('/customers/delete', (req, res) => {
  const { id } = req.body;
  db.run('DELETE FROM customers WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('Fehler beim Löschen');
    res.redirect('/customers');
  });
});

app.get('/customers/:id/projects', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM customers WHERE id = ?', [id], (err, customer) => {
    if (err || !customer) return res.status(404).send('Kunde nicht gefunden');

    db.all("SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'OFFER' ORDER BY created_at DESC", [id], (err, offers) => {
      db.all("SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC", [id], (err, invoices) => {
        db.all("SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC", [id], (err, appointments) => {
          db.all("SELECT * FROM customer_files WHERE customer_id = ? ORDER BY created_at DESC", [id], (err, files) => {
            res.render('customer-projects', {
              customer,
              offers: offers || [],
              invoices: invoices || [],
              appointments: appointments || [],
              files: files || []
            });
          });
        });
      });
    });
  });
});

app.post('/customers/:id/upload', upload.single('file'), (req, res) => {
  const customer_id = req.params.id;
  if (!req.file) return res.redirect(`/customers/${customer_id}/projects`);

  const sql = `INSERT INTO customer_files (customer_id, filename, original_name, file_type) VALUES (?, ?, ?, ?)`;
  db.run(sql, [customer_id, req.file.filename, req.file.originalname, req.file.mimetype], (err) => {
    if (err) console.error('Fehler beim Dateiupload:', err.message);
    res.redirect(`/customers/${customer_id}/projects`);
  });
});

app.get('/customers', (req, res) => {
  db.all('SELECT * FROM customers ORDER BY created_at DESC', [], (err, customers) => {
    res.render('customers', { customers: customers || [] });
  });
});

app.post('/customers/add', (req, res) => {
  const { company_name, contact_person, email, phone, street, zip, city } = req.body;

  const sql = `
    INSERT INTO customers (company_name, contact_person, email, phone, street, zip, city)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(sql, [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null], (err) => {
    if (err) return res.status(500).send('Fehler beim Speichern');
    res.redirect('/customers');
  });
});

// ==========================================
// ANGEBOTSVERWALTUNG & UMWANDLUNG
// ==========================================
app.get('/documents/offers', (req, res) => {
  const query = `
    SELECT documents.*, customers.company_name, customers.contact_person 
    FROM documents 
    LEFT JOIN customers ON documents.customer_id = customers.id
    WHERE doc_type = 'OFFER'
    ORDER BY documents.created_at DESC`;
    
  db.all(query, [], (err, offers) => {
    db.all('SELECT * FROM customers', [], (err, customers) => {
      db.all('SELECT * FROM articles ORDER BY title ASC', [], (err, articles) => {
        res.render('offers', { 
          offers: offers || [], 
          customers: customers || [],
          articles: articles || []
        });
      });
    });
  });
});

app.post('/documents/create-offer', (req, res) => {
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

  const sqlOffer = `
    INSERT INTO documents (doc_type, doc_number, customer_id, total_amount, status)
    VALUES ('OFFER', ?, ?, ?, 'GESENDET')
  `;

  db.run(sqlOffer, [docNumber, customer_id, totalAmount], function (err) {
    if (err) {
      console.error('❌ Fehler beim Erstellen des Angebots:', err.message);
      return res.status(500).send('Fehler beim Speichern des Angebots');
    }

    const offerId = this.lastID;
    const stmt = db.prepare('INSERT INTO offer_items (offer_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)');

    itemsToInsert.forEach(item => {
      stmt.run(offerId, item.description, item.quantity, item.unit, item.price);
    });

    stmt.finalize(() => {
      res.redirect('/documents/offers');
    });
  });
});

app.post('/documents/offers/delete', (req, res) => {
  const { offer_id } = req.body;

  db.run(`DELETE FROM offer_items WHERE offer_id = ?`, [offer_id], () => {
    db.run(`DELETE FROM documents WHERE id = ? AND doc_type = 'OFFER'`, [offer_id], (err) => {
      if (err) {
        console.error('❌ Fehler beim Löschen des Angebots:', err.message);
        return res.status(500).send('Fehler beim Löschen des Angebots');
      }
      res.redirect('/documents/offers');
    });
  });
});

app.post('/documents/offers/convert-to-invoice', (req, res) => {
  const { offer_id } = req.body;

  db.get('SELECT * FROM documents WHERE id = ? AND doc_type = "OFFER"', [offer_id], (err, offer) => {
    if (err || !offer) return res.status(404).send('Angebot nicht gefunden');

    const invoiceNumber = 'RE-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
    
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 14);

    const sqlInvoice = `
      INSERT INTO invoices (invoice_number, customer_id, total_amount, status, due_date)
      VALUES (?, ?, ?, 'Gesendet', ?)
    `;

    db.run(sqlInvoice, [invoiceNumber, offer.customer_id, offer.total_amount, dueDate.toISOString().split('T')[0]], function(err) {
      if (err) return res.status(500).send('Fehler beim Umwandeln des Angebots');

      const invoiceId = this.lastID;

      db.all('SELECT * FROM offer_items WHERE offer_id = ?', [offer_id], (err, items) => {
        if (!items || items.length === 0) {
          db.run(
            'INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, 1, "Psch", ?)',
            [invoiceId, 'Übernahme aus Angebot #' + offer.doc_number, offer.total_amount]
          );
        } else {
          const stmt = db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)');
          items.forEach(item => {
            stmt.run(invoiceId, item.description, item.quantity, item.unit, item.price);
          });
          stmt.finalize();
        }

        db.run('UPDATE documents SET status = "ANGENOMMEN" WHERE id = ?', [offer_id]);
        res.redirect('/documents/invoices/' + invoiceId);
      });
    });
  });
});

// ==========================================
// RECHNUNGSVERWALTUNG & MAHNWESEN
// ==========================================
app.get('/documents/invoices/:id/pdf', (req, res) => {
  const { id } = req.params;
  const sqlInvoice = `
    SELECT invoices.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city 
    FROM invoices 
    LEFT JOIN customers ON invoices.customer_id = customers.id
    WHERE invoices.id = ?
  `;
  db.get(sqlInvoice, [id], (err, invoice) => {
    if (err || !invoice) return res.status(404).send('Rechnung nicht gefunden');

    db.all('SELECT * FROM invoice_items WHERE invoice_id = ?', [id], (err, items) => {
      res.render('invoice-pdf', { invoice, items: items || [] });
    });
  });
});

app.get('/documents/invoices/:id', (req, res) => {
  const { id } = req.params;
  const sqlInvoice = `
    SELECT invoices.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city 
    FROM invoices 
    LEFT JOIN customers ON invoices.customer_id = customers.id
    WHERE invoices.id = ?
  `;

  db.get(sqlInvoice, [id], (err, invoice) => {
    if (err || !invoice) return res.status(404).send('Rechnung nicht gefunden');

    db.all('SELECT * FROM invoice_items WHERE invoice_id = ?', [id], (err, items) => {
      res.render('invoice-detail', { invoice, items: items || [] });
    });
  });
});

app.get('/documents/invoices', (req, res) => {
  const statusFilter = req.query.status;

  let sqlInvoices = `
    SELECT invoices.*, customers.company_name, customers.contact_person 
    FROM invoices 
    LEFT JOIN customers ON invoices.customer_id = customers.id
  `;
  let params = [];

  if (statusFilter) {
    sqlInvoices += " WHERE invoices.status = ?";
    params.push(statusFilter);
  }

  sqlInvoices += " ORDER BY invoices.created_at DESC";

  db.all(sqlInvoices, params, (err, invoices) => {
    if (err) return res.status(500).send('Datenbankfehler');

    db.all('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC', [], (err, customers) => {
      db.all('SELECT * FROM articles ORDER BY title ASC', [], (err, articles) => {
        res.render('invoices', {
          invoices: invoices || [],
          customers: customers || [],
          articles: articles || [],
          currentStatus: statusFilter || 'Alle'
        });
      });
    });
  });
});

app.post('/documents/create-invoice', (req, res) => {
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

  const sqlInvoice = `
    INSERT INTO invoices (invoice_number, customer_id, total_amount, status, due_date)
    VALUES (?, ?, ?, 'Gesendet', ?)
  `;

  db.run(sqlInvoice, [invoiceNumber, customer_id, totalAmount, dueDate.toISOString().split('T')[0]], function (err) {
    if (err) return res.status(500).send('Fehler beim Speichern der Rechnung');

    const invoiceId = this.lastID;
    const stmt = db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)');

    itemsToInsert.forEach(item => {
      stmt.run(invoiceId, item.description, item.quantity, item.unit, item.price);
    });

    stmt.finalize(() => {
      res.redirect('/documents/invoices');
    });
  });
});

app.post('/documents/invoices/increase-dunning', (req, res) => {
  const { invoice_id } = req.body;
  const sql = `UPDATE invoices SET dunning_level = dunning_level + 1, status = 'Überfällig' WHERE id = ?`;
  db.run(sql, [invoice_id], (err) => {
    if (err) console.error('Fehler beim Aktualisieren der Mahnstufe:', err.message);
    res.redirect('/documents/invoices');
  });
});

app.post('/documents/invoices/update-status', (req, res) => {
  const { invoice_id, status, status_note } = req.body;
  const sql = `UPDATE invoices SET status = ?, status_note = ? WHERE id = ?`;
  
  db.run(sql, [status, status_note || null, invoice_id], (err) => {
    if (err) return res.status(500).send('Fehler beim Aktualisieren');
    res.redirect('/documents/invoices');
  });
});

app.post('/documents/invoices/delete', (req, res) => {
  const { invoice_id } = req.body;
  db.run(`DELETE FROM invoice_items WHERE invoice_id = ?`, [invoice_id], () => {
    db.run(`DELETE FROM invoices WHERE id = ?`, [invoice_id], (err) => {
      if (err) return res.status(500).send('Fehler beim Löschen');
      res.redirect('/documents/invoices');
    });
  });
});

// ==========================================
// ARTIKEL- & MATERIALSTAMM
// ==========================================
app.get('/articles', (req, res) => {
  db.all('SELECT * FROM articles ORDER BY title ASC', [], (err, articles) => {
    res.render('articles', { articles: articles || [] });
  });
});

app.post('/articles/add', (req, res) => {
  const { title, unit, unit_price, description } = req.body;
  const parsedPrice = String(unit_price).replace(',', '.');

  const sql = `INSERT INTO articles (title, unit, unit_price, description) VALUES (?, ?, ?, ?)`;
  db.run(sql, [title, unit, parseFloat(parsedPrice) || 0, description || null], (err) => {
    if (err) console.error('Fehler beim Anlegen des Artikels:', err.message);
    res.redirect('/articles');
  });
});

app.post('/articles/delete', (req, res) => {
  const { id } = req.body;
  db.run('DELETE FROM articles WHERE id = ?', [id], () => {
    res.redirect('/articles');
  });
});

// ==========================================
// KALENDER & TERMINE
// ==========================================
app.get('/calendar', (req, res) => {
  db.all('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC', [], (err, customers) => {
    res.render('calendar', { customers: customers || [] });
  });
});

app.get('/api/appointments', (req, res) => {
  const query = `
    SELECT appointments.id, appointments.title, appointments.start_date as start, 
           appointments.end_date as end, appointments.description,
           customers.company_name, customers.contact_person
    FROM appointments
    LEFT JOIN customers ON appointments.customer_id = customers.id
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json([]);
    
    const events = (rows || []).map(app => ({
      id: app.id,
      title: `${app.title} (${app.company_name || app.contact_person || 'Privat'})`,
      start: app.start,
      end: app.end,
      description: app.description
    }));
    res.json(events);
  });
});

app.post('/api/appointments/add', (req, res) => {
  const { title, customer_id, start_date, end_date, description } = req.body;

  const sql = `
    INSERT INTO appointments (title, customer_id, start_date, end_date, description)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(sql, [title, customer_id || null, start_date, end_date || null, description], (err) => {
    if (err) return res.status(500).send('Fehler beim Speichern');
    res.redirect('/calendar');
  });
});

app.post('/api/appointments/delete/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM appointments WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('Fehler beim Löschen');
    res.redirect('/calendar');
  });
});

// ==========================================
// AUFTRÄGE & BAUSTELLEN (Mit Zeichnungen & Uploads)
// ==========================================
app.get('/projects', (req, res) => {
  const sql = `
    SELECT projects.*, customers.company_name, customers.contact_person, customers.street, customers.city
    FROM projects
    LEFT JOIN customers ON projects.customer_id = customers.id
    ORDER BY projects.created_at DESC
  `;
  db.all(sql, [], (err, projects) => {
    db.all('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC', [], (err, customers) => {
      res.render('projects', { projects: projects || [], customers: customers || [] });
    });
  });
});

app.post('/projects/add', (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  
  const { customer_id, title, description, total_price, status } = req.body;
  const parsedPrice = parseFloat(String(total_price || '0').replace(',', '.')) || 0;

  const sql = `
    INSERT INTO projects (customer_id, title, description, total_price, status)
    VALUES (?, ?, ?, ?, ?)
  `;
  db.run(sql, [customer_id || null, title, description || null, parsedPrice, status || 'In Planung'], (err) => {
    if (err) console.error('Fehler beim Erstellen des Auftrags:', err.message);
    res.redirect('/projects');
  });
});

app.get('/projects/:id', (req, res) => {
  const { id } = req.params;

  const sqlProject = `
    SELECT projects.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city
    FROM projects
    LEFT JOIN customers ON projects.customer_id = customers.id
    WHERE projects.id = ?
  `;

  db.get(sqlProject, [id], (err, project) => {
    if (err || !project) return res.status(404).send('Auftrag nicht gefunden');

    db.all('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at DESC', [id], (err, files) => {
      db.all('SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC', [project.customer_id], (err, appointments) => {
        res.render('project-detail', {
          project,
          files: files || [],
          appointments: appointments || []
        });
      });
    });
  });
});

app.post('/projects/:id/upload', upload.single('file'), (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.redirect(`/projects/${projectId}`);

  const sql = `INSERT INTO project_files (project_id, filename, original_name, file_type) VALUES (?, ?, ?, ?)`;
  db.run(sql, [projectId, req.file.filename, req.file.originalname, req.file.mimetype], (err) => {
    if (err) console.error('Fehler beim Upload:', err.message);
    res.redirect(`/projects/${projectId}`);
  });
});

app.post('/projects/delete', (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id } = req.body;
  db.run('DELETE FROM project_files WHERE project_id = ?', [id], () => {
    db.run('DELETE FROM projects WHERE id = ?', [id], () => {
      res.redirect('/projects');
    });
  });
});

// ==========================================
// MITARBEITER-VERWALTUNG (Nur für Chefs)
// ==========================================
app.get('/admin/users', verifyToken, requireAdmin, (req, res) => {
  db.all('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC', [], (err, users) => {
    res.render('admin-users', { users: users || [] });
  });
});

app.post('/admin/users/add', verifyToken, requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).send('Benutzername und Passwort erforderlich');

  const hashedPassword = bcrypt.hashSync(password, 10);
  const userRole = role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';

  const sql = `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`;
  db.run(sql, [username, hashedPassword, userRole], (err) => {
    if (err) {
      console.error('Fehler beim Erstellen des Benutzers:', err.message);
      return res.status(500).send('Benutzername existiert möglicherweise bereits.');
    }
    res.redirect('/admin/users');
  });
});

app.post('/admin/users/delete', verifyToken, requireAdmin, (req, res) => {
  const { id } = req.body;
  if (parseInt(id) === req.user.id) {
    return res.status(400).send('Du kannst deinen eigenen Account nicht löschen.');
  }

  db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
    if (err) console.error('Fehler beim Löschen:', err.message);
    res.redirect('/admin/users');
  });
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