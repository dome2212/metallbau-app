const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');

// Hilfsfunktion (wird aus der server.js übernommen)
// Falls du dbQuery zentral in einer anderen Datei hast, kannst du es auch importieren.
// Hier gehen wir davon aus, dass wir dbQuery übergeben oder einbinden.

router.get('/', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const dbQuery = req.app.get('dbQuery'); // Oder direkt dein dbQuery nutzen

  try {
    if (userRole !== 'ADMIN') {
      const sqlMonthLogs = `
        SELECT time_logs.*, 
               TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp 
        FROM time_logs 
        WHERE user_id = ? 
        ORDER BY timestamp ASC
      `;
      const result = await dbQuery(sqlMonthLogs, [userId]);
      const logs = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn = false;
      const now = new Date();

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const currentLogTime = new Date(logs[i].local_timestamp || logs[i].timestamp);
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const nextLog = logs[i + 1];
            const startTime = currentLogTime.getTime();
            let endTime;

            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
              endTime = new Date(nextLog.local_timestamp || nextLog.timestamp).getTime();
            } else if (i === logs.length - 1) {
              endTime = now.getTime();
            } else {
              endTime = startTime;
            }

            if (endTime > startTime) {
              totalMilliseconds += (endTime - startTime);
            }
          } else if (logs[i].type === 'OUT') {
            isStampedIn = false;
          }
        }
      }

      const monthTotalHours = (totalMilliseconds / (1000 * 60 * 60)).toFixed(2);
      const stats = { monthTotalHours, isStampedIn };
      const recentLogs = [...logs].reverse().slice(0, 5);

      res.render('dashboard-employee', { stats, recentLogs });

    } else {
      const sqlOffers = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
        FROM documents 
        WHERE doc_type = 'OFFER' AND status != 'ANGENOMMEN' AND status != 'ABGELEHNT'
      `;
      const sqlInvoices = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
        FROM invoices 
        WHERE status != 'Bezahlt'
      `;
      const sqlCustomers = `SELECT COUNT(*) as count FROM customers`;
      
      const sqlRecentDocs = `
        SELECT * FROM (
          SELECT documents.id, documents.doc_number, 'Angebot' as doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person
          FROM documents
          LEFT JOIN customers ON documents.customer_id = customers.id
          UNION ALL
          SELECT invoices.id, invoices.invoice_number as doc_number, 'Rechnung' as doc_type, invoices.total_amount, invoices.status, customers.company_name, customers.contact_person
          FROM invoices
          LEFT JOIN customers ON invoices.customer_id = customers.id
        ) combined
        ORDER BY id DESC LIMIT 5
      `;

      const offerRes = await dbQuery(sqlOffers);
      const invoiceRes = await dbQuery(sqlInvoices);
      const customerRes = await dbQuery(sqlCustomers);
      const recentDocsRes = await dbQuery(sqlRecentDocs);

      const offerData = offerRes.rows[0];
      const invoiceData = invoiceRes.rows[0];
      const customerData = customerRes.rows[0];

      const stats = {
        openOffersCount: offerData ? offerData.count : 0,
        openOffersSum: offerData ? Number(offerData.total).toLocaleString('de-DE', { minimumFractionDigits: 2 }) : '0,00',
        openInvoicesCount: invoiceData ? invoiceData.count : 0,
        openInvoicesSum: invoiceData ? Number(invoiceData.total).toLocaleString('de-DE', { minimumFractionDigits: 2 }) : '0,00',
        totalCustomers: customerData ? customerData.count : 0
      };

      const formattedDocs = (recentDocsRes.rows || []).map(doc => ({
        ...doc,
        customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
      }));

      res.render('dashboard', { stats, recentDocs: formattedDocs });
    }
  } catch (err) {
    console.error('Fehler im Dashboard:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

module.exports = router;
