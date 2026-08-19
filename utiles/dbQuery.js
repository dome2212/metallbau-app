const db = require('../config/database');

// Universelle Hilfsfunktion für SQLite (lokal) und PostgreSQL (Render/Produktion).
// WICHTIG: Das ist jetzt die EINZIGE Quelle dieser Funktion im ganzen Projekt.
// Nicht mehr pro Route-Datei kopieren – sonst driften die Kopien wieder auseinander
// (genau das ist vorher schon mit mehreren Route-Dateien passiert).
function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (process.env.DATABASE_URL) {
      // Produktion: PostgreSQL
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
      // Lokale Entwicklung: SQLite
      db.all(sql, params, function (err, rows) {
        if (err) return reject(err);
        resolve({ rows: rows || [], lastID: this?.lastID });
      });
    }
  });
}

module.exports = dbQuery;
