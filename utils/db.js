/**
 * Universelle DB-Hilfsfunktion für SQLite (lokal) und PostgreSQL (Render/Cloud).
 * Wandelt ?-Platzhalter automatisch in $1,$2,... um wenn DATABASE_URL gesetzt ist.
 */
const db = require('../config/database');

const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    if (process.env.DATABASE_URL) {
      let i = 0;
      let pgSql = sql.replace(/\?/g, () => `$${++i}`);
      // RETURNING id nur anhängen wenn die Tabelle eine id-Spalte hat
      // (appointment_users hat keine id-Spalte → kein RETURNING)
      const trimmed = pgSql.trim().toUpperCase();
      if (trimmed.startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
        // Tabellen ohne id-Spalte: kein RETURNING anhängen
        const noIdTables = ['appointment_users', 'company_settings'];
        const hasNoId = noIdTables.some(t => pgSql.toLowerCase().includes(t));
        if (!hasNoId) {
          pgSql += ' RETURNING id';
        }
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
        // SELECT: db.all() liefert Zeilen
        db.all(sql, params, function(err, rows) {
          if (err) return reject(err);
          resolve({ rows: rows || [], lastID: null });
        });
      } else {
        // INSERT / UPDATE / DELETE: db.run() liefert lastID über this.lastID
        db.run(sql, params, function(err) {
          if (err) return reject(err);
          resolve({ rows: [], lastID: this.lastID });
        });
      }
    }
  });
};

// ─── Transaktionen ────────────────────────────────────────────────────────────
// Nutzung:
//   await withTransaction(async (tx) => {
//     await tx.query('DELETE FROM a WHERE id = ?', [id]);
//     await tx.query('DELETE FROM b WHERE id = ?', [id]);
//   });
// Wirft ein Schritt einen Fehler, wird ALLES zurückgerollt.
const isPg = !!process.env.DATABASE_URL;
let _sqliteLock = Promise.resolve(); // SQLite hat nur eine Verbindung → Transaktionen nacheinander

async function withTransaction(fn) {
  if (isPg) {
    const client = await db.connect();
    const tx = {
      query: (sql, params = []) => {
        let i = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++i}`);
        return client.query(pgSql, params).then(r => ({ rows: r.rows || [], lastID: null }));
      }
    };
    try {
      await client.query('BEGIN');
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve({ rows: [], lastID: this.lastID }); }));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve({ rows: rows || [], lastID: null })));

  const prev = _sqliteLock;
  let release;
  _sqliteLock = new Promise(r => { release = r; });
  await prev;
  const tx = { query: (sql, params = []) => /^\s*(SELECT|WITH)/i.test(sql) ? all(sql, params) : run(sql, params) };
  try {
    await run('BEGIN');
    const out = await fn(tx);
    await run('COMMIT');
    return out;
  } catch (e) {
    try { await run('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    release();
  }
}

module.exports = { dbQuery, withTransaction };
