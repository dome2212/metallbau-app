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
  const users = (await dbQuery('SELECT id, username FROM users ORDER BY username ASC')).rows;
  let q = `SELECT time_logs.*, users.username, TO_CHAR(time_logs.timestamp, 'YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1`;
  let p = [];
  if (date) { q += ` AND DATE(time_logs.timestamp) = ?`; p.push(date); }
  if (user_id) { q += ` AND time_logs.user_id = ?`; p.push(user_id); }
  q += ` ORDER BY time_logs.timestamp DESC`;

  const logs = (await dbQuery(q, p)).rows;
  res.render('admin-timetracking', { logs, users, selectedDate: date || '', selectedUserId: user_id || '', user: req.user });
});

router.post('/timetracking/add', async (req, res) => {
  const { user_id, type, date, time, note } = req.body;
  await dbQuery(`INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS'))`,
    [user_id, type, note || null, `${date} ${time}:00`]);
  res.redirect('/admin/timetracking');
});

module.exports = router;
