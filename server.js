const express = require('express');
const path = require('path');
const https = require('https');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./config/database');
const { execSync } = require('child_process');
const app = express(); // <--- DAS MUSS HIER STEHEN!


// Load .env (optional)
try { require('dotenv').config(); } catch (e) {}

// If running in an environment without shell access (e.g., Render), optionally try to
// install missing npm packages at startup. You can disable this behavior by setting
// AUTO_NPM_INSTALL=false in the environment.
(function ensureDependencies() {
  const autoInstall = process.env.AUTO_NPM_INSTALL !== 'false';
  const needed = ['@google/genai', 'dotenv'];
  const missing = [];
  for (const pkg of needed) {
    try {
      require.resolve(pkg);
    } catch (e) {
      missing.push(pkg);
    }
  }
  if (missing.length > 0) {
    if (!autoInstall) {
      console.warn('Missing packages:', missing.join(', '), '- AUTO_NPM_INSTALL=false, skipping auto-install.');
      return;
    }
    try {
      console.log('🔧 Fehlende Pakete erkannt — versuche automatisch zu installieren:', missing.join(' '));
      // Use --no-audit and --no-fund to keep the install quieter on some platforms
      execSync(`npm install --no-audit --no-fund ${missing.join(' ')}`, { stdio: 'inherit' });
      console.log('✅ Installation fehlender Pakete abgeschlossen');
    } catch (err) {
      console.error('❌ Automatische Installation fehlgeschlagen:', err.message);
      console.warn('Bitte führe lokal oder in deiner Umgebung aus: npm install', missing.join(' '));
    }
  }
})();

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
// SERVER STARTEN & PORT FÜR RENDER FREIGEBEN
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server läuft erfolgreich auf Port ${PORT}`);
});


// ==========================================
// AUTOMATISCHE TABELLEN-ERSTELLUNG BEIM START
// ==========================================
// Rest of server.js remains unchanged — routes and logic already present on the branch.
