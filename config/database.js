const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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

      // Seed-Daten: gängige Metallbau-Artikel – nur einfügen wenn Tabelle noch leer
      db.query(`SELECT COUNT(*) AS cnt FROM articles`, (err2, res2) => {
        if (err2 || (res2.rows[0].cnt > 0)) return;
        const seed = [
          // ── Stahl-Profile ────────────────────────────────────────
          ['IPE 80',           'm',   8.50,  'I-Träger IPE 80, S235JR, blank'],
          ['IPE 100',          'm',  10.20,  'I-Träger IPE 100, S235JR, blank'],
          ['IPE 120',          'm',  12.80,  'I-Träger IPE 120, S235JR, blank'],
          ['IPE 140',          'm',  15.50,  'I-Träger IPE 140, S235JR, blank'],
          ['IPE 160',          'm',  18.90,  'I-Träger IPE 160, S235JR, blank'],
          ['IPE 200',          'm',  26.00,  'I-Träger IPE 200, S235JR, blank'],
          ['HEB 100',          'm',  20.40,  'HEB-Träger 100, S235JR, blank'],
          ['HEB 120',          'm',  26.50,  'HEB-Träger 120, S235JR, blank'],
          ['HEB 160',          'm',  42.60,  'HEB-Träger 160, S235JR, blank'],
          ['HEB 200',          'm',  61.00,  'HEB-Träger 200, S235JR, blank'],
          ['UNP 80',           'm',   7.80,  'U-Profil UNP 80, S235JR, blank'],
          ['UNP 100',          'm',   9.90,  'U-Profil UNP 100, S235JR, blank'],
          ['UNP 120',          'm',  13.20,  'U-Profil UNP 120, S235JR, blank'],
          ['UNP 160',          'm',  18.70,  'U-Profil UNP 160, S235JR, blank'],
          ['L-Profil 40x40x4', 'm',   4.20,  'Gleichschenkliges Winkelstahl L 40x40x4, S235JR'],
          ['L-Profil 50x50x5', 'm',   5.90,  'Gleichschenkliges Winkelstahl L 50x50x5, S235JR'],
          ['L-Profil 60x60x6', 'm',   8.10,  'Gleichschenkliges Winkelstahl L 60x60x6, S235JR'],
          ['L-Profil 80x80x8', 'm',  13.50,  'Gleichschenkliges Winkelstahl L 80x80x8, S235JR'],
          ['T-Profil 50x50x5', 'm',   6.80,  'T-Stahl 50x50x5, S235JR, blank'],
          ['Flachstahl 30x5',  'm',   2.10,  'Flachstahl 30x5 mm, S235JR, blank'],
          ['Flachstahl 40x5',  'm',   2.80,  'Flachstahl 40x5 mm, S235JR, blank'],
          ['Flachstahl 50x6',  'm',   4.10,  'Flachstahl 50x6 mm, S235JR, blank'],
          ['Flachstahl 60x8',  'm',   6.50,  'Flachstahl 60x8 mm, S235JR, blank'],
          ['Flachstahl 80x10', 'm',  10.20,  'Flachstahl 80x10 mm, S235JR, blank'],
          ['Vierkantrohr 20x20x2',  'm',  3.20,  'Vierkantrohr 20x20x2 mm, S235JR, blank'],
          ['Vierkantrohr 30x30x2',  'm',  4.60,  'Vierkantrohr 30x30x2 mm, S235JR, blank'],
          ['Vierkantrohr 40x40x3',  'm',  7.10,  'Vierkantrohr 40x40x3 mm, S235JR, blank'],
          ['Vierkantrohr 50x50x3',  'm',  9.20,  'Vierkantrohr 50x50x3 mm, S235JR, blank'],
          ['Vierkantrohr 60x60x4',  'm', 13.80,  'Vierkantrohr 60x60x4 mm, S235JR, blank'],
          ['Vierkantrohr 80x80x4',  'm', 18.90,  'Vierkantrohr 80x80x4 mm, S235JR, blank'],
          ['Rundrohr 33,7x2,6',     'm',  5.40,  'Rundrohr 33,7x2,6 mm (1"), S235JR, blank'],
          ['Rundrohr 42,4x2,6',     'm',  7.20,  'Rundrohr 42,4x2,6 mm (1¼"), S235JR, blank'],
          ['Rundrohr 48,3x2,6',     'm',  8.30,  'Rundrohr 48,3x2,6 mm (1½"), S235JR, blank'],
          ['Rundrohr 60,3x2,9',     'm', 11.50,  'Rundrohr 60,3x2,9 mm (2"), S235JR, blank'],
          ['Rundstahl Ø 12 mm',     'm',  1.80,  'Rundstahl Ø 12 mm, S235JR, blank'],
          ['Rundstahl Ø 16 mm',     'm',  3.10,  'Rundstahl Ø 16 mm, S235JR, blank'],
          ['Rundstahl Ø 20 mm',     'm',  4.80,  'Rundstahl Ø 20 mm, S235JR, blank'],
          // ── Bleche ──────────────────────────────────────────────
          ['Stahlblech 2 mm',   'm²',  18.00, 'Stahlblech DC01/S235, 2 mm stark'],
          ['Stahlblech 3 mm',   'm²',  26.00, 'Stahlblech DC01/S235, 3 mm stark'],
          ['Stahlblech 4 mm',   'm²',  34.00, 'Stahlblech S235JR, 4 mm stark'],
          ['Stahlblech 5 mm',   'm²',  42.00, 'Stahlblech S235JR, 5 mm stark'],
          ['Stahlblech 6 mm',   'm²',  50.00, 'Stahlblech S235JR, 6 mm stark'],
          ['Stahlblech 8 mm',   'm²',  66.00, 'Stahlblech S235JR, 8 mm stark'],
          ['Stahlblech 10 mm',  'm²',  82.00, 'Stahlblech S235JR, 10 mm stark'],
          ['Edelstahlblech 1,5 mm V2A', 'm²',  95.00, 'Edelstahlblech 1.4301 (V2A), 1,5 mm, Korn 240'],
          ['Edelstahlblech 2 mm V2A',   'm²', 120.00, 'Edelstahlblech 1.4301 (V2A), 2 mm, Korn 240'],
          ['Edelstahlblech 3 mm V2A',   'm²', 165.00, 'Edelstahlblech 1.4301 (V2A), 3 mm, Korn 240'],
          ['Lochblech Stahl 2 mm',      'm²',  32.00, 'Lochblech Rv 5-8, Stahl, 2 mm'],
          ['Gitterrost 30x30mm',        'm²',  48.00, 'Gitterrost MW 30x30, Flachstahl 25x2, feuerverzinkt'],
          // ── Edelstahl-Profile ────────────────────────────────────
          ['Edelstahl Vierkantrohr 40x40x2 V2A', 'm',  18.50, 'Vierkantrohr 40x40x2 mm, 1.4301 (V2A), geschliffen K240'],
          ['Edelstahl Vierkantrohr 50x50x2 V2A', 'm',  24.00, 'Vierkantrohr 50x50x2 mm, 1.4301 (V2A), geschliffen K240'],
          ['Edelstahl Rundrohr 33,7x2 V2A',      'm',  14.50, 'Rundrohr 33,7x2 mm (1"), 1.4301 (V2A), geschliffen K240'],
          ['Edelstahl Rundrohr 42,4x2 V2A',      'm',  19.00, 'Rundrohr 42,4x2 mm (1¼"), 1.4301 (V2A), geschliffen K240'],
          ['Edelstahl Flachstahl 40x5 V2A',      'm',   9.80, 'Flachstahl 40x5 mm, 1.4301 (V2A), geschliffen K240'],
          ['Edelstahl Handlauf Ø 42,4 V2A',      'm',  22.00, 'Handlaufrohr Ø 42,4 mm, 1.4301 (V2A), K240 geschliffen'],
          // ── Verbindungselemente ──────────────────────────────────
          ['Schrauben M8x20 (100 Stk)',   'Psch',  8.50, 'Sechskantschrauben M8x20, 8.8 verzinkt, 100 Stück'],
          ['Schrauben M10x30 (100 Stk)',  'Psch', 12.00, 'Sechskantschrauben M10x30, 8.8 verzinkt, 100 Stück'],
          ['Schrauben M12x40 (50 Stk)',   'Psch', 11.00, 'Sechskantschrauben M12x40, 8.8 verzinkt, 50 Stück'],
          ['Ankerbolzen M10x100 (10 Stk)','Psch', 18.00, 'Betonschraube/Ankerbolzen M10x100, 10 Stück'],
          ['Ankerbolzen M12x120 (10 Stk)','Psch', 24.00, 'Betonschraube/Ankerbolzen M12x120, 10 Stück'],
          ['Schweißmutter M8 (50 Stk)',   'Psch',  6.50, 'Schweißmuttern M8, Stahl, 50 Stück'],
          ['Schweißmutter M10 (50 Stk)',  'Psch',  8.00, 'Schweißmuttern M10, Stahl, 50 Stück'],
          // ── Zubehör / Normteile ──────────────────────────────────
          ['Geländerpfosten Ø 42,4 mit Grundplatte', 'Stk', 28.00, 'Geländerpfosten Ø 42,4 mm, h=1000 mm, mit angeschweißter Grundplatte 100x100x8'],
          ['Handlaufhalter V2A gebogen',              'Stk', 12.50, 'Handlaufhalter für Rundrohr Ø 42,4 mm, 1.4301, zum Anschweißen'],
          ['Handlaufhalter V2A gerade',               'Stk', 10.00, 'Handlaufhalter für Rundrohr Ø 42,4 mm, 1.4301, Wandmontage'],
          ['Kugelhandlauf-Endkappe Ø 42,4',           'Stk',  3.50, 'Endkappe für Rundrohr Ø 42,4 mm, V2A, gepresst'],
          ['Treppengeländer-Set V2A komplett',         'Stk',320.00, 'Treppengeländer V2A, 1 m, inkl. Pfosten, Handlauf, Querstreben'],
          ['Scharnier schwer 100x100 Stahl',           'Stk',  6.80, 'Torband/Scharnier 100x100 mm, Stahl, schwer, verzinkt'],
          ['Scharnier schwer 140x130 Stahl',           'Stk', 12.00, 'Torband/Scharnier 140x130 mm, Stahl, schwer, verzinkt'],
          ['Türband Edelstahl V2A',                    'Stk', 18.50, 'Türband/Scharnier V2A für Rahmentüren, einstellbar'],
          ['Drückergarniturenset V2A',                 'Stk', 45.00, 'Drückergarnitur mit Langschild, 1.4301, inkl. Zylinder'],
          ['Rohrverbinder T-Stück Ø 42,4',             'Stk',  7.20, 'Rohrverbinder T-Stück für Ø 42,4 mm, Stahl verzinkt'],
          ['Torantrieb Schiebetor 600 kg',             'Stk',380.00, 'Elektro-Torantrieb für Schiebetor bis 600 kg, inkl. Steuerung'],
          // ── Oberflächenbehandlung ────────────────────────────────
          ['Feuerverzinkung',         'kg',   1.80, 'Stückverzinkung nach DIN EN ISO 1461, Preis je kg Stahl'],
          ['Pulverbeschichtung',      'm²',  35.00, 'Einschicht-Pulverbeschichtung RAL nach Wahl, inkl. Vorbehandlung'],
          ['Grundierung 2K-Epoxy',    'm²',   8.50, 'Epoxid-Grundierung zweikomponentig, ca. 80 µm'],
          ['Decklack 2K-PU',          'm²',  14.00, 'PU-Decklack zweikomponentig RAL nach Wahl, ca. 60 µm'],
          // ── Arbeitsleistungen ────────────────────────────────────
          ['Schweißarbeit',           'Std',  65.00, 'Schweißarbeiten MIG/MAG oder WIG, inkl. Material'],
          ['Schlosserarbeit',         'Std',  60.00, 'Allgemeine Schlosser- und Metallbauarbeiten'],
          ['Montage vor Ort',         'Std',  68.00, 'Montageleistung auf der Baustelle inkl. Werkzeug'],
          ['Aufmaß & Planung',        'Std',  70.00, 'Aufmaß nehmen, Konstruktionsplanung, CAD-Zeichnung'],
          ['Materialzuschlag / Kleinteile', 'Psch', 25.00, 'Pauschale für Schweißdraht, Scheiben, Reiniger, Kleinteile'],
          ['Anfahrt',                 'Psch',  0.00, 'Anfahrtskosten – Preis nach Entfernung'],
        ];
        const values = seed.flat();
        const placeholders = seed.map((_, i) =>
          `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`
        ).join(', ');
        db.query(
          `INSERT INTO articles (title, unit, unit_price, description) VALUES ${placeholders}`,
          values,
          (err3) => { if (err3) console.error('❌ Artikel-Seed Fehler:', err3.message); else console.log('✅ Artikelstamm mit', seed.length, 'Einträgen befüllt.'); }
        );
      });
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

      db.run(`
        CREATE TABLE IF NOT EXISTS lager_items (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          material_type   TEXT NOT NULL DEFAULT 'baustahl',
          bezeichnung     TEXT NOT NULL,
          profil          TEXT,
          abmessung       TEXT,
          menge           REAL DEFAULT 0,
          einheit         TEXT DEFAULT 'Stk',
          lieferschein_nr TEXT,
          lieferdatum     TEXT,
          notiz           TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Bestehende ADMIN-Nutzer auf CHEF migrieren (einmalig)
      db.run(`UPDATE users SET role = 'CHEF' WHERE role = 'ADMIN'`, (err) => {
        if (!err) console.log("✅ Rollen-Migration ADMIN→CHEF abgeschlossen.");
      });
      // Chef-User lokal prüfen/anlegen (nur wenn noch kein CHEF existiert)
      db.get(`SELECT id FROM users WHERE role = 'CHEF'`, (err, row) => {
        if (!row) {
          const tempPassword = crypto.randomBytes(9).toString('base64url');
          const hashedPassword = bcrypt.hashSync(tempPassword, 10);
          db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, ['chef', hashedPassword, 'CHEF'], (insertErr) => {
            if (!insertErr) {
              console.log('==========================================');
              console.log('🔑 Standard-Chef angelegt!');
              console.log('   User: chef');
              console.log('   PW:   ' + tempPassword);
              console.log('   ⚠️  Bitte SOFORT nach dem ersten Login ändern!');
              console.log('==========================================');
            }
          });
        }
      });
    });
  });
}

module.exports = db;
