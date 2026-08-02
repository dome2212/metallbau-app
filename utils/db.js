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
        // appointment_users hat keine id-Spalte – kein RETURNING anhängen
        if (!pgSql.toLowerCase().includes('appointment_users')) {
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

module.exports = { dbQuery };
