const express = require('express');
const router = express.Router();
const dbQuery = require('../utils/dbQuery');
const { requireAdmin } = require('../middleware/auth');

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

router.get('/', async (req, res) => {
  try {
    const sqlToday = `
      SELECT time_logs.*, customers.company_name, customers.contact_person,
             TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
      FROM time_logs LEFT JOIN customers ON time_logs.customer_id = customers.id
      WHERE time_logs.user_id = ? AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = CURRENT_DATE
      ORDER BY time_logs.timestamp ASC
    `;
    const result = await dbQuery(sqlToday, [req.user.id]);
    const todayLogs = result.rows;
    const lastLog = todayLogs[todayLogs.length - 1];
    const isStampedIn = lastLog && lastLog.type === 'IN';
    let lastStampTime = isStampedIn && lastLog.local_timestamp ? lastLog.local_timestamp.split(' ')[1].substring(0, 5) : '';

    let totalMilliseconds = 0, now = new Date();
    todayLogs.forEach((log, i) => {
      if (!log.local_timestamp) return;
      const currentLogTime = new Date(log.local_timestamp.replace(' ', 'T'));
      if (log.type === 'IN') {
        const nextLog = todayLogs[i + 1];
        const start = currentLogTime.getTime();
        const end = nextLog && nextLog.type === 'OUT' && nextLog.local_timestamp ? new Date(nextLog.local_timestamp.replace(' ', 'T')).getTime() : (i === todayLogs.length - 1 && isStampedIn ? now.getTime() : start);
        if (end > start) totalMilliseconds += (end - start);
      }
    });

    const formattedLogs = todayLogs.map(log => ({ ...log, display_time: log.local_timestamp ? log.local_timestamp.split(' ')[1].substring(0, 5) : '' }));
    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC');
    res.render('timetracking', { todayLogs: formattedLogs, isStampedIn, lastStampTime, todayTotalHours: (totalMilliseconds / 3600000).toFixed(2), customers: custRes.rows });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

router.post('/stamp', async (req, res) => {
  const { type, note, customer_id, latitude, longitude } = req.body;
  if (!['IN', 'OUT'].includes(type)) return res.status(400).send('Ungültig');

  if (type === 'IN' && req.user.role !== 'ADMIN') {
    if (!latitude || !longitude) return res.status(400).send('GPS erforderlich');
    if (getDistanceFromLatLonInMeters(parseFloat(latitude), parseFloat(longitude), 51.3069467, 6.9483845) > 300) {
      return res.status(400).send('Zu weit von der Firma entfernt.');
    }
  }

  const assignedCustomerId = customer_id && customer_id !== '' ? customer_id : null;

  try {
    await dbQuery(`INSERT INTO time_logs (user_id, type, note, customer_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, (NOW() AT TIME ZONE 'Europe/Berlin'))`,
      [req.user.id, type, note || null, assignedCustomerId, latitude || null, longitude || null]);
  } catch (e) {
    await dbQuery(`INSERT INTO time_logs (user_id, type, note, customer_id, timestamp) VALUES (?, ?, ?, ?, (NOW() AT TIME ZONE 'Europe/Berlin'))`,
      [req.user.id, type, note || null, assignedCustomerId]);
  }
  res.redirect('/timetracking');
});

router.post('/admin/delete', requireAdmin, async (req, res) => {
  await dbQuery('DELETE FROM time_logs WHERE id = ?', [req.body.log_id]);
  res.redirect('back');
});

router.get('/admin/monthly', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const targetUserId = req.query.user_id || req.user.id;
  const users = req.user.role === 'ADMIN' ? (await dbQuery('SELECT id, username FROM users')).rows : [];
  const entries = (await dbQuery(`SELECT time_logs.*, TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs WHERE user_id = ? AND to_char(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ? ORDER BY time_logs.timestamp ASC`, [targetUserId, month])).rows;

  res.render('time-monthly', { currentUser: req.user, users, entries, selectedMonth: month, selectedUserId: targetUserId });
});

router.get('/admin/export-csv', async (req, res) => {
  const targetUserId = req.query.user_id || req.user.id;
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const entries = (await dbQuery(`SELECT t.*, u.username, TO_CHAR(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs t JOIN users u ON t.user_id = u.id WHERE t.user_id = ? AND to_char(t.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ? ORDER BY t.timestamp ASC`, [targetUserId, month])).rows;

  let csv = 'Mitarbeiter;Datum;Typ;Notiz;Zeitpunkt\n';
  entries.forEach(e => {
    const d = new Date(e.local_timestamp || e.timestamp);
    csv += `"${e.username}","${d.toLocaleDateString('de-DE')}","${e.type === 'IN' ? 'Kommen' : 'Gehen'}","${e.note || ''}","${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}"\n`;
  });
  res.header('Content-Type', 'text/csv; charset=utf-8').attachment(`Zeiterfassung_${month}.csv`).send(csv);
});

module.exports = router;
