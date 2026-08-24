const express = require('express');
const router  = express.Router();
const { dbQuery } = require('../utils/db');

const isPg = !!process.env.DATABASE_URL;

// ==========================================
// DASHBOARD (rollenabhängig: Chef vs. Mitarbeiter)
// ==========================================
router.get('/', async (req, res) => {
  const userId   = req.user.id;
  const userRole = req.user.role;

  try {
    if (userRole === 'EMPLOYEE') {
      // ── Mitarbeiter-Dashboard ──────────────────────────────────────────────
      const now = new Date();
      const curYear  = now.getFullYear();
      const curMonth = now.getMonth();

      const monthStr    = `${curYear}-${String(curMonth + 1).padStart(2, '0')}`;
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
      const logs   = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn       = false;

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const currentLogTime = new Date((logs[i].local_timestamp || logs[i].timestamp).replace(' ', 'T'));
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const startTime = currentLogTime.getTime();
            const nextLog   = logs[i + 1];
            let endTime;
            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
              endTime = new Date((nextLog.local_timestamp || nextLog.timestamp).replace(' ', 'T')).getTime();
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

      // Soll-Stunden aus Firmen-Einstellungen
      const { getFirma: _getDashFirma } = require('../utils/companySettings');
      const _dashFirma = await _getDashFirma();
      const dailyHours = parseFloat(_dashFirma.work_hours_per_day || 8);
      let workdaysSoFar = 0;
      for (let d = 1; d <= now.getDate(); d++) {
        const dow = new Date(curYear, curMonth, d).getDay();
        if (dow !== 0 && dow !== 6) workdaysSoFar++;
      }
      const targetHours   = workdaysSoFar * dailyHours;
      const overtimeHours = parseFloat(monthTotalHours) - targetHours;
      const overtimeAbs   = Math.abs(overtimeHours);
      const overtimeH     = Math.floor(overtimeAbs);
      const overtimeM     = Math.round((overtimeAbs - overtimeH) * 60);

      let trafficLight, trafficColor, trafficBorder, trafficBg, trafficText;
      if (overtimeHours >= -2) {
        trafficLight  = '🟢'; trafficColor  = 'text-emerald-700';
        trafficBorder = 'border-emerald-500'; trafficBg = 'bg-emerald-50';
        trafficText   = overtimeHours >= 0
          ? `+${overtimeH} Std. ${overtimeM} Min. Überstunden`
          : `${overtimeH} Std. ${overtimeM} Min. unter Soll (OK)`;
      } else if (overtimeHours >= -6) {
        trafficLight  = '🟡'; trafficColor  = 'text-amber-700';
        trafficBorder = 'border-amber-400'; trafficBg = 'bg-amber-50';
        trafficText   = `−${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      } else {
        trafficLight  = '🔴'; trafficColor  = 'text-red-700';
        trafficBorder = 'border-red-500'; trafficBg = 'bg-red-50';
        trafficText   = `−${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      }

      const progressPct   = targetHours > 0 ? Math.min(120, Math.round((parseFloat(monthTotalHours) / targetHours) * 100)) : 0;
      const progressColor = overtimeHours >= -2 ? '#10b981' : overtimeHours >= -6 ? '#f59e0b' : '#ef4444';

      // Wochenstunden
      const dayOfWeek  = now.getDay() === 0 ? 6 : now.getDay() - 1;
      const mondayStart = new Date(now);
      mondayStart.setHours(0, 0, 0, 0);
      mondayStart.setDate(mondayStart.getDate() - dayOfWeek);

      let weekMs = 0;
      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const t = new Date((logs[i].local_timestamp || logs[i].timestamp).replace(' ', 'T'));
          if (t < mondayStart || logs[i].type !== 'IN') continue;
          const start = t.getTime();
          const next  = logs[i + 1];
          let end;
          if (next && next.type === 'OUT') {
            end = new Date((next.local_timestamp || next.timestamp).replace(' ', 'T')).getTime();
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
        monthTotalHours, weekTotalHours, isStampedIn,
        targetHours, overtimeHours: overtimeHours.toFixed(2),
        trafficLight, trafficColor, trafficBorder, trafficBg, trafficText,
        progressPct, progressColor,
        monthLabel: now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
      };
      const recentLogs = [...logs].reverse().slice(0, 5);
      const tickerRes  = await dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 5');

      const myTasksRes = await dbQuery(`
        SELECT t.*, u2.username as assigned_by_name
        FROM tasks t
        LEFT JOIN users u2 ON t.assigned_by = u2.id
        WHERE (t.assigned_to = ? OR t.assigned_to IS NULL) AND t.status = 'Offen'
        ORDER BY CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END, t.due_date ASC
        LIMIT 5
      `, [userId]);

      res.render('dashboard-employee', { stats, recentLogs, tickers: tickerRes.rows || [], myTasks: myTasksRes.rows || [] });

    } else {
      // ── Chef-Dashboard ────────────────────────────────────────────────────
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
        dbQuery(`SELECT COUNT(*) as count FROM projects WHERE status NOT IN ('Abgeschlossen')`),
        dbQuery(sqlOverdueInvoices),
        dbQuery(`SELECT COUNT(*) as count FROM project_tasks WHERE status = 'Offen'`),
        dbQuery(`SELECT documents.id, documents.doc_number, documents.doc_type, documents.total_amount, documents.status, customers.company_name, customers.contact_person
          FROM documents LEFT JOIN customers ON documents.customer_id = customers.id
          ORDER BY documents.id DESC LIMIT 5`),
        dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 10'),
        dbQuery('SELECT settings_json FROM user_settings WHERE user_id = ?', [userId]),
        dbQuery(sqlOverdueTasks),
        dbQuery(`SELECT id, material_type, bezeichnung, profil, menge, einheit, mindestbestand
                 FROM lager_items WHERE mindestbestand > 0 AND menge <= mindestbestand
                 ORDER BY (mindestbestand - menge) DESC LIMIT 10`),
        dbQuery(`SELECT t.*, u1.username as assigned_to_name
                 FROM tasks t LEFT JOIN users u1 ON t.assigned_to = u1.id
                 WHERE t.status = 'Offen'
                 ORDER BY CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END, t.due_date ASC
                 LIMIT 6`),
        dbQuery(`SELECT COUNT(*) as count FROM tasks WHERE status = 'Offen'`)
      ]);

      const { getFirma: _getDashFirma2 } = require('../utils/companySettings');
      const _dashFirma2 = await _getDashFirma2();
      const fmt = (n) => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 });
      const stats = {
        openOffersCount:      offerRes.rows[0]?.count ?? 0,
        openOffersSum:        fmt(offerRes.rows[0]?.total),
        openInvoicesCount:    invoiceRes.rows[0]?.count ?? 0,
        openInvoicesSum:      fmt(invoiceRes.rows[0]?.total),
        totalCustomers:       customerRes.rows[0]?.count ?? 0,
        activeProjectsCount:  activeProjectsRes.rows[0]?.count ?? 0,
        overdueInvoicesCount: overdueRes.rows[0]?.count ?? 0,
        overdueInvoicesSum:   fmt(overdueRes.rows[0]?.total),
        openTasksCount:       openTasksRes.rows[0]?.count ?? 0,
        openGeneralTasksCount: generalTasksCountRes.rows[0]?.count ?? 0,
        // KPI-Schwellen aus Admin-Panel
        kpiOverdueWarn:   parseInt(_dashFirma2.kpi_overdue_warn   || 3),
        kpiOverdueDanger: parseInt(_dashFirma2.kpi_overdue_danger || 6),
        kpiTasksWarn:     parseInt(_dashFirma2.kpi_tasks_warn     || 5),
        kpiTasksDanger:   parseInt(_dashFirma2.kpi_tasks_danger   || 10),
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
      res.render('dashboard', { stats, recentDocs: formattedDocs, tickers: tickerRes.rows || [], widgetSettings, overdueTasks: overdueTasksRes.rows || [], lowStockItems, generalTasks: generalTasksRes.rows || [] });
    }
  } catch (err) {
    console.error('Fehler im Dashboard:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// WIDGET-EINSTELLUNGEN SPEICHERN
// ==========================================
router.post('/api/user-settings', async (req, res) => {
  try {
    const userId = req.user.id;
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'Ungültige Daten' });
    const json = JSON.stringify(settings);
    const sql  = isPg
      ? `INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, NOW()) ON CONFLICT (user_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()`
      : `INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = datetime('now')`;
    await dbQuery(sql, [userId, json]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Fehler beim Speichern der Widget-Einstellungen:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==========================================
// „HEUTIGE BAUSTELLEN" – schnelle Übersicht für Homescreen-Shortcut/Widget
// ==========================================
// Hinweis: Ein PWA kann kein natives Android-Homescreen-Widget (das ohne App-
// Öffnen Inhalte anzeigt) bereitstellen – das ist technisch nur mit einer
// nativen App-Hülle möglich. Diese Route ist bewusst super schlank gehalten
// (kein Sidebar, kaum CSS), damit sie über den PWA-Shortcut "Heutige
// Baustellen" (Icon lange gedrückt halten) in unter 1 Sekunde offen ist –
// das kommt dem Widget-Gefühl am nächsten.
router.get('/heute', async (req, res) => {
  const userId = req.user.id;
  const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'CHEF';
  try {
    const todayStr = new Date().toISOString().slice(0, 10);

    // Eigene Personalplanung für heute (falls zugewiesen)
    const assignSql = `
      SELECT sa.*, p.title as project_title, p.site_note, p.site_lat, p.site_lng, p.status,
             c.company_name, c.street, c.zip, c.city, c.phone
      FROM staff_assignments sa
      LEFT JOIN projects  p ON sa.project_id  = p.id
      LEFT JOIN customers c ON p.customer_id  = c.id
      WHERE sa.assignment_date = ? AND sa.user_id = ?
      ORDER BY p.title ASC`;
    const assignRes = await dbQuery(assignSql, [todayStr, userId]);
    let sites = assignRes.rows || [];

    // Chef/Admin ohne eigene Zuweisung: alle laufenden Baustellen von heute zeigen
    if (isAdmin && sites.length === 0) {
      const allSql = `
        SELECT sa.*, p.title as project_title, p.site_note, p.site_lat, p.site_lng, p.status,
               c.company_name, c.street, c.zip, c.city, c.phone, u.username
        FROM staff_assignments sa
        LEFT JOIN projects  p ON sa.project_id  = p.id
        LEFT JOIN customers c ON p.customer_id  = c.id
        LEFT JOIN users     u ON sa.user_id     = u.id
        WHERE sa.assignment_date = ?
        ORDER BY p.title ASC`;
      const allRes = await dbQuery(allSql, [todayStr]);
      sites = allRes.rows || [];
    }

    // ── Zusätzlich: Baustellen-Termine aus dem Kalender für heute ──────────
    // (Termine mit zugeordnetem Projekt, deren Startzeit auf heute fällt)
    const apptSql = `
      SELECT a.id, a.title as note, a.description, a.start_date,
             p.id as project_id, p.title as project_title, p.site_note, p.site_lat, p.site_lng, p.status,
             c.company_name, c.street, c.zip, c.city, c.phone
      FROM appointments a
      JOIN projects  p ON a.project_id  = p.id
      LEFT JOIN customers c ON p.customer_id = c.id
      WHERE a.project_id IS NOT NULL
        AND substr(a.start_date, 1, 10) = ?`;
    const apptRes = await dbQuery(apptSql, [todayStr]);
    let apptSites = apptRes.rows || [];

    if (apptSites.length > 0) {
      // Zuweisungen laden, um Mitarbeiter-Sicht zu filtern (leer = für alle sichtbar)
      const apptIds = apptSites.map(a => a.id);
      const placeholders = apptIds.map(() => '?').join(',');
      const assignedUsersRes = await dbQuery(
        `SELECT appointment_id, user_id FROM appointment_users WHERE appointment_id IN (${placeholders})`,
        apptIds
      ).catch(() => ({ rows: [] }));
      const apptAssignMap = {};
      for (const row of (assignedUsersRes.rows || [])) {
        if (!apptAssignMap[row.appointment_id]) apptAssignMap[row.appointment_id] = [];
        apptAssignMap[row.appointment_id].push(Number(row.user_id));
      }

      apptSites = apptSites.filter(a => {
        if (isAdmin) return true;
        const assigned = apptAssignMap[a.id] || [];
        return assigned.length === 0 || assigned.includes(Number(userId));
      });

      // Duplikate vermeiden: kein doppelter Eintrag, wenn für dasselbe Projekt
      // heute bereits eine Personalplanung existiert
      const alreadyPlannedProjectIds = new Set(sites.map(s => s.project_id).filter(Boolean));
      apptSites = apptSites.filter(a => !alreadyPlannedProjectIds.has(a.project_id));

      sites = sites.concat(apptSites);
    }

    res.render('today-widget', { sites, isAdmin, todayStr });
  } catch (err) {
    console.error('Fehler bei /heute:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// BAUSTELLENKARTE – alle aktiven Aufträge mit Standort
// ==========================================
router.get('/map', async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT p.id, p.title, p.status, p.description,
             p.site_lat, p.site_lng, p.site_radius, p.site_note,
             c.company_name, c.contact_person, c.street, c.zip, c.city, c.phone
      FROM projects p
      LEFT JOIN customers c ON p.customer_id = c.id
      WHERE p.status IS NULL OR p.status != 'Abgeschlossen'
      ORDER BY
        CASE WHEN p.site_lat IS NOT NULL AND p.site_lng IS NOT NULL THEN 0 ELSE 1 END,
        p.title ASC
    `);
    res.render('map', {
      projects: result.rows || [],
      user: req.user,
      currentUser: req.user
    });
  } catch (err) {
    console.error('Fehler bei /map:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

module.exports = router;
