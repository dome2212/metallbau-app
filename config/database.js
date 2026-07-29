const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

let db;

// Prüfen, ob eine Render PostgreSQL-URL vorhanden ist
if (process.env.DATABASE_URL) {
  // Cloud-Datenbank (Render / PostgreSQL)
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  console.log("Verbunden mit PostgreSQL (Cloud)");

  // Tabellen beim Start in PostgreSQL erstellen
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
      // Standard-Admin anlegen falls nicht vorhanden
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

} else {
  // Lokale Entwicklung (SQLite wie gewohnt)
  const dbPath = path.join(__dirname, '../database.sqlite');
  const sqliteDb = new sqlite3.Database(dbPath);
  
  console.log("Verbunden mit SQLite (Lokal)");
  
  // Hier bleibt deine lokale SQLite-Struktur erhalten
  db = sqliteDb;
}

module.exports = db;
