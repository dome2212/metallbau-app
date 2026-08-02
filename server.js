const express = require('express');
const path = require('path');
const https = require('https');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./config/database');

// Load .env (optional)
try { require('dotenv').config(); } catch (e) {}

// === Google Gemini (GenAI) Client ===
let genaiClient = null;
try {
  const { GoogleGenAI } = require('@google/genai');
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
  if (GEMINI_API_KEY) {
    try {
      genaiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      console.log('✅ GenAI client initialisiert');
    } catch (e) {
      console.error('⚠️ Fehler beim Initialisieren des GenAI-Clients:', e.message);
    }
  } else {
    console.warn('⚠️ GEMINI_API_KEY ist nicht gesetzt — KI-Funktionen deaktiviert.');
  }
} catch (e) {
  console.warn('⚠️ @google/genai Modul nicht installiert oder kann nicht geladen werden. Bitte npm install @google/genai');
}

// ==========================================
// GLOBALE ZEITZONE AUF DEUTSCHLAND FESTLEGEN
// ==========================================
process.env.TZ = 'Europe/Berlin';

// Automatische Einbindung von PDFKit
let PDFKit;
try {
  PDFKit = require('pdfkit');
} catch (e) {
  console.log('Hinweis: pdfkit Modul wird geladen...');
}

// PostgreSQL-Verbindung auf UTC halten (Timestamps werden als UTC gespeichert,
// Anzeige-Konvertierung erfolgt per AT TIME ZONE 'Europe/Berlin' in den Abfragen)
if (process.env.DATABASE_URL) {
  db.query("SET timezone = 'UTC';").catch(() => {});
}

// ==========================================
// DB-HILFSKONSTANTE
// ==========================================
const isPg = !!process.env.DATABASE_URL;

// ==========================================
// FIRMEN-DATEN — hier zentral anpassen!
// ==========================================
const FIRMA = {
  name:       'Frank Gehrmann Stahl- und Metallbau GmbH',          // Firmenname (groß im Briefkopf)
  nameKurz:   'Metallbau-Gehrmann',          // Kurzform (Fußzeilen etc.)
  slogan:     'Hochwertige Handwerksarbeit zum fairen Preis.',
  strasse:    'Ratingerstr. 85',
  plzOrt:     '42279 Heiligenhaus',
  tel:        '02102 85610',
  email:      'info@metallbau-gehrmann.de',
  web:        'www.metallbau-gehrmann.de',
  iban:       'DE12 3456 7890 1234 5678 90',
  bic:        'MUBADE12',
  bank:       'Musterbank DE',
  steuernr:   'USt-IdNr.: DE123456789',
  zahlungsfrist: 14,                          // Tage
  angebotsgueltig: 30,                        // Tage
};

// ==========================================
// HILFSFUNKTION (Muss ganz oben stehen!)
// ==========================================
const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (process.env.DATABASE_URL) {
      let i = 0;
      let pgSql = sql.replace(/\?/g, () => `$${++i}`);
      if (pgSql.trim().toUpperCase().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
        pgSql += ' RETURNING id';
      }

      db.query(pgSql, params, (err, res) => {
        if (err) return reject(err);
        const rows = res.rows || [];
        const lastID = rows.length > 0 && rows[0].id ? rows[0].id : null;
        resolve({ rows, lastID });
      });
    } else {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        // SELECT queries — db.all returns rows
        db.all(sql, params, function(err, rows) {
          if (err) return reject(err);
          resolve({ rows: rows || [], lastID: null });
        });
      } else {
        // INSERT / UPDATE / DELETE — db.run provides this.lastID and this.changes
        db.run(sql, params, function(err) {
          if (err) return reject(err);
          resolve({ rows: [], lastID: this.lastID });
        });
      }
    }
  });
};

// ==========================================
// AUTOMATISCHE TABELLEN-ERSTELLUNG BEIM START
// ==========================================
// ... (rest of the original server.js remains unchanged) ...
