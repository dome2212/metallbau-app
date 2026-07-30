const express = require('express');
const router = express.Router();
const path = require('path');
const db = require(path.join(__dirname, '../config/database'));

// Universelle Hilfsfunktion für SQLite (lokal) und PostgreSQL (Render)
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

// POST: Angebot in eine Rechnung umwandeln
router.post('/convert-to-invoice/:offerId', async (req, res) => {
  const { offerId } = req.params;

  try {
    // 1. Das bestehende Angebot auslesen
    const offerRes = await dbQuery(`SELECT * FROM documents WHERE id = ?`, [offerId]);
    const offer = offerRes.rows[0];
    
    if (!offer) {
      return res.status(404).send('Angebot nicht gefunden');
    }

    const year = new Date().getFullYear();

    // 2. Nächste freie Rechnungsnummer ermitteln
    const countResult = await dbQuery(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'INVOICE'`);
    const row = countResult.rows[0];
    const nextNum = String((row ? parseInt(row.count, 10) : 0) + 1).padStart(4, '0');
    const invoiceNumber = `RECH-${year}-${nextNum}`;

    // 3. Neue Rechnung in die Datenbank eintragen
    const sqlInsert = `
      INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount)
      VALUES ('INVOICE', ?, ?, 'ENTWURF', ?, ?, ?, ?)
    `;

    await dbQuery(sqlInsert, [
      invoiceNumber, 
      offer.customer_id, 
      offer.tax_rate || 19.0, 
      offer.subtotal || 0, 
      offer.tax_amount || 0, 
      offer.total_amount || 0
    ]);
    
    // 4. Status des Angebots auf 'ANGENOMMEN' setzen
    await dbQuery(`UPDATE documents SET status = 'ANGENOMMEN' WHERE id = ?`, [offerId]);
    
    // Zurück zur Rechnungsübersicht leiten
    res.redirect('/documents/invoices');
  } catch (err) {
    console.error('❌ Fehler beim Umwandeln des Angebots:', err.message);
    res.status(500).send('Datenbankfehler beim Umwandeln des Angebots');
  }
});

module.exports = router;
