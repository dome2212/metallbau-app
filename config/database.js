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

  console.log("Verbunden mit PostgreSQL (Cloud)");

  // Tabellen erstellen (PostgreSQL Syntax)
  db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'EMPLOYEE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (!err) {
      db.query(`SELECT * FROM users WHERE role = 'ADMIN'`, (err, res) => {
        if (res && res.rows.length === 0) {
          const hashedPassword = bcrypt.hashSync('chef123', 10);
          db.query(`INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)`, ['chef', hashedPassword, 'ADMIN']);
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
  `);

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
  `);

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
  `);

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
  `);

  db.query(`
    CREATE TABLE IF NOT EXISTS offer_items (
      id SERIAL PRIMARY KEY,
      offer_id INTEGER,
      description TEXT,
      quantity REAL,
      unit TEXT,
      price REAL
    )
  `);

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
  `);

  db.query(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER,
      description TEXT,
      quantity REAL,
      unit TEXT,
      price REAL
    )
  `);

  db.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id SERIAL PRIMARY KEY,
      title TEXT,
      unit TEXT,
      unit_price REAL,
      description TEXT
    )
  `);

  db.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      title TEXT,
      customer_id INTEGER,
      start_date TEXT,
      end_date TEXT,
      description TEXT
    )
  `);

  db.query(`
    CREATE TABLE IF NOT EXISTS customer_files (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER,
      filename TEXT,
      original_name TEXT,
      file_type TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.query(`
    CREATE TABLE IF NOT EXISTS project_files (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      filename TEXT,
      original_name TEXT,
      file_type TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

} else {
  // Lokale Entwicklung (SQLite)
  const dbPath = path.join(__dirname, '../database.sqlite');
  db = new sqlite3.Database(dbPath);
  console.log("Verbunden mit SQLite (Lokal)");
}

module.exports = db;