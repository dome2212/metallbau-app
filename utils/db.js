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
      db.all(sql, params, function(err, rows) {
        if (err) return reject(err);
        resolve({ rows: rows || [], lastID: this?.lastID });
      });
    }
  });
};

module.exports = { dbQuery };
