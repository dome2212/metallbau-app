const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

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
  `, () => {
    // Automatisch einen Standard-Chef (Admin) anlegen, falls noch keiner existiert
    db.get(`SELECT * FROM users WHERE role = 'ADMIN'`, [], (err, admin) => {
      if (!admin) {
        const hashedPassword = bcrypt.hashSync('chef123', 10);
        db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, ['chef', hashedPassword, 'ADMIN']);
      }
    });
  });

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

  // 7. Artikelstamm / Materialkatalog
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

  // 8. Angebotspositionen für die spätere Umwandlung
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

  // 9. Kunden-Dateien & Baustellenfotos
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

  // 10. Zeiterfassung / Stempeluhr (mit optionalem Projektbezug)
  db.run(`
    CREATE TABLE IF NOT EXISTS time_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER,
      type TEXT CHECK(type IN ('IN', 'OUT')) NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      note TEXT,
      latitude REAL,
      longitude REAL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `, () => {
    // Falls time_logs bereits existierte, Spalten nachträglich sicherstellen
    db.run(`ALTER TABLE time_logs ADD COLUMN project_id INTEGER`, (err) => {});
    db.run(`ALTER TABLE time_logs ADD COLUMN latitude REAL`, (err) => {});
    db.run(`ALTER TABLE time_logs ADD COLUMN longitude REAL`, (err) => {});
  });

  // Migrationen / Spaltenerweiterungen für Rechnungen
  db.run(`ALTER TABLE invoices ADD COLUMN status_note TEXT`, (err) => {});
  db.run(`ALTER TABLE invoices ADD COLUMN due_date DATE`, (err) => {});
  db.run(`ALTER TABLE invoices ADD COLUMN dunning_level INTEGER DEFAULT 0`, (err) => {});
  
  // 11. Aufträge / Baustellen
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'In Planung',
      total_price REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  // 12. Projektspezifische Dateien (Zeichnungen, Skizzen, Fotos)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
});

module.exports = db;