const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');

router.get('/', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const dbQuery = req.app.get('dbQuery');

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
      // ── Offene Angebote ─────────────────────────────────────────
      const sqlOffers = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
        FROM documents 
        WHERE doc_type = 'OFFER' AND status != 'ANGENOMMEN' AND status != 'ABGELEHNT'
      `;
      // ── Unbezahlte Rechnungen ───────────────────────────────────
      const sqlInvoices = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total 
        FROM invoices 
        WHERE status != 'Bezahlt'
      `;
      // ── Kunden Gesamt ───────────────────────────────────────────
      const sqlCustomers = `SELECT COUNT(*) as count FROM customers`;

      // ── Aktive Aufträge ─────────────────────────────────────────
      const sqlActiveProjects = `
        SELECT COUNT(*) as count FROM projects
        WHERE status NOT IN ('Abgeschlossen')
      `;

      // ── Fällige Rechnungen (Fälligkeitsdatum <= heute) ──────────
      const sqlOverdueInvoices = `
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
        FROM invoices
        WHERE status != 'Bezahlt'
          AND due_date IS NOT NULL
          AND due_date != ''
          AND due_date <= date('now')
      `;

      // ── Offene Mängel (Aufgaben mit Status 'Offen') ─────────────
      const sqlOpenTasks = `
        SELECT COUNT(*) as count FROM project_tasks
        WHERE status = 'Offen'
      `;

      // ── Umsatz diese Woche (bezahlte Rechnungen) ────────────────
      const sqlWeekRevenue = `
        SELECT COALESCE(SUM(total_amount), 0) as total
        FROM invoices
        WHERE status = 'Bezahlt'
          AND created_at >= date('now', 'weekday 1', '-7 days')
      `;

      // ── Letzte Vorgänge ─────────────────────────────────────────
      const sqlRecentDocs = `
        SELECT * FROM (
          SELECT documents.id, documents.doc_number, 'OFFER' as doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person
          FROM documents
          LEFT JOIN customers ON documents.customer_id = customers.id
          UNION ALL
          SELECT invoices.id, invoices.invoice_number as doc_number, 'INVOICE' as doc_type, invoices.total_amount, invoices.status, customers.company_name, customers.contact_person
          FROM invoices
          LEFT JOIN customers ON invoices.customer_id = customers.id
        ) combined
        ORDER BY id DESC LIMIT 5
      `;

      const [offerRes, invoiceRes, customerRes, activeProjectsRes, overdueRes, openTasksRes, weekRevenueRes, recentDocsRes] = await Promise.all([
        dbQuery(sqlOffers),
        dbQuery(sqlInvoices),
        dbQuery(sqlCustomers),
        dbQuery(sqlActiveProjects),
        dbQuery(sqlOverdueInvoices),
        dbQuery(sqlOpenTasks),
        dbQuery(sqlWeekRevenue),
        dbQuery(sqlRecentDocs),
      ]);

      const fmt = (n) => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 });

      const stats = {
        openOffersCount:     offerRes.rows[0]?.count ?? 0,
        openOffersSum:       fmt(offerRes.rows[0]?.total),
        openInvoicesCount:   invoiceRes.rows[0]?.count ?? 0,
        openInvoicesSum:     fmt(invoiceRes.rows[0]?.total),
        totalCustomers:      customerRes.rows[0]?.count ?? 0,
        activeProjectsCount: activeProjectsRes.rows[0]?.count ?? 0,
        overdueInvoicesCount: overdueRes.rows[0]?.count ?? 0,
        overdueInvoicesSum:  fmt(overdueRes.rows[0]?.total),
        openTasksCount:      openTasksRes.rows[0]?.count ?? 0,
        weekRevenueSum:      fmt(weekRevenueRes.rows[0]?.total),
      };

      const formattedDocs = (recentDocsRes.rows || []).map(doc => ({
        ...doc,
        customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
      }));

      const tickerRes = await dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 10');

      res.render('dashboard', { stats, recentDocs: formattedDocs, tickers: tickerRes.rows || [] });
    }
  } catch (err) {
    console.error('Fehler im Dashboard:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

module.exports = router;
