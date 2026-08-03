/**
 * Firmeneinstellungen aus der Datenbank laden und cachen.
 * Alle Routen nutzen `getFirma()` statt dem alten statischen FIRMA-Objekt.
 *
 * Standardwerte entsprechen dem bisherigen utils/firma.js – damit die App
 * auch ohne gespeicherte Einstellungen sofort funktioniert.
 */
const { dbQuery } = require('./db');

const DEFAULTS = {
  name:            'Frank Gehrmann Stahl- und Metallbau GmbH',
  nameKurz:        'Metallbau-Gehrmann',
  slogan:          'Hochwertige Handwerksarbeit zum fairen Preis.',
  strasse:         'Ratingerstr. 85',
  plzOrt:          '42279 Heiligenhaus',
  tel:             '02102 85610',
  email:           'info@metallbau-gehrmann.de',
  web:             'www.metallbau-gehrmann.de',
  iban:            'DE12 3456 7890 1234 5678 90',
  bic:             'MUBADE12',
  bank:            'Musterbank DE',
  steuernr:        'USt-IdNr.: DE123456789',
  zahlungsfrist:   14,
  angebotsgueltig: 30,
  logo_url:        null,   // Cloudinary-URL des Firmen-Logos
};

// Einfacher In-Memory-Cache (wird bei jeder Änderung geleert)
let _cache = null;

/**
 * Lädt die Firmeneinstellungen aus der DB.
 * Beim ersten Aufruf wird aus der DB gelesen, danach aus dem Cache.
 */
async function getFirma() {
  if (_cache) return _cache;

  try {
    const result = await dbQuery(
      `SELECT key, value FROM company_settings`
    );
    if (!result.rows || result.rows.length === 0) {
      _cache = { ...DEFAULTS };
      return _cache;
    }
    const data = { ...DEFAULTS };
    for (const row of result.rows) {
      const key = row.key;
      let   val = row.value;
      // Zahlen korrekt parsen
      if (key === 'zahlungsfrist' || key === 'angebotsgueltig') {
        val = parseInt(val, 10) || DEFAULTS[key];
      }
      data[key] = val;
    }
    _cache = data;
    return _cache;
  } catch (_) {
    // Tabelle existiert noch nicht oder DB-Fehler → Defaults verwenden
    _cache = { ...DEFAULTS };
    return _cache;
  }
}

/**
 * Speichert ein Key-Value-Paar und leert den Cache.
 */
async function setFirmaValue(key, value) {
  const isPg = !!process.env.DATABASE_URL;
  const sql  = isPg
    ? `INSERT INTO company_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`
    : `INSERT INTO company_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`;
  await dbQuery(sql, [key, value]);
  _cache = null; // Cache leeren → nächster getFirma()-Aufruf lädt neu
}

/** Cache manuell leeren (z.B. nach Batch-Update) */
function clearCache() {
  _cache = null;
}

module.exports = { getFirma, setFirmaValue, clearCache, DEFAULTS };
