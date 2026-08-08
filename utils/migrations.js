/**
 * utils/migrations.js
 * -------------------
 * Leichtgewichtiges Migrations-System für SQLite (lokal) und PostgreSQL (Render).
 *
 * Wie es funktioniert:
 *  1. Beim App-Start wird runMigrations() aufgerufen (einmalig, async).
 *  2. Es legt eine Tabelle `schema_migrations` an (falls noch nicht vorhanden).
 *  3. Jede Migration hat eine eindeutige `id` (fortlaufende Zahl) und eine
 *     Funktion, die SQL-Statements ausführt.
 *  4. Bereits ausgeführte Migrationen werden übersprungen (idempotent).
 *  5. SQLite versteht kein "ADD COLUMN IF NOT EXISTS" – dort wird der Fehler
 *     "duplicate column name" still ignoriert (wie bisher).
 *
 * Neue Spalten/Tabellen hinzufügen:
 *  → Einfach eine neue Migration ans Ende des MIGRATIONS-Arrays hängen.
 *    Niemals bestehende Einträge verändern oder löschen.
 */

const db = require('../config/database');
const isPg = !!process.env.DATABASE_URL;

// ─── DB-Helper (minimale lokale Kopie, um zirkuläre Abhängigkeit zu vermeiden) ───
function raw(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (isPg) {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      db.query(pgSql, params, (err, res) => {
        if (err) return reject(err);
        resolve({ rows: res.rows || [] });
      });
    } else {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('SELECT')) {
        db.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve({ rows: rows || [] });
        });
      } else {
        db.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve({ rows: [] });
        });
      }
    }
  });
}

// Auf SQLite ignorieren wir „duplicate column name"-Fehler (ALTER TABLE ADD COLUMN)
async function safeRaw(sql, params = []) {
  try {
    await raw(sql, params);
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    // SQLite: "duplicate column name"  |  PG: "already exists"
    if (msg.includes('duplicate column') || msg.includes('already exists')) return;
    throw err;
  }
}

// ─── Migrations-Liste ─────────────────────────────────────────────────────────
// WICHTIG: Einmal committed, NIE mehr ändern oder löschen.
// Neue Migrations immer ans ENDE anhängen.
const MIGRATIONS = [

  // ── 001 ── App-Kerntabellen (früher inline in server.js) ─────────────────────
  {
    id: 1,
    description: 'Kerntabellen und initiale Spalten',
    async up() {
      // articles
      await safeRaw(`CREATE TABLE IF NOT EXISTS articles (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        title       TEXT NOT NULL,
        unit        TEXT,
        unit_price  NUMERIC(10,2) DEFAULT 0,
        description TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // project_photos  (app-eigenes Schema mit file_url – nicht das alte photo_path-Schema)
      await safeRaw(`CREATE TABLE IF NOT EXISTS project_photos (
        id            ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        project_id    INT,
        file_url      TEXT NOT NULL,
        original_name TEXT,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // project_measurements
      await safeRaw(`CREATE TABLE IF NOT EXISTS project_measurements (
        id             ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        project_id     INT,
        component_name TEXT NOT NULL,
        width          TEXT,
        height         TEXT,
        angle          TEXT,
        quantity       INT DEFAULT 1,
        note           TEXT,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // project_notes
      await safeRaw(`CREATE TABLE IF NOT EXISTS project_notes (
        id         ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        project_id INT,
        note_text  TEXT NOT NULL,
        audio_url  TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // vacations
      await safeRaw(`CREATE TABLE IF NOT EXISTS vacations (
        id         ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        user_id    INT NOT NULL,
        start_date TEXT NOT NULL,
        end_date   TEXT NOT NULL,
        reason     TEXT,
        type       TEXT DEFAULT 'Urlaub',
        file_url   TEXT,
        status     TEXT DEFAULT 'Beantragt',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // project_tasks (app-eigenes Schema)
      await safeRaw(`CREATE TABLE IF NOT EXISTS project_tasks (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        project_id  INT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT,
        category    TEXT DEFAULT 'Restarbeit',
        status      TEXT DEFAULT 'Offen',
        photo_url   TEXT,
        due_date    TEXT,
        assigned_to INT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // project_sketches (app-eigenes Schema mit image_data)
      await safeRaw(`CREATE TABLE IF NOT EXISTS project_sketches (
        id         ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        project_id INT NOT NULL,
        title      TEXT,
        image_data TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // tickers (app-eigenes Schema: message/author)
      await safeRaw(`CREATE TABLE IF NOT EXISTS tickers (
        id         ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        message    TEXT NOT NULL,
        author     TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // appointment_users (composite PK, kein RETURNING)
      await safeRaw(`CREATE TABLE IF NOT EXISTS appointment_users (
        appointment_id INTEGER NOT NULL,
        user_id        INTEGER NOT NULL,
        PRIMARY KEY (appointment_id, user_id)
      )`);

      // document_items (app-eigenes Schema)
      await safeRaw(`CREATE TABLE IF NOT EXISTS document_items (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        document_id INT NOT NULL,
        description TEXT,
        quantity    NUMERIC(10,3) DEFAULT 1,
        unit        TEXT DEFAULT 'Stk',
        price       NUMERIC(12,2) DEFAULT 0
      )`);

      // company_settings (key/value-Store)
      await safeRaw(`CREATE TABLE IF NOT EXISTS company_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // staff_assignments
      await safeRaw(`CREATE TABLE IF NOT EXISTS staff_assignments (
        id              ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        user_id         INT NOT NULL,
        project_id      INT,
        assignment_date TEXT NOT NULL,
        note            TEXT,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // lager_items
      await safeRaw(`CREATE TABLE IF NOT EXISTS lager_items (
        id              ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        material_type   TEXT NOT NULL DEFAULT 'baustahl',
        bezeichnung     TEXT NOT NULL,
        profil          TEXT,
        abmessung       TEXT,
        menge           NUMERIC(12,3) DEFAULT 0,
        einheit         TEXT DEFAULT 'Stk',
        lieferschein_nr TEXT,
        lieferdatum     TEXT,
        notiz           TEXT,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    }
  },

  // ── 002 ── Nachrüst-Spalten (früher ALTER TABLE … ADD COLUMN in server.js) ───
  {
    id: 2,
    description: 'Nachrüst-Spalten für bestehende Tabellen',
    async up() {
      // project_notes
      await safeRaw(`ALTER TABLE project_notes ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} audio_url TEXT`);

      // project_tasks
      await safeRaw(`ALTER TABLE project_tasks ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} due_date TEXT`);
      await safeRaw(`ALTER TABLE project_tasks ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} assigned_to INT`);

      // project_measurements
      await safeRaw(`ALTER TABLE project_measurements ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} angle TEXT`);
      await safeRaw(`ALTER TABLE project_measurements ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} width TEXT`);
      await safeRaw(`ALTER TABLE project_measurements ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} height TEXT`);
      await safeRaw(`ALTER TABLE project_measurements ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} quantity INT DEFAULT 1`);
      await safeRaw(`ALTER TABLE project_measurements ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} note TEXT`);

      // vacations
      await safeRaw(`ALTER TABLE vacations ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} file_url TEXT`);
      await safeRaw(`ALTER TABLE vacations ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} type TEXT DEFAULT 'Urlaub'`);

      // time_logs
      await safeRaw(`ALTER TABLE time_logs ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} customer_id INT`);
      await safeRaw(`ALTER TABLE time_logs ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} latitude NUMERIC(10,8)`);
      await safeRaw(`ALTER TABLE time_logs ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} longitude NUMERIC(11,8)`);
      await safeRaw(`ALTER TABLE time_logs ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} note TEXT`);
      await safeRaw(`ALTER TABLE time_logs ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} project_id INT`);

      // projects
      await safeRaw(`ALTER TABLE projects ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} site_lat NUMERIC(10,8)`);
      await safeRaw(`ALTER TABLE projects ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} site_lng NUMERIC(11,8)`);
      await safeRaw(`ALTER TABLE projects ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} site_radius INT DEFAULT 200`);
      await safeRaw(`ALTER TABLE projects ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} site_note TEXT`);

      // documents
      await safeRaw(`ALTER TABLE documents ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} tax_rate NUMERIC(5,2) DEFAULT 19`);
      await safeRaw(`ALTER TABLE documents ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} subtotal NUMERIC(12,2) DEFAULT 0`);
      await safeRaw(`ALTER TABLE documents ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} tax_amount NUMERIC(12,2) DEFAULT 0`);
      await safeRaw(`ALTER TABLE documents ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} due_date TEXT`);
      await safeRaw(`ALTER TABLE documents ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} status_note TEXT`);
      await safeRaw(`ALTER TABLE documents ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} dunning_level INT DEFAULT 0`);

      // users
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} vacation_allowance INT DEFAULT 30`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} whatsapp_phone TEXT`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} whatsapp_api_key TEXT`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} whatsapp_notify BOOLEAN DEFAULT true`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} phone TEXT`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} qualifications TEXT`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} driving_license TEXT`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} notes TEXT`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} dark_mode INT DEFAULT 0`);
      await safeRaw(`ALTER TABLE users ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} rfid_uid TEXT`);
    }
  },

  // ── 004 ── Lager: mindestbestand-Spalte + Entnahmen + Reststücke ─────────────
  {
    id: 4,
    description: 'Lager: mindestbestand, lager_entnahmen, lager_reststuecke',
    async up() {
      // Mindestbestand-Spalte auf lager_items nachrüsten
      await safeRaw(`ALTER TABLE lager_items ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} mindestbestand NUMERIC(12,3) DEFAULT 0`);
      await safeRaw(`ALTER TABLE lager_items ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} lagerort TEXT`);

      // Materialentnahmen (Verbrauch pro Auftrag)
      await safeRaw(`CREATE TABLE IF NOT EXISTS lager_entnahmen (
        id            ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        lager_item_id INT NOT NULL,
        project_id    INT,
        user_id       INT,
        menge         NUMERIC(12,3) NOT NULL,
        einheit       TEXT DEFAULT 'Stk',
        notiz         TEXT,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // Reststücke
      await safeRaw(`CREATE TABLE IF NOT EXISTS lager_reststuecke (
        id            ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        material_type TEXT NOT NULL DEFAULT 'baustahl',
        bezeichnung   TEXT NOT NULL,
        profil        TEXT,
        laenge        TEXT,
        menge         NUMERIC(12,3) DEFAULT 1,
        einheit       TEXT DEFAULT 'Stk',
        lagerort      TEXT,
        notiz         TEXT,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    }
  },

  // ── 003 ── Interner Baustellen-Chat ──────────────────────────────────────────
  {
    id: 3,
    description: 'Interner Baustellen-Chat (project_chat)',
    async up() {
      await safeRaw(`CREATE TABLE IF NOT EXISTS project_chat (
        id         ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        project_id INT NOT NULL,
        user_id    INT NOT NULL,
        message    TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    }
  },

  // ── 005 ── Kalkulationsvorlagen + Nachträge + Stahlpreise ─────────────────────
  {
    id: 5,
    description: 'Kalkulationsvorlagen, Nachtraege, Stahlpreise',
    async up() {

      // Kalkulationsvorlagen (Baugruppen-Stamm)
      await safeRaw(`CREATE TABLE IF NOT EXISTS offer_templates (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        name        TEXT NOT NULL,
        beschreibung TEXT,
        kategorie   TEXT DEFAULT 'Allgemein',
        created_by  INT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // Positionen der Vorlage
      await safeRaw(`CREATE TABLE IF NOT EXISTS offer_template_items (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        template_id INT NOT NULL,
        beschreibung TEXT NOT NULL,
        menge       NUMERIC(12,3) DEFAULT 1,
        einheit     TEXT DEFAULT 'Stk',
        preis       NUMERIC(12,2) DEFAULT 0,
        sort_order  INT DEFAULT 0
      )`);

      // Nachträge zu einem Angebot / Auftrag
      await safeRaw(`CREATE TABLE IF NOT EXISTS offer_nachtraege (
        id              ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        document_id     INT NOT NULL,
        titel           TEXT NOT NULL,
        beschreibung    TEXT,
        betrag_netto    NUMERIC(12,2) DEFAULT 0,
        status          TEXT DEFAULT 'Entwurf',
        freigabe_token  TEXT,
        freigegeben_am  TIMESTAMP,
        created_by      INT,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

      // Positionen eines Nachtrags
      await safeRaw(`CREATE TABLE IF NOT EXISTS offer_nachtrag_items (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        nachtrag_id INT NOT NULL,
        beschreibung TEXT NOT NULL,
        menge       NUMERIC(12,3) DEFAULT 1,
        einheit     TEXT DEFAULT 'Stk',
        preis       NUMERIC(12,2) DEFAULT 0
      )`);

      // Stahlpreise-Cache (täglich aktualisiert)
      await safeRaw(`CREATE TABLE IF NOT EXISTS steel_prices (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        material    TEXT NOT NULL,
        preis_100kg NUMERIC(10,2),
        quelle      TEXT DEFAULT 'manuell',
        gueltig_am  TEXT NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    }
  },

  // ── 006 ── Projektstatus-Log + Foto-Beschriftung ─────────────────────────────
  {
    id: 6,
    description: 'Projektstatus-Log und Foto-Beschriftung',
    async up() {
      await safeRaw(`CREATE TABLE IF NOT EXISTS project_status_log (
        id         ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        project_id INT NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await safeRaw(`ALTER TABLE project_photos ADD COLUMN ${isPg ? 'IF NOT EXISTS' : ''} caption TEXT`);
    }
  },

];

// ─── Runner ───────────────────────────────────────────────────────────────────
async function runMigrations() {
  // Migrations-Tracking-Tabelle anlegen
  await raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id          INTEGER ${isPg ? '' : 'PRIMARY KEY'} ${isPg ? 'PRIMARY KEY' : 'AUTOINCREMENT'},
    description TEXT,
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = await raw('SELECT id FROM schema_migrations');
  const appliedIds = new Set((applied.rows || []).map(r => Number(r.id)));

  let ran = 0;
  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;
    try {
      await migration.up();
      await raw(
        'INSERT INTO schema_migrations (id, description) VALUES (?, ?)',
        [migration.id, migration.description]
      );
      console.log(`✅ Migration ${migration.id} angewendet: ${migration.description}`);
      ran++;
    } catch (err) {
      console.error(`❌ Migration ${migration.id} fehlgeschlagen:`, err.message);
      throw err; // Fehler nach oben weitergeben → App-Start abbrechen
    }
  }
  if (ran === 0) {
    console.log('✓ Datenbank aktuell – keine neuen Migrationen.');
  }
}

module.exports = { runMigrations };
