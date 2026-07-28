const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // 1. Tabelle für Benutzer (Users) anlegen
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'EMPLOYEE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Tabelle für Kunden
  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT,
      contact_person TEXT,
      email TEXT,
      phone TEXT,
      street TEXT,
      zip TEXT,
      city TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Tabelle für Dokumente (Angebote / Rechnungen)
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL,
      doc_number TEXT NOT NULL,
      customer_id INTEGER,
      status TEXT DEFAULT 'ENTWURF',
      tax_rate REAL DEFAULT 19.0,
      subtotal REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      total_amount REAL DEFAULT 0.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);
  
    // 4. Tabelle für Termine (Aufmaß, Montage, Kundengespräche)
  db.run(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      start_date DATETIME NOT NULL,
      end_date DATETIME,
      customer_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);
  
   // 5. Tabelle für Rechnungen hinzufügen
  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT UNIQUE,
      customer_id INTEGER,
      total_amount REAL,
      status TEXT DEFAULT 'Gesendet',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers (id)
    )
  `);

 // 6. Tabelle für einzelne Rechnungspositionen hinzufügen
  db.run(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      description TEXT,
      quantity REAL,
      unit TEXT,
      price REAL,
      FOREIGN KEY (invoice_id) REFERENCES invoices (id)
    )
  `);
  
  // 7. Tabelle löschen
  db.run(`ALTER TABLE invoices ADD COLUMN status_note TEXT`, (err) => {
});


});

module.exports = db;
