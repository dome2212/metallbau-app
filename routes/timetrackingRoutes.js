const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');
const { requireAdmin, hasPerm } = require('../middleware/auth');
const { getFirma } = require('../utils/companySettings');

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
    const firma = await getFirma().catch(() => ({}));
    const stampAllowProject  = firma.stamp_allow_project    !== 'false';
    const stampGeofence      = firma.stamp_geofence_enabled !== 'false';

    const allProjects = projectsRes.rows || [];
    // Projekte nur übergeben wenn Baustellen-Stempeln aktiviert
    const visibleProjects = stampAllowProject ? allProjects : [];
    // Geo-Fencing nur wenn aktiviert
    const geoProjects = stampGeofence ? allProjects.filter(p => p.site_lat && p.site_lng) : [];
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
      projects: visibleProjects,
      geoProjects,
      activeProjectId,
      activeProjectTitle,
      stampSettings: {
        allowProject:  stampAllowProject,
        allowNote:     firma.stamp_allow_note    !== 'false',
        allowSwitch:   firma.stamp_allow_switch  !== 'false',
        geofence:      stampGeofence,
      }
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

  if (type === 'IN') {
    const firma = await getFirma().catch(() => ({}));

    // GPS-Pflicht: deaktivierbar über Admin-Panel (stamp_require_gps)
    const gpsRequired  = firma.stamp_require_gps  !== 'false';
    // Admins ausgenommen: konfigurierbar (stamp_admin_no_gps)
    const adminNoGps   = firma.stamp_admin_no_gps !== 'false';
    const isAdmin      = userRole === 'ADMIN' || userRole === 'CHEF';
    const skipGps      = isAdmin && adminNoGps;

    if (gpsRequired && !skipGps) {
      if (!latitude || !longitude) {
        return res.status(400).send('Standort konnte nicht ermittelt werden. GPS ist für das Einstempeln erforderlich.');
      }
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      const FIRM_LAT    = parseFloat(process.env.FIRM_LAT || firma.firm_lat || '51.3069467');
      const FIRM_LNG    = parseFloat(process.env.FIRM_LNG || firma.firm_lng || '6.9483845');
      const FIRM_RADIUS = parseInt(process.env.FIRM_RADIUS_METERS || firma.firm_radius || '300', 10);
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
    if (role === 'ADMIN' || role === 'CHEF') {
      const userRes = await dbQuery('SELECT id, username FROM users ORDER BY username ASC');
      users = userRes.rows;
    }

    const targetUserId = req.query.user_id || userId;
    const entriesRes   = await dbQuery(
      isPg
        ? `SELECT time_logs.*, projects.title as project_title,
                  TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs
           LEFT JOIN projects ON time_logs.project_id = projects.id
           WHERE time_logs.user_id = ? AND to_char(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
           ORDER BY time_logs.timestamp ASC`
        : `SELECT time_logs.*, projects.title as project_title,
                  strftime('%Y-%m-%d %H:%M:%S', time_logs.timestamp) as local_timestamp
           FROM time_logs
           LEFT JOIN projects ON time_logs.project_id = projects.id
           WHERE time_logs.user_id = ? AND strftime('%Y-%m', time_logs.timestamp) = ?
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

// ==========================================
// PDF-EXPORT STUNDENZETTEL
// ==========================================
router.get('/admin/export-pdf', async (req, res) => {
  try {
    const targetUserId = req.query.user_id || req.user.id;
    const month        = req.query.month   || new Date().toISOString().slice(0, 7);
    const dailyHours   = parseFloat(req.query.daily_hours || '8');

    const [logsRes, userRes] = await Promise.all([
      dbQuery(
        isPg
          ? `SELECT t.*, u.username, projects.title as project_title,
                    TO_CHAR(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
             FROM time_logs t
             JOIN users u ON t.user_id = u.id
             LEFT JOIN projects ON t.project_id = projects.id
             WHERE t.user_id = ? AND to_char(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
             ORDER BY t.timestamp ASC`
          : `SELECT t.*, u.username, projects.title as project_title,
                    strftime('%Y-%m-%d %H:%M:%S', t.timestamp) as local_timestamp
             FROM time_logs t
             JOIN users u ON t.user_id = u.id
             LEFT JOIN projects ON t.project_id = projects.id
             WHERE t.user_id = ? AND strftime('%Y-%m', t.timestamp) = ?
             ORDER BY t.timestamp ASC`,
        [targetUserId, month]
      ),
      dbQuery('SELECT username FROM users WHERE id = ?', [targetUserId])
    ]);

    const entries  = logsRes.rows || [];
    const username = userRes.rows[0]?.username || 'Mitarbeiter';

    // Stunden berechnen
    let totalMs = 0;
    const pairs = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type !== 'IN') continue;
      const inEntry  = entries[i];
      const outEntry = entries[i + 1] && entries[i + 1].type === 'OUT' ? entries[i + 1] : null;
      const inTime   = new Date((inEntry.local_timestamp || inEntry.timestamp).replace(' ', 'T'));
      const outTime  = outEntry ? new Date((outEntry.local_timestamp || outEntry.timestamp).replace(' ', 'T')) : null;
      const ms       = outTime ? outTime - inTime : 0;
      if (ms > 0) totalMs += ms;
      pairs.push({ inTime, outTime, ms, note: inEntry.note, project: inEntry.project_title });
    }

    const workedH = Math.floor(totalMs / 3600000);
    const workedM = Math.floor((totalMs % 3600000) / 60000);

    // Soll-Stunden
    const [yyyy, mm] = month.split('-').map(Number);
    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    let workdays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(yyyy, mm - 1, d).getDay();
      if (dow !== 0 && dow !== 6) workdays++;
    }
    const targetH = workdays * dailyHours;
    const diffH   = (totalMs / 3600000 - targetH).toFixed(2);

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Stundenzettel_${username}_${month}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('Stundenzettel', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).font('Helvetica').text(`Mitarbeiter: ${username}`, { align: 'center' });
    doc.fontSize(11).text(`Monat: ${new Date(yyyy, mm - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}`, { align: 'center' });
    doc.moveDown(1);

    // Zusammenfassung
    doc.rect(50, doc.y, 495, 60).fill('#f1f5f9').stroke('#e2e8f0');
    const summaryY = doc.y + 8;
    doc.fill('#1e293b').font('Helvetica-Bold').fontSize(10);
    doc.text(`Gearbeitet: ${workedH} Std. ${workedM} Min.`, 70, summaryY);
    doc.text(`Soll: ${targetH} Std.  (${dailyHours} h/Tag × ${workdays} Werktage)`, 70, summaryY + 16);
    doc.text(`Differenz: ${parseFloat(diffH) >= 0 ? '+' : ''}${diffH} Std.`, 70, summaryY + 32);
    doc.moveDown(4);

    // Tabellen-Header
    doc.fill('#334155').font('Helvetica-Bold').fontSize(9);
    const col = { date: 50, in: 130, out: 200, dur: 270, proj: 340, note: 430 };
    doc.text('Datum',     col.date, doc.y);
    doc.text('Kommen',    col.in,   doc.y);
    doc.text('Gehen',     col.out,  doc.y);
    doc.text('Dauer',     col.dur,  doc.y);
    doc.text('Projekt',   col.proj, doc.y);
    doc.text('Notiz',     col.note, doc.y);
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cbd5e1').stroke();
    doc.moveDown(0.3);

    // Zeilen
    doc.font('Helvetica').fontSize(8.5).fill('#334155');
    let rowY = doc.y;
    pairs.forEach((p, idx) => {
      if (rowY > 740) { doc.addPage(); rowY = 50; }
      const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
      doc.rect(50, rowY - 2, 495, 16).fill(bg).stroke('white');
      doc.fill('#334155');
      const fmt = (d) => d ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
      const fmtDate = (d) => d ? d.toLocaleDateString('de-DE') : '–';
      const dur = p.ms > 0 ? `${Math.floor(p.ms/3600000)}h ${Math.floor((p.ms%3600000)/60000)}min` : '–';
      doc.text(fmtDate(p.inTime), col.date, rowY, { width: 75 });
      doc.text(fmt(p.inTime),     col.in,   rowY, { width: 65 });
      doc.text(fmt(p.outTime),    col.out,  rowY, { width: 65 });
      doc.text(dur,               col.dur,  rowY, { width: 65 });
      doc.text((p.project || '–').substring(0, 18), col.proj, rowY, { width: 85 });
      doc.text((p.note    || '–').substring(0, 18), col.note, rowY, { width: 115 });
      rowY += 16;
      doc.y = rowY;
    });

    if (pairs.length === 0) {
      doc.text('Keine Einträge für diesen Monat.', { align: 'center' });
    }

    // Unterschriften-Block
    doc.moveDown(3);
    doc.moveTo(50, doc.y).lineTo(220, doc.y).strokeColor('#94a3b8').stroke();
    doc.text('Mitarbeiter (Unterschrift)', 50, doc.y + 4);
    doc.moveTo(325, doc.y - 4).lineTo(495, doc.y - 4).strokeColor('#94a3b8').stroke();
    doc.text('Arbeitgeber (Unterschrift)', 325, doc.y + 4);

    doc.end();
  } catch (err) {
    console.error('Fehler beim PDF-Export:', err);
    res.status(500).send('Fehler beim Erstellen des PDFs.');
  }
});

module.exports = router;
