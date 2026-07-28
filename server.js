const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const db = require('./config/database');
const { verifyToken, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. EJS & Middleware Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// 2. Öffentliche Routen (Login / Logout)
app.use('/', authRoutes);

// 3. ALLE DARAUFFOLGENDEN ROUTEN SCHÜTZEN
app.use(verifyToken); 
app.use('/documents', documentRoutes);

// ==========================================
// DASHBOARD (Echte Daten aus der Datenbank)
// ==========================================
app.get('/', (req, res) => {
  // 1. Offene Angebote abfragen
  const sqlOffers = `
    SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
    FROM documents 
    WHERE doc_type = 'OFFER' AND status != 'ANGENOMMEN' AND status != 'ABGELEHNT'
  `;

  // 2. Unbezahlte Rechnungen abfragen
  const sqlInvoices = `
    SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
    FROM invoices 
    WHERE status != 'Bezahlt'
  `;

  // 3. Gesamtanzahl Kunden abfragen
  const sqlCustomers = `SELECT COUNT(*) as count FROM customers`;

  // 4. Letzte Vorgänge (Angebote + Rechnungen) abfragen
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
});

// ==========================================
// KUNDENVERWALTUNG
// ==========================================
// POST: Kunde bearbeiten
app.post('/customers/edit', (req, res) => {
  const { id, company_name, contact_person, email, phone, street, zip, city } = req.body;

  const sql = `
    UPDATE customers 
    SET company_name = ?, contact_person = ?, email = ?, phone = ?, street = ?, zip = ?, city = ?
    WHERE id = ?
  `;

  db.run(sql, [company_name || null, contact_person || null, email || null, phone || null, street || null, zip || null, city || null, id], (err) => {
    if (err) {
      console.error('Fehler beim Bearbeiten des Kunden:', err.message);
      return res.status(500).send('Fehler beim Aktualisieren');
    }
    res.redirect('/customers');
  });
});

// POST: Kunde löschen
app.post('/customers/delete', (req, res) => {
  const { id } = req.body;

  db.run('DELETE FROM customers WHERE id = ?', [id], (err) => {
    if (err) {
      console.error('Fehler beim Löschen des Kunden:', err.message);
      return res.status(500).send('Fehler beim Löschen');
    }
    res.redirect('/customers');
  });
});

// GET: Projekte/Vorgänge eines bestimmten Kunden anzeigen
app.get('/customers/:id/projects', (req, res) => {
  const { id } = req.params;

  // 1. Kunde abfragen
  db.get('SELECT * FROM customers WHERE id = ?', [id], (err, customer) => {
    if (err || !customer) return res.status(404).send('Kunde nicht gefunden');

    // 2. Angebote des Kunden
    db.all("SELECT * FROM documents WHERE customer_id = ? AND doc_type = 'OFFER' ORDER BY created_at DESC", [id], (err, offers) => {
      // 3. Rechnungen des Kunden
      db.all("SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC", [id], (err, invoices) => {
        // 4. Termine des Kunden
        db.all("SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC", [id], (err, appointments) => {
          
          res.render('customer-projects', {
            customer,
            offers: offers || [],
            invoices: invoices || [],
            appointments: appointments || []
          });

        });
      });
    });
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

  db.run(sql, [
    company_name || null, 
    contact_person || null, 
    email || null, 
    phone || null, 
    street || null, 
    zip || null, 
    city || null
  ], function (err) {
    if (err) {
      console.error('❌ SQL-Fehler beim Kunden-Speichern:', err.message);
      return res.status(500).send(`<h2>Fehler beim Speichern:</h2><p style="color:red;">${err.message}</p><a href="/customers">Zurück</a>`);
    }
    res.redirect('/customers');
  });
});

// ==========================================
// ANGEBOTSVERWALTUNG
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
      res.render('offers', { 
        offers: offers || [], 
        customers: customers || [] 
      });
    });
  });
});

// ==========================================
// RECHNUNGSVERWALTUNG
// ==========================================

// GET: Rechnungs-Details anzeigen (Material, Arbeitsstunden, Positionen)
app.get('/documents/invoices/:id', (req, res) => {
  const { id } = req.params;

  const sqlInvoice = `
    SELECT invoices.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city 
    FROM invoices 
    LEFT JOIN customers ON invoices.customer_id = customers.id
    WHERE invoices.id = ?
  `;

  const sqlItems = `SELECT * FROM invoice_items WHERE invoice_id = ?`;

  db.get(sqlInvoice, [id], (err, invoice) => {
    if (err || !invoice) {
      return res.status(404).send('Rechnung nicht gefunden');
    }

    db.all(sqlItems, [id], (err, items) => {
      res.render('invoice-detail', {
        invoice,
        items: items || []
      });
    });
  });
});

// GET: Rechnungs-Übersicht anzeigen (MIT FILTER-FUNKTION)
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
    if (err) {
      console.error('Fehler beim Abrufen der Rechnungen:', err.message);
      return res.status(500).send('Datenbankfehler');
    }

    db.all('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC', [], (err, customers) => {
      res.render('invoices', {
        invoices: invoices || [],
        customers: customers || [],
        currentStatus: statusFilter || 'Alle'
      });
    });
  });
});

// POST: Neue Rechnung anlegen (inkl. Komma-in-Punkt Umwandlung & flexiblen Feldnamen)
app.post('/documents/create-invoice', (req, res) => {
  const customer_id = req.body.customer_id;
  const title = req.body.title || req.body.description || 'Position 1';
  const quantity = req.body.quantity || '1';
  const unit = req.body.unit || 'Stk';
  const rawPrice = req.body.price || req.body.unit_price || '0';

  const invoiceNumber = 'RE-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
  
  // Wandelt Komma in Punkt um, falls der Nutzer "12,50" eingegeben hat
  const parsedQuantity = String(quantity).replace(',', '.');
  const parsedPrice = String(rawPrice).replace(',', '.');

  const qty = parseFloat(parsedQuantity) || 1;
  const unitPrice = parseFloat(parsedPrice) || 0;
  const totalAmount = qty * unitPrice;

  console.log(`📝 Erstelle Rechnung: Menge=${qty}, Preis=${unitPrice}, Gesamt=${totalAmount}`);

  const sqlInvoice = `
    INSERT INTO invoices (invoice_number, customer_id, total_amount, status)
    VALUES (?, ?, ?, 'Gesendet')
  `;

  db.run(sqlInvoice, [invoiceNumber, customer_id, totalAmount], function (err) {
    if (err) {
      console.error('❌ Fehler beim Erstellen der Rechnung:', err.message);
      return res.status(500).send('Fehler beim Speichern');
    }

    const invoiceId = this.lastID;
    const sqlItem = `
      INSERT INTO invoice_items (invoice_id, description, quantity, unit, price)
      VALUES (?, ?, ?, ?, ?)
    `;

    db.run(sqlItem, [invoiceId, title, qty, unit, unitPrice], (itemErr) => {
      if (itemErr) {
        console.error('❌ Fehler beim Speichern der Rechnungsposition:', itemErr.message);
      }
      res.redirect('/documents/invoices');
    });
  });
});

// POST: Status einer Rechnung ändern (Bezahlt, Überfällig, Verzögert)
app.post('/documents/invoices/update-status', (req, res) => {
  const { invoice_id, status, status_note } = req.body;

  const sql = `UPDATE invoices SET status = ?, status_note = ? WHERE id = ?`;
  
  db.run(sql, [status, status_note || null, invoice_id], (err) => {
    if (err) {
      console.error('Fehler beim Aktualisieren des Status:', err.message);
      return res.status(500).send('Fehler beim Aktualisieren');
    }
    res.redirect('/documents/invoices');
  });
});

// POST: Rechnung löschen
app.post('/documents/invoices/delete', (req, res) => {
  const { invoice_id } = req.body;

  db.run(`DELETE FROM invoice_items WHERE invoice_id = ?`, [invoice_id], (err) => {
    if (err) console.error('Fehler beim Löschen der Positionen:', err.message);

    db.run(`DELETE FROM invoices WHERE id = ?`, [invoice_id], (err) => {
      if (err) {
        console.error('Fehler beim Löschen der Rechnung:', err.message);
        return res.status(500).send('Fehler beim Löschen');
      }
      res.redirect('/documents/invoices');
    });
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

  db.run(sql, [title, customer_id || null, start_date, end_date || null, description], function(err) {
    if (err) {
      console.error('Fehler beim Termin-Speichern:', err.message);
      return res.status(500).send('Fehler beim Speichern');
    }
    res.redirect('/calendar');
  });
});

app.post('/api/appointments/delete/:id', (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM appointments WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('Fehler beim Löschen des Termins:', err.message);
      return res.status(500).send('Fehler beim Löschen');
    }
    res.redirect('/calendar');
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