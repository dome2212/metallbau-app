const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const dbQuery = require('../utils/dbQuery');
const { requireAdmin } = require('../middleware/auth');

let PDFKit;
try { PDFKit = require('pdfkit'); } catch (e) {}

// FIX: verifyToken läuft bereits global vor dem Mount dieses Routers in server.js.
// Aber requireAdmin fehlte hier komplett -> jeder eingeloggte Mitarbeiter hätte
// Nutzer anlegen/löschen und alle Zeiten einsehen können. Jetzt für die ganze Datei erzwungen.
router.use(requireAdmin);

router.get('/users', async (req, res) => {
  const result = await dbQuery('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
  res.render('admin-users', { users: result.rows });
});

router.post('/users/add', async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).send('Pflichtfelder fehlen');
  try {
    await dbQuery('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, bcrypt.hashSync(password, 10), role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE']);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(500).send('Benutzername existiert möglicherweise bereits.');
  }
});

router.post('/users/delete', async (req, res) => {
  if (parseInt(req.body.id) === req.user.id) return res.status(400).send('Eigenen Account löschen nicht möglich');
  await dbQuery('DELETE FROM users WHERE id = ?', [req.body.id]);
  res.redirect('/admin/users');
});

router.get('/timetracking', async (req, res) => {
  const { date, user_id } = req.query;
  const users = (await dbQuery('SELECT id, username FROM users ORDER BY username ASC')).rows;

  // FIX: Timezone-Konvertierung ergänzt (fehlte hier bisher, dadurch waren Datum/Zeit
  // in der Admin-Übersicht bis zu 1-2h falsch gegenüber der Live-Zeiterfassung).
  let q = `
    SELECT time_logs.*, users.username,
           TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
    FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1
  `;
  let p = [];
  if (date) { q += ` AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = ?`; p.push(date); }
  if (user_id) { q += ` AND time_logs.user_id = ?`; p.push(user_id); }
  q += ` ORDER BY time_logs.timestamp DESC`;

  const logs = (await dbQuery(q, p)).rows;
  res.render('admin-timetracking', { logs, users, selectedDate: date || '', selectedUserId: user_id || '', user: req.user });
});

router.post('/timetracking/add', async (req, res) => {
  const { user_id, type, date, time, note } = req.body;
  if (!user_id || !type || !date || !time) return res.status(400).send('Alle Pflichtfelder müssen ausgefüllt werden.');
  await dbQuery(
    `INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, (TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS') AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'UTC')`,
    [user_id, type, note || null, `${date} ${time}:00`]
  );
  res.redirect('/admin/timetracking');
});

// NEU HIER: existierte bisher nur inline in server.js, fehlte komplett in adminRoutes.js
router.get('/timetracking/pdf', async (req, res) => {
  const { user_id, date } = req.query;
  try {
    let query = `
      SELECT time_logs.*, users.username,
             TO_CHAR(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
      FROM time_logs JOIN users ON time_logs.user_id = users.id WHERE 1=1
    `;
    let queryParams = [];
    if (user_id) { query += ` AND time_logs.user_id = ?`; queryParams.push(user_id); }
    if (date) { query += ` AND DATE(time_logs.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = ?`; queryParams.push(date); }
    query += ` ORDER BY time_logs.timestamp DESC`;

    const result = await dbQuery(query, queryParams);
    const logs = (result.rows || []).map(log => ({ ...log, timestamp: log.local_timestamp || log.timestamp }));

    let employeeName = 'Alle Mitarbeiter';
    if (user_id) {
      const userRes = await dbQuery('SELECT username FROM users WHERE id = ?', [user_id]);
      if (userRes.rows && userRes.rows.length > 0) employeeName = userRes.rows[0].username;
    }

    if (!PDFKit) return res.status(500).send('PDF-Generator Modul ist nicht geladen.');

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
    doc.text('Aktion', 185, startY, { width: 150 });
    doc.text('Notiz', 345, startY, { width: 200 });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.8);

    doc.font('Helvetica').fontSize(9);
    if (logs && logs.length > 0) {
      logs.forEach(log => {
        const logDate = new Date(log.timestamp).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        const actionText = log.type === 'IN' ? 'Eingestempelt (IN)' : 'Ausgestempelt (OUT)';
        const noteText = log.note || '-';
        if (doc.y > 750) doc.addPage();
        const rowY = doc.y;
        doc.text(logDate, 50, rowY, { width: 130, lineBreak: false });
        doc.text(actionText, 185, rowY, { width: 150, lineBreak: false });
        doc.text(noteText, 345, rowY, { width: 200 });
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

module.exports = router;
