const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { dbQuery }      = require('../utils/db');
const { requireAdmin } = require('../middleware/auth');
const { FIRMA }        = require('../utils/firma');
const { sendWhatsApp } = require('../utils/notifier');

const isPg = !!process.env.DATABASE_URL;

let PDFKit;
try { PDFKit = require('pdfkit'); } catch (_) {}

// ==========================================
// MITARBEITERVERWALTUNG
// ==========================================
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery(
      'SELECT id, username, role, whatsapp_phone, whatsapp_api_key, whatsapp_notify, created_at FROM users ORDER BY created_at DESC'
    );
    res.render('admin-users', { users: result.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

router.post('/users/add', requireAdmin, async (req, res) => {
  const { username, password, role, whatsapp_phone } = req.body;
  if (!username || !password) return res.status(400).send('Benutzername und Passwort erforderlich');
  const hashedPassword = bcrypt.hashSync(password, 10);
  const userRole = role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
  const phone    = (whatsapp_phone || '').trim() || null;
  try {
    await dbQuery(
      `INSERT INTO users (username, password_hash, role, whatsapp_phone) VALUES (?, ?, ?, ?)`,
      [username, hashedPassword, userRole, phone]
    );
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Benutzername existiert möglicherweise bereits.');
  }
});

router.post('/users/set-whatsapp', requireAdmin, async (req, res) => {
  const { user_id, whatsapp_phone, whatsapp_api_key } = req.body;
  const phone  = (whatsapp_phone   || '').trim() || null;
  const apiKey = (whatsapp_api_key || '').trim() || null;
  try {
    await dbQuery('UPDATE users SET whatsapp_phone = ?, whatsapp_api_key = ? WHERE id = ?', [phone, apiKey, user_id]);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Fehler beim Speichern der WhatsApp-Daten.');
  }
});

router.post('/users/toggle-whatsapp-notify', requireAdmin, async (req, res) => {
  const { user_id, notify } = req.body;
  const val = notify === '1';
  try {
    await dbQuery('UPDATE users SET whatsapp_notify = ? WHERE id = ?', [val, user_id]);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Fehler beim Ändern der Benachrichtigungseinstellung.');
  }
});

router.post('/users/change-password', requireAdmin, async (req, res) => {
  const { user_id, new_password } = req.body;
  if (!user_id || !new_password || new_password.length < 6) {
    return res.status(400).send('Ungültige Eingabe. Passwort muss mindestens 6 Zeichen haben.');
  }
  const hashedPassword = bcrypt.hashSync(new_password, 10);
  try {
    await dbQuery('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, user_id]);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Fehler beim Ändern des Passworts');
  }
});

router.post('/users/delete', requireAdmin, async (req, res) => {
  const { id } = req.body;
  if (parseInt(id) === req.user.id) {
    return res.status(400).send('Du kannst deinen eigenen Account nicht löschen.');
  }
  try {
    await dbQuery('DELETE FROM users WHERE id = ?', [id]);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// ADMIN ZEITERFASSUNG
// ==========================================
router.get('/timetracking', requireAdmin, async (req, res) => {
  try {
    const activeTab      = req.query.tab || 'daily';
    const selectedDate   = req.query.date || '';
    const selectedUserId = req.query.user_id || '';

    const usersRes = await dbQuery('SELECT id, username FROM users ORDER BY username ASC');
    const users    = usersRes.rows || [];

    const tsCol = isPg
      ? `TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')`
      : `strftime('%Y-%m-%d %H:%M:%S', time_logs.timestamp)`;
    const dateFilter = isPg
      ? `DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')`
      : `date(time_logs.timestamp)`;

    let logsQuery  = `SELECT time_logs.*, users.username, ${tsCol} as local_timestamp FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1`;
    const logsParams = [];
    if (selectedDate) { logsQuery += ` AND ${dateFilter} = ?`; logsParams.push(selectedDate); }
    if (selectedUserId) { logsQuery += ` AND time_logs.user_id = ?`; logsParams.push(selectedUserId); }
    logsQuery += ` ORDER BY time_logs.timestamp DESC`;

    const logsResult = await dbQuery(logsQuery, logsParams);
    const logs = (logsResult.rows || []).map(log => ({ ...log, timestamp: log.local_timestamp || log.timestamp }));

    const month       = req.query.month || new Date().toISOString().slice(0, 7);
    const monthUserId = req.query.month_user_id || (users.length > 0 ? users[0].id : req.user.id);
    const dailyHours  = parseFloat(req.query.daily_hours || '8');

    const monthlyEntriesRes = await dbQuery(
      isPg
        ? `SELECT time_logs.*, TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ? AND to_char(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') = ?
           ORDER BY time_logs.timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ? AND strftime('%Y-%m', timestamp) = ?
           ORDER BY time_logs.timestamp ASC`,
      [monthUserId, month]
    );
    const monthlyEntries = (monthlyEntriesRes.rows || []).map(e => ({ ...e, timestamp: e.local_timestamp || e.timestamp }));

    let workedMs = 0;
    for (let i = 0; i < monthlyEntries.length; i++) {
      if (monthlyEntries[i].type !== 'IN') continue;
      const start = new Date(monthlyEntries[i].timestamp).getTime();
      const next  = monthlyEntries[i + 1];
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
    const targetHours   = workdaysInMonth * dailyHours;
    const overtimeHours = workedHours - targetHours;

    res.render('admin-timetracking', {
      users, user: req.user, activeTab,
      logs, selectedDate, selectedUserId,
      month, monthUserId, monthlyEntries, dailyHours,
      workedHours:   workedHours.toFixed(2),
      targetHours:   targetHours.toFixed(2),
      overtimeHours: overtimeHours.toFixed(2)
    });
  } catch (err) {
    console.error('Fehler beim Laden der Zeiterfassung:', err);
    res.status(500).send('Fehler beim Laden der Zeiterfassung');
  }
});

router.post('/timetracking/add', requireAdmin, async (req, res) => {
  const { user_id, type, date, time, note } = req.body;
  if (!user_id || !type || !date || !time) {
    return res.status(400).send('Alle Pflichtfelder müssen ausgefüllt werden.');
  }
  try {
    const timestampString = `${date} ${time}:00`;
    const sql = isPg
      ? `INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, (TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS') AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'UTC')`
      : `INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, ?)`;
    await dbQuery(sql, [user_id, type, note || null, timestampString]);
    res.redirect('/admin/timetracking');
  } catch (err) {
    console.error('Fehler beim Nachtragen der Arbeitszeit:', err.message);
    res.status(500).send('Fehler beim Speichern des Eintrags.');
  }
});

router.post('/timetracking/delete', requireAdmin, async (req, res) => {
  const { log_id } = req.body;
  try {
    await dbQuery('DELETE FROM time_logs WHERE id = ?', [log_id]);
    res.redirect('back');
  } catch (err) {
    console.error('Fehler beim Löschen des Stempel-Eintrags:', err.message);
    res.status(500).send('Fehler beim Löschen');
  }
});

router.get('/timetracking/pdf', requireAdmin, async (req, res) => {
  const { user_id, date } = req.query;
  try {
    const tsColPdf = isPg
      ? `TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')`
      : `strftime('%Y-%m-%d %H:%M:%S', time_logs.timestamp)`;
    const dateFilterPdf = isPg
      ? `DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')`
      : `date(time_logs.timestamp)`;

    let query = `SELECT time_logs.*, users.username, ${tsColPdf} as local_timestamp FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1`;
    let queryParams = [];
    if (user_id) { query += ` AND time_logs.user_id = ?`; queryParams.push(user_id); }
    if (date)    { query += ` AND ${dateFilterPdf} = ?`;  queryParams.push(date); }
    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    const logs   = (result.rows || []).map(log => ({ ...log, timestamp: log.local_timestamp || log.timestamp }));

    let employeeName = 'Alle Mitarbeiter';
    if (user_id) {
      const userRes = await dbQuery('SELECT username FROM users WHERE id = ?', [user_id]);
      if (userRes.rows && userRes.rows.length > 0) employeeName = userRes.rows[0].username;
    }

    if (!PDFKit) return res.status(500).send('PDF-Generator nicht geladen.');

    const doc = new PDFKit({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Arbeitszeiten_${employeeName.replace(/\s+/g, '_')}.pdf`);
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Arbeitszeiten-Übersicht', { align: 'left' });
    doc.fontSize(12).font('Helvetica').text(`Mitarbeiter: ${employeeName}`, { align: 'left' });
    if (date) doc.text(`Datum: ${date}`, { align: 'left' });
    doc.fontSize(9).text(`Erstellt am: ${new Date().toLocaleDateString('de-DE')}`, { align: 'left' });
    doc.moveDown(1.5);

    doc.fontSize(10).font('Helvetica-Bold');
    let startY = doc.y;
    doc.text('Datum / Uhrzeit', 50, startY, { width: 130 });
    doc.text('Aktion',          185, startY, { width: 150 });
    doc.text('Notiz',           345, startY, { width: 200 });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.8);

    doc.font('Helvetica').fontSize(9);
    if (logs.length > 0) {
      logs.forEach(log => {
        if (doc.y > 750) doc.addPage();
        const logDate  = new Date(log.timestamp).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        const rowY     = doc.y;
        doc.text(logDate, 50, rowY, { width: 130, lineBreak: false });
        doc.text(log.type === 'IN' ? 'Eingestempelt (IN)' : 'Ausgestempelt (OUT)', 185, rowY, { width: 150, lineBreak: false });
        doc.text(log.note || '-', 345, rowY, { width: 200 });
        doc.moveDown(1.2);
      });
    } else {
      doc.text('Keine Einträge für diesen Filter gefunden.', 50, doc.y);
    }
    doc.end();
  } catch (err) {
    console.error('Fehler beim PDF-Export:', err.message);
    res.status(500).send('Fehler beim Generieren der PDF.');
  }
});

// ==========================================
// SCHWARZES BRETT (TICKER)
// ==========================================
router.post('/add', requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim() === '') return res.redirect('/');
  try {
    await dbQuery('INSERT INTO tickers (message, author) VALUES (?, ?)', [message.trim(), req.user.username]);

    // WhatsApp-Benachrichtigung an alle Mitarbeiter mit aktivierter Benachrichtigung
    const usersRes = await dbQuery(
      `SELECT whatsapp_phone, whatsapp_api_key FROM users WHERE whatsapp_notify = true AND whatsapp_phone IS NOT NULL AND whatsapp_api_key IS NOT NULL`
    );
    const msg = `📌 Schwarzes Brett (${req.user.username}): ${message.trim()}`;
    for (const u of (usersRes.rows || [])) {
      sendWhatsApp(u.whatsapp_phone, msg, u.whatsapp_api_key).catch(() => {});
    }
  } catch (err) {
    console.error('Fehler beim Speichern des Tickers:', err.message);
  }
  res.redirect('/');
});

router.post('/delete', requireAdmin, async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM tickers WHERE id = ?', [id]);
  } catch (err) {
    console.error('Fehler beim Löschen des Tickers:', err.message);
  }
  res.redirect('/');
});

module.exports = router;
