const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // 1. Tabelle für Benutzer (Users)
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

  // 3. Tabelle für Dokumente (Angebote / Verträge)
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
  
  // 5. Tabelle für Rechnungen
  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT UNIQUE,
      customer_id INTEGER,
      total_amount REAL,
      status TEXT DEFAULT 'Gesendet',
      status_note TEXT,
      due_date DATE,
      dunning_level INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers (id)
    )
  `);

  // 6. Tabelle für Rechnungspositionen
  db.run(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      description TEXT,
      quantity REAL,
      unit TEXT,
      price REAL,
      FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE
    )
  `);

  // 7. NEW (Idee 4): Artikelstamm / Materialkatalog
  db.run(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      unit TEXT DEFAULT 'Stk',
      unit_price REAL DEFAULT 0.0,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 8. NEW (Idee 2): Angebotspositionen für die spätere Umwandlung
  db.run(`
    CREATE TABLE IF NOT EXISTS offer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      description TEXT,
      quantity REAL DEFAULT 1,
      unit TEXT DEFAULT 'Stk',
      price REAL DEFAULT 0,
      FOREIGN KEY(offer_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  // 9. NEW (Idee 5): Kunden-Dateien & Baustellenfotos
  db.run(`
    CREATE TABLE IF NOT EXISTS customer_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  // Migrationen / Spaltenerweiterungen (falls existierende DBs geupdatet werden)
  db.run(`ALTER TABLE invoices ADD COLUMN status_note TEXT`, (err) => {});
  db.run(`ALTER TABLE invoices ADD COLUMN due_date DATE`, (err) => {});
  db.run(`ALTER TABLE invoices ADD COLUMN dunning_level INTEGER DEFAULT 0`, (err) => {});
});

module.exports = db;