const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const isPg = !!process.env.DATABASE_URL;

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    // Project status counts
    const statusRes = await dbQuery(`SELECT status, COUNT(*) as count FROM projects GROUP BY status ORDER BY count DESC`);

    // Monthly revenue (last 12 months) - only if documents table exists
    let monthlyRevenue = [];
    try {
      const revenueRes = await dbQuery(isPg
        ? `SELECT to_char(created_at, 'YYYY-MM') as month, COALESCE(SUM(total_amount),0) as total FROM documents WHERE doc_type='INVOICE' AND status='Bezahlt' AND created_at >= NOW() - INTERVAL '12 months' GROUP BY month ORDER BY month ASC`
        : `SELECT strftime('%Y-%m', created_at) as month, COALESCE(SUM(total_amount),0) as total FROM documents WHERE doc_type='INVOICE' AND status='Bezahlt' AND created_at >= date('now','-12 months') GROUP BY month ORDER BY month ASC`
      );
      monthlyRevenue = revenueRes.rows || [];
    } catch (_) {}

    // Top customers
    let topCustomers = [];
    try {
      const custRes = await dbQuery(`SELECT c.company_name, c.contact_person, COALESCE(SUM(d.total_amount),0) as total FROM customers c LEFT JOIN documents d ON d.customer_id = c.id AND d.doc_type='INVOICE' AND d.status='Bezahlt' GROUP BY c.id, c.company_name, c.contact_person ORDER BY total DESC LIMIT 10`);
      topCustomers = custRes.rows || [];
    } catch (_) {}

    res.render('reports', {
      projectStats: statusRes.rows || [],
      monthlyRevenue,
      topCustomers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Fehler beim Laden der Berichte');
  }
});

module.exports = router;
