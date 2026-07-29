const express = require('express');
const router = express.Router();
const db = require('../config/database');

// POST: Angebot in eine Rechnung umwandeln
router.post('/convert-to-invoice/:offerId', (req, res) => {
  const { offerId } = req.params;

  // 1. Das bestehende Angebot auslesen
  db.query(`SELECT * FROM documents WHERE id = $1`, [offerId], (err, result) => {
    if (err) {
      console.error('❌ DB-Fehler beim Laden des Angebots:', err.message);
      return res.status(500).send('Datenbankfehler beim Laden des Angebots');
    }
    
    const offer = result.rows[0];
    if (!offer) {
      return res.status(404).send('Angebot nicht gefunden');
    }

    const year = new Date().getFullYear();

    // 2. Nächste freie Rechnungsnummer ermitteln
    db.query(`SELECT COUNT(*) as count FROM documents WHERE doc_type = 'INVOICE'`, (err, countResult) => {
      if (err) {
        console.error('❌ DB-Fehler bei Rechnungsnummer-Generierung:', err.message);
        return res.status(500).send('Fehler beim Erstellen der Rechnungsnummer');
      }

      const row = countResult.rows[0];
      const nextNum = String((row ? parseInt(row.count, 10) : 0) + 1).padStart(4, '0');
      const invoiceNumber = `RECH-${year}-${nextNum}`;

      // 3. Neue Rechnung in die Datenbank eintragen
      const sqlInsert = `
        INSERT INTO documents (doc_type, doc_number, customer_id, status, tax_rate, subtotal, tax_amount, total_amount)
        VALUES ('INVOICE', $1, $2, 'ENTWURF', $3, $4, $5, $6)
      `;

      db.query(
        sqlInsert,
        [
          invoiceNumber, 
          offer.customer_id, 
          offer.tax_rate || 19.0, 
          offer.subtotal || 0, 
          offer.tax_amount || 0, 
          offer.total_amount || 0
        ],
        function (err) {
          if (err) {
            console.error('❌ Fehler beim Erstellen der Rechnung:', err.message);
            return res.status(500).send('Fehler beim Erstellen der Rechnung: ' + err.message);
          }
          
          // 4. Status des Angebots auf 'ANGENOMMEN' setzen
          db.query(`UPDATE documents SET status = 'ANGENOMMEN' WHERE id = $1`, [offerId], (updateErr) => {
            if (updateErr) {
              console.error('⚠️ Status konnte nicht auf ANGENOMMEN gesetzt werden:', updateErr.message);
            }
            
            // Zurück zur Rechnungsübersicht leiten
            res.redirect('/documents/invoices');
          });
        }
      );
    });
  });
});

module.exports = router;
