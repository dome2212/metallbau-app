const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');

const isPg = !!process.env.DATABASE_URL;

function parseBerlinDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  if (/[zZ]$/.test(normalized) || /[+-]\d{2}:?\d{2}$/.test(normalized)) {
    return new Date(normalized);
  }
  return new Date(normalized + '+01:00');
}

router.get('/', async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    if (userRole === 'EMPLOYEE') {
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth();
      const monthStr = `${curYear}-${String(curMonth + 1).padStart(2, '0')}`;
      const monthStartStr = `${monthStr}-01`;
      const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
      const monthEndStr = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;

      const sqlMonthLogs = isPg
        ? `SELECT time_logs.*, TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ?
           AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') BETWEEN ? AND ?
           ORDER BY timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ?
           AND date(timestamp) BETWEEN ? AND ?
           ORDER BY timestamp ASC`;

      const result = await dbQuery(sqlMonthLogs, [userId, monthStartStr, monthEndStr]);
      const logs = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn = false;

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const currentLogTime = parseBerlinDate(logs[i].local_timestamp || logs[i].timestamp);
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const startTime = currentLogTime.getTime();
            const nextLog = logs[i + 1];
            let endTime;
            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
              endTime = parseBerlinDate(nextLog.local_timestamp || nextLog.timestamp).getTime();
            } else if (i === logs.length - 1) {
              endTime = now.getTime();
            } else {
              endTime = startTime;
            }
            if (endTime > startTime) totalMilliseconds += (endTime - startTime);
          } else if (logs[i].type === 'OUT') {
            isStampedIn = false;
          }
        }
      }

      const monthTotalHours = (totalMilliseconds / 3600000).toFixed(2);
      const { getFirma: _getDashFirma } = require('../utils/companySettings');
      const _dashFirma = await _getDashFirma();
      const dailyHours = parseFloat(_dashFirma.work_hours_per_day || 8);
      let workdaysSoFar = 0;
      for (let d = 1; d <= now.getDate(); d++) {
        const dow = new Date(curYear, curMonth, d).getDay();
        if (dow !== 0 && dow !== 6) workdaysSoFar++;
      }
      const targetHours = workdaysSoFar * dailyHours;
      const overtimeHours = parseFloat(monthTotalHours) - targetHours;
      const overtimeAbs = Math.abs(overtimeHours);
      const overtimeH = Math.floor(overtimeAbs);
      const overtimeM = Math.round((overtimeAbs - overtimeH) * 60);

      let trafficLight, trafficColor, trafficBorder, trafficBg, trafficText;
      if (overtimeHours >= -2) {
        trafficLight = '🟢'; trafficColor = 'text-emerald-700';
        trafficBorder = 'border-emerald-500'; trafficBg = 'bg-emerald-50';
        trafficText = overtimeHours >= 0
          ? `+${overtimeH} Std. ${overtimeM} Min. Überstunden`
          : `${overtimeH} Std. ${overtimeM} Min. unter Soll (OK)`;
      } else if (overtimeHours >= -6) {
        trafficLight = '🟡'; trafficColor = 'text-amber-700';
        trafficBorder = 'border-amber-400'; trafficBg = 'bg-amber-50';
        trafficText = `−${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      } else {
        trafficLight = '🔴'; trafficColor = 'text-red-700';
        trafficBorder = 'border-red-500'; trafficBg = 'bg-red-50';
        trafficText = `−${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      }

      const progressPct = targetHours > 0 ? Math.min(120, Math.round((parseFloat(monthTotalHours) / targetHours) * 100)) : 0;
      const progressColor = overtimeHours >= -2 ? '#10b981' : overtimeHours >= -6 ? '#f59e0b' : '#ef4444';

      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
      const mondayStart = new Date(now);
      mondayStart.setHours(0, 0, 0, 0);
      mondayStart.setDate(mondayStart.getDate() - dayOfWeek);

      let weekMs = 0;
      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const t = parseBerlinDate(logs[i].local_timestamp || logs[i].timestamp);
          if (t < mondayStart || logs[i].type !== 'IN') continue;
          const start = t.getTime();
          const next = logs[i + 1];
          let end;
          if (next && next.type === 'OUT') {
            end = parseBerlinDate(next.local_timestamp || next.timestamp).getTime();
          } else if (i === logs.length - 1) {
            end = now.getTime();
          } else {
            end = start;
          }
          if (end > start) weekMs += (end - start);
        }
      }
      const weekTotalHours = (weekMs / 3600000).toFixed(2);

      const stats = {
        monthTotalHours,
        weekTotalHours,
        isStampedIn,
        targetHours,
        overtimeHours: overtimeHours.toFixed(2),
        trafficLight,
        trafficColor,
        trafficBorder,
        trafficBg,
        trafficText,
        progressPct,
        progressColor,
        monthLabel: now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
      };

      const recentLogs = [...logs].reverse().slice(0, 5);
      const tickerRes = await dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 5');
      const myTasksRes = await dbQuery(`
        SELECT t.*, u2.username as assigned_by_name
        FROM tasks t
        LEFT JOIN users u2 ON t.assigned_by = u2.id
        WHERE (t.assigned_to = ? OR t.assigned_to IS NULL) AND t.status = 'Offen'
        ORDER BY CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END, t.due_date ASC
        LIMIT 5
      `, [userId]);

      const todayStr = now.toISOString().slice(0, 10);
      let todaySite = null;
      try {
        const sa = await dbQuery(
          `SELECT sa.*, p.title as project_title, p.id as pid, p.street, p.zip, p.city
           FROM staff_assignments sa
           LEFT JOIN projects p ON sa.project_id = p.id
           WHERE sa.user_id = ? AND sa.assignment_date = ? AND p.deleted_at IS NULL`,
          [userId, todayStr]
        );
        todaySite = sa.rows?.[0] || null;
      } catch (e) { console.error('⚠️ GET /:', e.message); }

      res.render('dashboard-employee', {
        stats,
        recentLogs,
        tickers: tickerRes.rows || [],
        myTasks: myTasksRes.rows || [],
        roleLabel: 'Mitarbeiter',
        todaySite,
        isStampedIn: stats.isStampedIn
      });
    } else {
      const sqlOverdueInvoices = isPg
        ? `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM documents WHERE doc_type = 'INVOICE' AND status NOT IN ('Bezahlt', 'ENTWURF') AND due_date IS NOT NULL AND due_date != '' AND due_date::date <= CURRENT_DATE`
        : `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM documents WHERE doc_type = 'INVOICE' AND status NOT IN ('Bezahlt', 'ENTWURF') AND due_date IS NOT NULL AND due_date != '' AND due_date <= date('now')`;

      const sqlOverdueTasks = isPg
        ? `SELECT pt.id, pt.title, pt.due_date, p.title as project_title, p.id as project_id
           FROM project_tasks pt LEFT JOIN projects p ON pt.project_id = p.id
           WHERE pt.status = 'Offen' AND pt.due_date IS NOT NULL AND pt.due_date != ''
             AND pt.due_date::date < CURRENT_DATE
           ORDER BY pt.due_date ASC LIMIT 5`
        : `SELECT pt.id, pt.title, pt.due_date, p.title as project_title, p.id as project_id
           FROM project_tasks pt LEFT JOIN projects p ON pt.project_id = p.id
           WHERE pt.status = 'Offen' AND pt.due_date IS NOT NULL AND pt.due_date != ''
             AND pt.due_date < date('now')
           ORDER BY pt.due_date ASC LIMIT 5`;

      const [offerRes, invoiceRes, customerRes, activeProjectsRes, overdueRes, openTasksRes, recentDocsRes, tickerRes, settingsRes, overdueTasksRes, lowStockRes, generalTasksRes, generalTasksCountRes] = await Promise.all([
        dbQuery(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM documents WHERE doc_type = 'OFFER' AND status != 'ANGENOMMEN' AND status != 'ABGELEHNT'`),
        dbQuery(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total FROM documents WHERE doc_type = 'INVOICE' AND status NOT IN ('Bezahlt', 'ENTWURF')`),
        dbQuery(`SELECT COUNT(*) as count FROM customers`),
        dbQuery(`SELECT COUNT(*) as count FROM projects WHERE status NOT IN ('Abgeschlossen') AND deleted_at IS NULL`),
        dbQuery(sqlOverdueInvoices),
        dbQuery(`SELECT COUNT(*) as count FROM project_tasks WHERE status = 'Offen'`),
        dbQuery(`SELECT documents.id, documents.doc_number, documents.doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person FROM documents LEFT JOIN customers ON documents.customer_id = customers.id WHERE documents.doc_type IN ('OFFER','INVOICE','CREDIT') ORDER BY documents.id DESC LIMIT 8`),
        dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 10'),
        dbQuery('SELECT settings_json FROM user_settings WHERE user_id = ?', [userId]),
        dbQuery(sqlOverdueTasks),
        dbQuery(`SELECT id, material_type, bezeichnung, profil, menge, einheit, mindestbestand FROM lager_items WHERE mindestbestand > 0 AND menge <= mindestbestand ORDER BY (mindestbestand - menge) DESC LIMIT 10`),
        dbQuery(`SELECT t.*, u1.username as assigned_to_name FROM tasks t LEFT JOIN users u1 ON t.assigned_to = u1.id WHERE t.status = 'Offen' ORDER BY CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END, t.due_date ASC LIMIT 6`),
        dbQuery(`SELECT COUNT(*) as count FROM tasks WHERE status = 'Offen'`)
      ]);

      const { getFirma: _getDashFirma2 } = require('../utils/companySettings');
      const _dashFirma2 = await _getDashFirma2();
      const fmt = (n) => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 });
      const stats = {
        openOffersCount: offerRes.rows[0]?.count ?? 0,
        openOffersSum: fmt(offerRes.rows[0]?.total),
        openInvoicesCount: invoiceRes.rows[0]?.count ?? 0,
        openInvoicesSum: fmt(invoiceRes.rows[0]?.total),
        totalCustomers: customerRes.rows[0]?.count ?? 0,
        activeProjectsCount: activeProjectsRes.rows[0]?.count ?? 0,
        overdueInvoicesCount: overdueRes.rows[0]?.count ?? 0,
        overdueInvoicesSum: fmt(overdueRes.rows[0]?.total),
        openTasksCount: openTasksRes.rows[0]?.count ?? 0,
        openGeneralTasksCount: generalTasksCountRes.rows[0]?.count ?? 0,
        kpiOverdueWarn: parseInt(_dashFirma2.kpi_overdue_warn || 3),
        kpiOverdueDanger: parseInt(_dashFirma2.kpi_overdue_danger || 6),
        kpiTasksWarn: parseInt(_dashFirma2.kpi_tasks_warn || 5),
        kpiTasksDanger: parseInt(_dashFirma2.kpi_tasks_danger || 10),
      };

      const formattedDocs = (recentDocsRes.rows || []).map(doc => ({
        ...doc,
        customer_name: doc.company_name || doc.contact_person || 'Kein Kunde'
      }));

      let widgetSettings = {};
      if (settingsRes.rows[0]?.settings_json) {
        try { widgetSettings = JSON.parse(settingsRes.rows[0].settings_json); } catch (_) {}
      }

      const lowStockItems = lowStockRes.rows || [];
      const roleLabel = userRole === 'CHEF' ? 'Chef' : (userRole === 'ADMIN' ? 'Admin' : userRole);
      res.render('dashboard', {
        stats,
        recentDocs: formattedDocs,
        tickers: tickerRes.rows || [],
        widgetSettings,
        overdueTasks: overdueTasksRes.rows || [],
        lowStockItems,
        generalTasks: generalTasksRes.rows || [],
        roleLabel,
        userRole
      });
    }
  } catch (err) {
    console.error('Fehler im Dashboard:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

module.exports = router;
