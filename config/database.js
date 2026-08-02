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
      db.query(`SELECT * FROM users WHERE role = 'ADMIN'`, (err, res) => {
        if (res && res.rows.length === 0) {
          const hashedPassword = bcrypt.hashSync('chef123', 10);
          db.query(`INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)`, ['chef', hashedPassword, 'ADMIN'], (err) => {
            if (err) console.error("❌ Fehler beim Anlegen des Admin-Users:", err.message);
            else console.log("✅ Admin-User 'chef' erfolgreich erstellt!");
          });
        }
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
      type TEXT CHECK(type IN ('IN', 'OUT')) NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      note TEXT,
      latitude REAL,
      longitude REAL
    )
  `, (err) => { if (err) console.error("❌ Fehler time_logs:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'In Planung',
      total_price REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler projects:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      doc_type TEXT,
      doc_number TEXT,
      customer_id INTEGER,
      total_amount REAL,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler documents:", err.message); });

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
      title TEXT,
      unit TEXT,
      unit_price REAL,
      description TEXT
    )
  `, (err) => { if (err) console.error("❌ Fehler articles:", err.message); });

  db.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      title TEXT,
      customer_id INTEGER,
      start_date TEXT,
      end_date TEXT,
      description TEXT
    )
  `, (err) => { if (err) console.error("❌ Fehler appointments:", err.message); });

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
  `, (err) => { 
    if (err) console.error("❌ Fehler customer_files:", err.message); 
    else {
      db.query(`ALTER TABLE customer_files ADD COLUMN IF NOT EXISTS file_url TEXT`, () => {});
    }
  });

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
  `, (err) => {
    if (err) console.error("❌ Fehler project_files:", err.message);
    else {
      db.query(`ALTER TABLE project_files ADD COLUMN IF NOT EXISTS file_url TEXT`, () => {});
    }
  });

  db.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => { if (err) console.error("❌ Fehler user_settings:", err.message); });

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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
          title TEXT,
          unit TEXT,
          unit_price REAL,
          description TEXT
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS appointments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          customer_id INTEGER,
          start_date TEXT,
          end_date TEXT,
          description TEXT
        )
      `);

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

      // Admin-User lokal prüfen/anlegen
      db.get(`SELECT * FROM users WHERE role = 'ADMIN'`, (err, row) => {
        if (!row) {
          const hashedPassword = bcrypt.hashSync('chef123', 10);
          db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, ['chef', hashedPassword, 'ADMIN'], (err) => {
            if (!err) console.log("✅ Lokaler Admin-User 'chef' erfolgreich erstellt!");
          });
        }
      });
    });
  });
}

module.exports = db;
