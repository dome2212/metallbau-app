const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

let db;

if (process.env.DATABASE_URL) {
  // Cloud (Render / PostgreSQL)
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Pool-Verbindungen auf UTC halten — Timestamps werden als UTC gespeichert
  // und beim Lesen serverseitig nach Europe/Berlin konvertiert
  db.on('connect', (client) => {
    client.query("SET timezone = 'UTC';").catch(() => {});
  });

  console.log("🟢 Versuche mit PostgreSQL zu verbinden und Tabellen zu erstellen...");

  // Tabellen erstellen (PostgreSQL Syntax) mit Fehlerprüfung
  db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'EMPLOYEE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error("❌ FEHLER beim Erstellen der users-Tabelle:", err.message);
    } else {
      console.log("✅ users-Tabelle bereit!");
      // Bestehende ADMIN-Nutzer auf CHEF migrieren (einmalig)
      db.query(`UPDATE users SET role = 'CHEF' WHERE role = 'ADMIN'`, (err) => {
        if (err) console.error("⚠️ Migration ADMIN→CHEF:", err.message);
        else console.log("✅ Rollen-Migration ADMIN→CHEF abgeschlossen.");
      });
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      company_name TEXT,
      contact_person TEXT,
      email TEXT,
      phone TEXT,
      street TEXT,
      zip TEXT,
      city TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler customers:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS time_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      project_id INTEGER,
      customer_id INTEGER,
      type TEXT CHECK(type IN ('IN', 'OUT')) NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      note TEXT,
      latitude REAL,
      longitude REAL
    )
  `, (err) => {
    if (err) console.error("❌ Fehler time_logs:", err.message);
    else {
      db.query(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS customer_id INTEGER`, () => {});
      db.query(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS note TEXT`, () => {});
      db.query(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS latitude REAL`, () => {});
      db.query(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS longitude REAL`, () => {});
      db.query(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS project_id INTEGER`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'In Planung',
      total_price REAL DEFAULT 0,
      site_lat NUMERIC(10,8),
      site_lng NUMERIC(11,8),
      site_radius INTEGER DEFAULT 200,
      site_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("❌ Fehler projects:", err.message);
    else {
      db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lat NUMERIC(10,8)`, () => {});
      db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lng NUMERIC(11,8)`, () => {});
      db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_radius INTEGER DEFAULT 200`, () => {});
      db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_note TEXT`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      doc_type TEXT,
      doc_number TEXT,
      customer_id INTEGER,
      total_amount REAL,
      status TEXT,
      tax_rate NUMERIC(5,2) DEFAULT 19,
      subtotal NUMERIC(12,2) DEFAULT 0,
      tax_amount NUMERIC(12,2) DEFAULT 0,
      due_date TEXT,
      status_note TEXT,
      dunning_level INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("❌ Fehler documents:", err.message);
    else {
      db.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 19`, () => {});
      db.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) DEFAULT 0`, () => {});
      db.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) DEFAULT 0`, () => {});
      db.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS due_date TEXT`, () => {});
      db.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_note TEXT`, () => {});
      db.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS dunning_level INTEGER DEFAULT 0`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS document_items (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL,
      description TEXT,
      quantity NUMERIC(10,3) DEFAULT 1,
      unit TEXT DEFAULT 'Stk',
      price NUMERIC(12,2) DEFAULT 0
    )
  `, (err) => { if (err) console.error("❌ Fehler document_items:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS offer_items (
      id SERIAL PRIMARY KEY,
      offer_id INTEGER,
      description TEXT,
      quantity REAL,
      unit TEXT,
      price REAL
    )
  `, (err) => { if (err) console.error("❌ Fehler offer_items:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_number TEXT,
      customer_id INTEGER,
      total_amount REAL,
      status TEXT,
      due_date TEXT,
      dunning_level INTEGER DEFAULT 0,
      status_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler invoices:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER,
      description TEXT,
      quantity REAL,
      unit TEXT,
      price REAL
    )
  `, (err) => { if (err) console.error("❌ Fehler invoice_items:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      unit TEXT,
      unit_price NUMERIC(10,2) DEFAULT 0,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("❌ Fehler articles:", err.message);
    else {
      db.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      title TEXT,
      customer_id INTEGER,
      start_date TEXT,
      end_date TEXT,
      description TEXT,
      project_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("❌ Fehler appointments:", err.message);
    else {
      db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS project_id INTEGER`, () => {});
      db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS vacations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      type TEXT DEFAULT 'Urlaub',
      file_url TEXT,
      status TEXT DEFAULT 'Beantragt',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("❌ Fehler vacations:", err.message);
    else {
      db.query(`ALTER TABLE vacations ADD COLUMN IF NOT EXISTS file_url TEXT`, () => {});
      db.query(`ALTER TABLE vacations ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'Urlaub'`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS project_photos (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      file_url TEXT NOT NULL,
      original_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler project_photos:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS project_measurements (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      component_name TEXT NOT NULL,
      width TEXT,
      height TEXT,
      angle TEXT,
      quantity INTEGER DEFAULT 1,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler project_measurements:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS project_notes (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      note_text TEXT NOT NULL,
      audio_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("❌ Fehler project_notes:", err.message);
    else {
      db.query(`ALTER TABLE project_notes ADD COLUMN IF NOT EXISTS audio_url TEXT`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'Restarbeit',
      status TEXT DEFAULT 'Offen',
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler project_tasks:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS project_sketches (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      title TEXT,
      image_data TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler project_sketches:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS tickers (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      author TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler tickers:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS appointment_users (
      appointment_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (appointment_id, user_id)
    )
  `, (err) => { if (err) console.error("❌ Fehler appointment_users:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT,
      auth TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler push_subscriptions:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS customer_files (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER,
      filename TEXT,
      original_name TEXT,
      file_type TEXT,
      file_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler customer_files:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS project_files (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      filename TEXT,
      original_name TEXT,
      file_type TEXT,
      file_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler project_files:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler user_settings:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS company_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler company_settings:", err.message); });

  // users: fehlende Spalten nachrüsten
  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vacation_allowance INTEGER DEFAULT 30`, () => {});
  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT`, () => {});
  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_api_key TEXT`, () => {});
  db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_notify BOOLEAN DEFAULT true`, () => {});

} else {
  // Lokale Entwicklung (SQLite)
  const dbPath = path.join(__dirname, '../database.sqlite');
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error("❌ Fehler beim Öffnen der SQLite-Datenbank:", err.message);
      return;
    }
    console.log("Verbunden mit SQLite (Lokal)");

    // Tabellen für lokale SQLite-Umgebung erstellen
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'EMPLOYEE',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

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

      db.run(`
        CREATE TABLE IF NOT EXISTS time_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          project_id INTEGER,
          customer_id INTEGER,
          type TEXT CHECK(type IN ('IN', 'OUT')) NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          note TEXT,
          latitude REAL,
          longitude REAL
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'In Planung',
          total_price REAL DEFAULT 0,
          site_lat REAL,
          site_lng REAL,
          site_radius INTEGER DEFAULT 200,
          site_note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_type TEXT,
          doc_number TEXT,
          customer_id INTEGER,
          total_amount REAL,
          status TEXT,
          tax_rate NUMERIC(5,2) DEFAULT 19,
          subtotal NUMERIC(12,2) DEFAULT 0,
          tax_amount NUMERIC(12,2) DEFAULT 0,
          due_date TEXT,
          status_note TEXT,
          dunning_level INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 19`, () => {});
      db.run(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) DEFAULT 0`, () => {});
      db.run(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) DEFAULT 0`, () => {});
      db.run(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS due_date TEXT`, () => {});
      db.run(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status_note TEXT`, () => {});
      db.run(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS dunning_level INTEGER DEFAULT 0`, () => {});

      db.run(`
        CREATE TABLE IF NOT EXISTS document_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL,
          description TEXT,
          quantity NUMERIC(10,3) DEFAULT 1,
          unit TEXT DEFAULT 'Stk',
          price NUMERIC(12,2) DEFAULT 0
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS offer_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          offer_id INTEGER,
          description TEXT,
          quantity REAL,
          unit TEXT,
          price REAL
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_number TEXT,
          customer_id INTEGER,
          total_amount REAL,
          status TEXT,
          due_date TEXT,
          dunning_level INTEGER DEFAULT 0,
          status_note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS invoice_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_id INTEGER,
          description TEXT,
          quantity REAL,
          unit TEXT,
          price REAL
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS articles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          unit TEXT,
          unit_price NUMERIC(10,2) DEFAULT 0,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP`, () => {});

      db.run(`
        CREATE TABLE IF NOT EXISTS appointments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          customer_id INTEGER,
          start_date TEXT,
          end_date TEXT,
          description TEXT,
          project_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS project_id INTEGER`, () => {});
      db.run(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP`, () => {});

      db.run(`
        CREATE TABLE IF NOT EXISTS project_sketches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          title TEXT,
          image_data TEXT NOT NULL,
          created_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS project_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          category TEXT DEFAULT 'Restarbeit',
          status TEXT DEFAULT 'Offen',
          photo_url TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS vacations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          reason TEXT,
          type TEXT DEFAULT 'Urlaub',
          file_url TEXT,
          status TEXT DEFAULT 'Beantragt',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`ALTER TABLE vacations ADD COLUMN IF NOT EXISTS file_url TEXT`, () => {});
      db.run(`ALTER TABLE vacations ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'Urlaub'`, () => {});

      db.run(`
        CREATE TABLE IF NOT EXISTS project_photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          file_url TEXT NOT NULL,
          original_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS project_measurements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          component_name TEXT NOT NULL,
          width TEXT,
          height TEXT,
          angle TEXT,
          quantity INTEGER DEFAULT 1,
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS project_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          note_text TEXT NOT NULL,
          audio_url TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`ALTER TABLE project_notes ADD COLUMN IF NOT EXISTS audio_url TEXT`, () => {});

      db.run(`
        CREATE TABLE IF NOT EXISTS tickers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message TEXT NOT NULL,
          author TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS appointment_users (
          appointment_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          PRIMARY KEY (appointment_id, user_id)
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT,
          auth TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS company_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // users: fehlende Spalten nachrüsten (für bestehende DBs)
      db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vacation_allowance INTEGER DEFAULT 30`, () => {});
      db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT`, () => {});
      db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_api_key TEXT`, () => {});
      db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_notify INTEGER DEFAULT 1`, () => {});

      // time_logs: fehlende Spalten nachrüsten (für bestehende DBs)
      db.run(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS customer_id INTEGER`, () => {});
      db.run(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS note TEXT`, () => {});
      db.run(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS latitude REAL`, () => {});
      db.run(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS longitude REAL`, () => {});
      db.run(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS project_id INTEGER`, () => {});

      // projects: fehlende Spalten nachrüsten (für bestehende DBs)
      db.run(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lat REAL`, () => {});
      db.run(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lng REAL`, () => {});
      db.run(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_radius INTEGER DEFAULT 200`, () => {});
      db.run(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_note TEXT`, () => {});

      db.run(`
        CREATE TABLE IF NOT EXISTS customer_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER,
          filename TEXT,
          original_name TEXT,
          file_type TEXT,
          file_url TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS project_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          filename TEXT,
          original_name TEXT,
          file_type TEXT,
          file_url TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS user_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE,
          settings_json TEXT NOT NULL DEFAULT '{}',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Bestehende ADMIN-Nutzer auf CHEF migrieren (einmalig)
      db.run(`UPDATE users SET role = 'CHEF' WHERE role = 'ADMIN'`, (err) => {
        if (!err) console.log("✅ Rollen-Migration ADMIN→CHEF abgeschlossen.");
      });
      // Chef-User lokal prüfen/anlegen
      db.get(`SELECT * FROM users WHERE role = 'CHEF'`, (err, row) => {
        if (!row) {
          const hashedPassword = bcrypt.hashSync('chef123', 10);
          db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, ['chef', hashedPassword, 'CHEF'], (err) => {
            if (!err) console.log("✅ Lokaler Chef-User 'chef' erfolgreich erstellt!");
          });
        }
      });
    });
  });
}

module.exports = db;
