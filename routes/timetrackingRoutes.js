const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');
const { requireAdmin, requirePerm, hasPerm } = require('../middleware/auth');
const { getFirma } = require('../utils/companySettings');

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
  const firma = await getFirma();
  if (!hasPerm(req.user, 'timetracking', firma, true, true)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
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
      const start = parseBerlinDate(todayLogs[i].local_timestamp).getTime();
      const next = todayLogs[i + 1];
      let end;
      if (next && next.type === 'OUT' && next.local_timestamp) {
        end = parseBerlinDate(next.local_timestamp).getTime();
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
      WHERE projects.status != 'Abgeschlossen' AND projects.deleted_at IS NULL
      ORDER BY projects.title ASC
    `);
    const firma = await getFirma().catch(() => ({}));
    const stampAllowProject = firma.stamp_allow_project !== 'false';
    const stampGeofence = firma.stamp_geofence_enabled !== 'false';

    const allProjects = projectsRes.rows || [];
    const visibleProjects = stampAllowProject ? allProjects : [];
    const geoProjects = stampGeofence ? allProjects.filter(p => p.site_lat && p.site_lng) : [];
    const activeProjectId = isStampedIn && lastLog ? (lastLog.project_id || null) : null;
    const activeProjectTitle = isStampedIn && lastLog ? (lastLog.project_title || null) : null;
    const defaultProjectId = isStampedIn ? activeProjectId : (lastLog ? (lastLog.project_id || null) : null);
    const lastStampEpoch = lastLog && lastLog.local_timestamp
      ? parseBerlinDate(lastLog.local_timestamp).getTime()
      : null;

    const formattedLogs = todayLogs.map(log => ({
      ...log,
      display_time: log.local_timestamp ? log.local_timestamp.split(' ')[1].substring(0, 5) : ''
    }));

    res.render('timetracking', {
      todayLogs: formattedLogs,
      isStampedIn,
      lastStampTime,
      todayTotalHours,
      projects: visibleProjects,
      geoProjects,
      activeProjectId,
      activeProjectTitle,
      defaultProjectId,
      lastStampEpoch,
      stampSettings: {
        allowProject: stampAllowProject,
        allowNote: firma.stamp_allow_note !== 'false',
        allowSwitch: firma.stamp_allow_switch !== 'false',
        geofence: stampGeofence,
      }
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

module.exports = router;
