const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcryptjs');

const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    db.query(pgSql, params, (err, res) => {
      if (err) return reject(err);
      resolve({ rows: res.rows || [] });
    });
  });
};

router.get('/users', async (req, res) => {
  const result = await dbQuery('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
  res.render('admin-users', { users: result.rows });
});

router.post('/users/add', async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).send('Pflichtfelder fehlen');
  await dbQuery('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    [username, bcrypt.hashSync(password, 10), role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE']);
  res.redirect('/admin/users');
});

router.post('/users/delete', async (req, res) => {
  if (parseInt(req.body.id) === req.user.id) return res.status(400).send('Eigenen Account löschen nicht möglich');
  await dbQuery('DELETE FROM users WHERE id = ?', [req.body.id]);
  res.redirect('/admin/users');
});

router.get('/timetracking', async (req, res) => {
  const { date, user_id } = req.query;
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const dailyHours = parseFloat(req.query.daily_hours) || 8;
  const users = (await dbQuery('SELECT id, username FROM users ORDER BY username ASC')).rows;

  // Build entries table query (respects both month and optional date filter)
  let q = `SELECT time_logs.*, users.username, TO_CHAR(time_logs.timestamp, 'YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1`;
  let p = [];
  if (date) {
    q += ` AND DATE(time_logs.timestamp) = ?`; p.push(date);
  } else {
    q += ` AND to_char(time_logs.timestamp, 'YYYY-MM') = ?`; p.push(month);
  }
  if (user_id) { q += ` AND time_logs.user_id = ?`; p.push(user_id); }
  q += ` ORDER BY time_logs.timestamp DESC`;
  const logs = (await dbQuery(q, p)).rows;

  // Monthly KPI calculation (only when a specific user is selected)
  let workedHours = null, targetHours = null, overtimeHours = null;
  if (user_id) {
    const monthEntries = (await dbQuery(
      `SELECT type, TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs WHERE user_id = ? AND to_char(timestamp, 'YYYY-MM') = ? ORDER BY timestamp ASC`,
      [user_id, month]
    )).rows;

    // Worked hours from IN/OUT pairs
    let workedMs = 0;
    for (let i = 0; i < monthEntries.length; i++) {
      if (monthEntries[i].type !== 'IN') continue;
      const next = monthEntries[i + 1];
      if (next && next.type === 'OUT') {
        const start = new Date(monthEntries[i].local_timestamp.replace(' ', 'T')).getTime();
        const end = new Date(next.local_timestamp.replace(' ', 'T')).getTime();
        if (end > start) workedMs += (end - start);
      }
    }
    workedHours = (workedMs / 3600000).toFixed(2);

    // Target hours: count Mon–Fri working days in the month
    const [yr, mo] = month.split('-').map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();
    let workdays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(yr, mo - 1, d).getDay();
      if (dow !== 0 && dow !== 6) workdays++;
    }
    targetHours = (workdays * dailyHours).toFixed(2);
    overtimeHours = (parseFloat(workedHours) - parseFloat(targetHours)).toFixed(2);
  }

  res.render('admin-timetracking', {
    logs, users,
    selectedDate: date || '',
    selectedUserId: user_id || '',
    selectedMonth: month,
    dailyHours,
    workedHours,
    targetHours,
    overtimeHours,
    user: req.user
  });
});

router.post('/timetracking/add', async (req, res) => {
  const { user_id, type, date, time, note } = req.body;
  await dbQuery(`INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS'))`,
    [user_id, type, note || null, `${date} ${time}:00`]);
  res.redirect('/admin/timetracking');
});

module.exports = router;
