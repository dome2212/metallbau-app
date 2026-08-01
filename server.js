const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const db = require('./config/database');

process.env.TZ = 'Europe/Berlin';
db.query("SET timezone = 'Europe/Berlin';").catch(() => {});

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const { verifyToken, requireAdmin } = require('./middleware/auth');

// Routen importieren
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const projectRoutes = require('./routes/projectRoutes');
const customerRoutes = require('./routes/customerRoutes');
const timetrackingRoutes = require('./routes/timetrackingRoutes');
const vacationRoutes = require('./routes/vacationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const articleRoutes = require('./routes/articleRoutes');
const calendarRoutes = require('./routes/calendarRoutes');
const tickerRoutes = require('./routes/tickerRoutes');

// Öffentliche Auth-Routen
app.use('/', authRoutes);

// Alle folgenden Routen schützen
app.use(verifyToken);

app.use('/documents', documentRoutes);
app.use('/projects', projectRoutes);
app.use('/customers', customerRoutes);
app.use('/timetracking', timetrackingRoutes);
app.use('/vacations', vacationRoutes);
app.use('/admin', requireAdmin, adminRoutes);
app.use('/articles', articleRoutes);
app.use('/calendar', calendarRoutes);
app.use('/ticker', tickerRoutes);

// Dashboard (Startseite nach Login)
app.get('/', async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      const logsRes = await dbQuery(`SELECT time_logs.*, TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs WHERE user_id = ? ORDER BY timestamp ASC`, [req.user.id]);
      let totalMilliseconds = 0, isStampedIn = false, now = new Date();
      (logsRes.rows || []).forEach((log, i, arr) => {
        const time = new Date(log.local_timestamp || log.timestamp).getTime();
        if (log.type === 'IN') {
          isStampedIn = true;
          const next = arr[i + 1];
          const end = next && next.type === 'OUT' ? (isStampedIn = false, new Date(next.local_timestamp || next.timestamp).getTime()) : (i === arr.length - 1 ? now.getTime() : time);
          if (end > time) totalMilliseconds += (end - time);
        } else if (log.type === 'OUT') isStampedIn = false;
      });
      res.render('dashboard-employee', { stats: { monthTotalHours: (totalMilliseconds / 3600000).toFixed(2), isStampedIn }, recentLogs: [...logsRes.rows].reverse().slice(0, 5) });
    } else {
      const [offers, invoices, customers, recent] = await Promise.all([
        dbQuery("SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM documents WHERE doc_type = 'OFFER' AND status NOT IN ('ANGENOMMEN', 'ABGELEHNT')"),
        dbQuery("SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM invoices WHERE status != 'Bezahlt'"),
        dbQuery("SELECT COUNT(*) as count FROM customers"),
        dbQuery(`SELECT * FROM ((SELECT id, doc_number, 'Angebot' as doc_type, total_amount, status FROM documents) UNION ALL (SELECT id, invoice_number as doc_number, 'Rechnung' as doc_type, total_amount, status FROM invoices)) combined ORDER BY id DESC LIMIT 5`)
      ]);
      res.render('dashboard', {
        stats: {
          openOffersCount: offers.rows[0].count, openOffersSum: Number(offers.rows[0].total).toLocaleString('de-DE', { minimumFractionDigits: 2 }),
          openInvoicesCount: invoices.rows[0].count, openInvoicesSum: Number(invoices.rows[0].total).toLocaleString('de-DE', { minimumFractionDigits: 2 }),
          totalCustomers: customers.rows[0].count
        },
        recentDocs: recent.rows
      });
    }
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
