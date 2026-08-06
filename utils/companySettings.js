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
  logo_url:           null,   // Cloudinary-URL des Firmen-Logos (für PDFs)
  sidebar_logo_url:   null,   // Cloudinary-URL des Sidebar-Logos
  sidebar_modus:      'text', // 'text' = Kurzname anzeigen, 'logo' = Logo anzeigen
  sidebar_logo_height: 80,   // Höhe des Sidebar-Logos in px (40–200)

  // ── Design & Farben ────────────────────────────────────────────
  color_primary:      '#2563eb',
  color_sidebar_bg:   '#1e293b',
  color_sidebar_text: '#e2e8f0',
  color_sidebar_hover:'#334155',
  color_topbar_bg:    '#ffffff',
  color_page_bg:      '#f1f5f9',
  app_icon:           '🔩',
  dark_mode_default:  'false',

  // ── Feature-Schalter ───────────────────────────────────────────
  feature_map:        'true',
  feature_lexikon:    'true',
  feature_treppe:     'true',
  feature_steel_calc: 'true',
  feature_ai:         'true',

  // ── PDF & Dokumente ────────────────────────────────────────────
  pdf_color:           '#1e3a5f',  // Akzentfarbe im PDF-Briefkopf
  invoice_prefix:      'RECH',     // Prefix Rechnungsnummer
  offer_prefix:        'ANG',      // Prefix Angebotsnummer
  default_tax_rate:    '19',       // Standard-MwSt. in %
  default_payment_method: 'Überweisung', // Zahlungsart auf PDFs
  pdf_footer_text:     '',         // Fußzeile auf allen PDFs
  pdf_agb_text:        '',         // AGB-Text am Ende des PDFs
  pdf_intro_offer:     'Sehr geehrte Damen und Herren,\nvielen Dank für Ihre Anfrage. Wir unterbreiten Ihnen folgendes Angebot:', // Einleitungstext Angebot
  pdf_intro_invoice:   'Sehr geehrte Damen und Herren,\nwir erlauben uns, folgende Leistungen in Rechnung zu stellen:',          // Einleitungstext Rechnung

  // ── Arbeitszeit ────────────────────────────────────────────────
  work_hours_per_day:  '8',        // Soll-Stunden pro Arbeitstag
  vacation_days_default: '30',     // Urlaubstage pro Jahr (neue MA)
  break_auto_minutes:  '0',        // Pausenabzug ab X Minuten Arbeitszeit (0 = deaktiviert)
  break_trigger_hours: '6',        // Pause abziehen wenn Arbeitstag > X Stunden
  holiday_region:      'NRW',      // Bundesland für Feiertagsberechnung

  // ── Aufträge & Projekte ────────────────────────────────────────
  project_number_prefix: 'BAUS',   // Prefix für Auftragsnummern
  default_project_status: 'In Planung', // Status bei Neuanlage
  archive_after_days:  '180',      // Tage bis auto-Archivierung (0 = aus)

  // ── Sicherheit ────────────────────────────────────────────────
  session_timeout_minutes: '480',  // Session-Timeout in Minuten (0 = nie)
  max_login_attempts:  '10',       // Max. Fehlversuche vor Sperrung
  min_password_length: '6',        // Mindest-Passwortlänge

  // ── Lokalisierung ──────────────────────────────────────────────
  currency_symbol:     '€',        // Währungszeichen
  date_format:         'de-DE',    // Datumsformat (Locale)
  timezone:            'Europe/Berlin',

  // ── Dashboard KPI-Schwellen ────────────────────────────────────
  kpi_overdue_warn:    '3',        // Ab X überfälligen Rechnungen: gelb
  kpi_overdue_danger:  '6',        // Ab X überfälligen Rechnungen: rot
  kpi_tasks_warn:      '5',        // Ab X offenen Aufgaben: gelb
  kpi_tasks_danger:    '10',       // Ab X offenen Aufgaben: rot

  // ── Sidebar & App ──────────────────────────────────────────────
  sidebar_footer_text: '@Domenic Rosic', // Fußzeile der Sidebar
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
