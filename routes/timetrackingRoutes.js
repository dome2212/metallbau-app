const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');
const { requireAdmin } = require('../middleware/auth');

const isPg = !!process.env.DATABASE_URL;

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371e3 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==========================================
// STEMPELUHR-ANSICHT
// ==========================================
router.get('/', async (req, res) => {
  const userId = req.user.id;
  try {
    const sqlToday = isPg
      ? `SELECT time_logs.*, customers.company_name, customers.contact_person,
               projects.title as project_title,
               TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
         FROM time_logs
         LEFT JOIN customers ON time_logs.customer_id = customers.id
         LEFT JOIN projects ON time_logs.project_id = projects.id
         WHERE time_logs.user_id = ? AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = CURRENT_DATE
         ORDER BY time_logs.timestamp ASC`
      : `SELECT time_logs.*, customers.company_name, customers.contact_person,
               projects.title as project_title,
               strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
         FROM time_logs
         LEFT JOIN customers ON time_logs.customer_id = customers.id
         LEFT JOIN projects ON time_logs.project_id = projects.id
         WHERE time_logs.user_id = ? AND date(timestamp) = date('now')
         ORDER BY time_logs.timestamp ASC`;

    const result = await dbQuery(sqlToday, [userId]);
    const todayLogs = result.rows;
    const lastLog = todayLogs.length > 0 ? todayLogs[todayLogs.length - 1] : null;
    const isStampedIn = lastLog && lastLog.type === 'IN';

    let lastStampTime = '';
    if (isStampedIn && lastLog.local_timestamp) {
      const parts = lastLog.local_timestamp.split(' ')[1].split(':');
      lastStampTime = `${parts[0]}:${parts[1]}`;
    }

    let totalMilliseconds = 0;
    const now = new Date();
    for (let i = 0; i < todayLogs.length; i++) {
      if (!todayLogs[i].local_timestamp) continue;
      if (todayLogs[i].type !== 'IN') continue;
      const start = new Date(todayLogs[i].local_timestamp.replace(' ', 'T')).getTime();
      const next = todayLogs[i + 1];
      let end;
      if (next && next.type === 'OUT' && next.local_timestamp) {
        end = new Date(next.local_timestamp.replace(' ', 'T')).getTime();
      } else if (i === todayLogs.length - 1 && isStampedIn) {
        end = now.getTime();
      } else {
        end = start;
      }
      if (end > start) totalMilliseconds += (end - start);
    }
    const todayTotalHours = (totalMilliseconds / 3600000).toFixed(2);

    const projectsRes = await dbQuery(`
      SELECT projects.id, projects.title, projects.status,
             projects.site_lat, projects.site_lng, projects.site_radius,
             customers.id as customer_id, customers.company_name, customers.contact_person
      FROM projects
      LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.status != 'Abgeschlossen'
      ORDER BY projects.title ASC
    `);
    const allProjects = projectsRes.rows || [];
    const geoProjects = allProjects.filter(p => p.site_lat && p.site_lng);
    const activeProjectId    = isStampedIn && lastLog ? (lastLog.project_id    || null) : null;
    const activeProjectTitle = isStampedIn && lastLog ? (lastLog.project_title || null) : null;

    const formattedLogs = todayLogs.map(log => ({
      ...log,
      display_time: log.local_timestamp ? log.local_timestamp.split(' ')[1].substring(0, 5) : ''
    }));

    res.render('timetracking', {
      todayLogs: formattedLogs,
      isStampedIn,
      lastStampTime,
      todayTotalHours,
      projects: allProjects,
      geoProjects,
      activeProjectId,
      activeProjectTitle
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// EINSTEMPELN / AUSSTEMPELN / WECHSELN
// ==========================================
router.post('/stamp', async (req, res) => {
  const userId   = req.user.id;
  const userRole = req.user.role;
  let { type, note, project_id, latitude, longitude } = req.body;

  if (type === 'SWITCH') {
    try {
      const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
      await dbQuery(
        `INSERT INTO time_logs (user_id, type, note, latitude, longitude, timestamp) VALUES (?, 'OUT', ?, ?, ?, ${tsExpr})`,
        [userId, 'Baustelle gewechselt', latitude || null, longitude || null]
      );
    } catch (_) {}
    type = 'IN';
  }

  if (!['IN', 'OUT'].includes(type)) return res.status(400).send('Ungültiger Stempel-Typ');

  if (type === 'IN' && userRole !== 'ADMIN') {
    if (!latitude || !longitude) {
      return res.status(400).send('Standort konnte nicht ermittelt werden. GPS ist für das Einstempeln erforderlich.');
    }
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const FIRM_LAT    = parseFloat(process.env.FIRM_LAT || '51.3069467');
    const FIRM_LNG    = parseFloat(process.env.FIRM_LNG || '6.9483845');
    const FIRM_RADIUS = parseInt(process.env.FIRM_RADIUS_METERS || '300', 10);
    const distFirm    = getDistanceFromLatLonInMeters(lat, lng, FIRM_LAT, FIRM_LNG);
    const atFirm      = distFirm <= FIRM_RADIUS;

    let atSite = false;
    if (!atFirm) {
      const siteRes = await dbQuery(`
        SELECT id, site_lat, site_lng, site_radius FROM projects
        WHERE site_lat IS NOT NULL AND site_lng IS NOT NULL AND status != 'Abgeschlossen'
      `);
      for (const proj of (siteRes.rows || [])) {
        const d = getDistanceFromLatLonInMeters(lat, lng, parseFloat(proj.site_lat), parseFloat(proj.site_lng));
        if (d <= (proj.site_radius || 200)) { atSite = true; break; }
      }
    }

    if (!atFirm && !atSite) {
      return res.status(400).send(`Einstempeln verweigert: Du befindest dich weder an der Firma noch auf einer bekannten Baustelle (ca. ${Math.round(distFirm)} m von der Firma entfernt).`);
    }
  }

  let assignedProjectId  = project_id && project_id !== '' ? parseInt(project_id, 10) : null;
  let assignedCustomerId = null;
  if (assignedProjectId) {
    try {
      const pRes = await dbQuery('SELECT customer_id FROM projects WHERE id = ?', [assignedProjectId]);
      assignedCustomerId = pRes.rows[0]?.customer_id || null;
    } catch (_) {}
  }

  try {
    const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
    await dbQuery(
      `INSERT INTO time_logs (user_id, type, note, project_id, customer_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ${tsExpr})`,
      [userId, type, note || null, assignedProjectId, assignedCustomerId, latitude || null, longitude || null]
    );
    res.redirect('/timetracking');
  } catch (err) {
    try {
      const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
      await dbQuery(
        `INSERT INTO time_logs (user_id, type, note, project_id, customer_id, timestamp) VALUES (?, ?, ?, ?, ?, ${tsExpr})`,
        [userId, type, note || null, assignedProjectId, assignedCustomerId]
      );
      res.redirect('/timetracking');
    } catch (fallbackErr) {
      console.error('Fehler beim Stempeln:', fallbackErr.message);
      res.status(500).send('Fehler beim Speichern der Stempelzeit');
    }
  }
});

// ==========================================
// MONATSAUSWERTUNG (Mitarbeiter)
// ==========================================
router.get('/admin/monthly', async (req, res) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const month  = req.query.month || new Date().toISOString().slice(0, 7);

    let users = [];
    if (role === 'ADMIN') {
      const userRes = await dbQuery('SELECT id, username FROM users');
      users = userRes.rows;
    }

    const targetUserId = req.query.user_id || userId;
    const entriesRes   = await dbQuery(
      isPg
        ? `SELECT time_logs.*, TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ? AND to_char(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
           ORDER BY time_logs.timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ? AND strftime('%Y-%m', timestamp) = ?
           ORDER BY time_logs.timestamp ASC`,
      [targetUserId, month]
    );
    const entries = (entriesRes.rows || []).map(e => ({ ...e, timestamp: e.local_timestamp || e.timestamp }));

    let workedMs = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type !== 'IN') continue;
      const start = new Date(entries[i].timestamp).getTime();
      const next  = entries[i + 1];
      if (next && next.type === 'OUT') {
        const end = new Date(next.timestamp).getTime();
        if (end > start) workedMs += (end - start);
      }
    }
    const workedHours = workedMs / 3600000;

    const [yyyy, mm] = month.split('-').map(Number);
    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    let workdaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(yyyy, mm - 1, d).getDay();
      if (dow !== 0 && dow !== 6) workdaysInMonth++;
    }
    const dailyHours   = parseFloat(req.query.daily_hours || '8');
    const targetHours  = workdaysInMonth * dailyHours;
    const overtimeHours = workedHours - targetHours;

    res.render('time-monthly', {
      currentUser: req.user,
      users,
      entries,
      selectedMonth:   month,
      selectedUserId:  targetUserId,
      workedHours:     workedHours.toFixed(2),
      targetHours:     targetHours.toFixed(2),
      overtimeHours:   overtimeHours.toFixed(2),
      dailyHours
    });
  } catch (err) {
    console.error('Fehler bei Monatsauswertung:', err);
    res.status(500).send('Interner Serverfehler');
  }
});

// ==========================================
// CSV-EXPORT
// ==========================================
router.get('/admin/export-csv', async (req, res) => {
  try {
    const targetUserId = req.query.user_id || req.user.id;
    const month        = req.query.month   || new Date().toISOString().slice(0, 7);

    const logsRes = await dbQuery(
      isPg
        ? `SELECT t.*, u.username, TO_CHAR(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs t JOIN users u ON t.user_id = u.id
           WHERE t.user_id = ? AND to_char(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
           ORDER BY t.timestamp ASC`
        : `SELECT t.*, u.username, strftime('%Y-%m-%d %H:%M:%S', t.timestamp) as local_timestamp
           FROM time_logs t JOIN users u ON t.user_id = u.id
           WHERE t.user_id = ? AND strftime('%Y-%m', t.timestamp) = ?
           ORDER BY t.timestamp ASC`,
      [targetUserId, month]
    );
    const entries = logsRes.rows || [];

    let csv = 'Mitarbeiter;Datum;Typ;Notiz;Zeitpunkt\n';
    entries.forEach(e => {
      const dateObj = new Date(e.local_timestamp || e.timestamp);
      const dateStr = dateObj.toLocaleDateString('de-DE');
      const timeStr = dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const typeStr = e.type === 'IN' ? 'Kommen (IN)' : 'Gehen (OUT)';
      csv += `"${e.username}","${dateStr}","${typeStr}","${e.note || ''}","${timeStr}"\n`;
    });

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`Zeiterfassung_${month}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Fehler beim CSV-Export:', err);
    res.status(500).send('Fehler beim Generieren der CSV-Datei.');
  }
});

module.exports = router;
