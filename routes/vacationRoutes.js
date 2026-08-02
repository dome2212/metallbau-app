const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { v2: cloudinary }    = require('cloudinary');
const { dbQuery }           = require('../utils/db');
const { requireAdmin }      = require('../middleware/auth');

const upload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'metallbau-management', allowed_formats: ['jpg', 'png', 'jpeg', 'pdf', 'webp'] }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// ==========================================
// URLAUBSÜBERSICHT
// ==========================================
router.get('/', async (req, res) => {
  const userId   = req.user.id;
  const userRole = req.user.role;
  try {
    let vacationsRes;
    if (userRole === 'ADMIN') {
      vacationsRes = await dbQuery(`
        SELECT vacations.*, users.username
        FROM vacations
        JOIN users ON vacations.user_id = users.id
        ORDER BY vacations.created_at DESC
      `);
    } else {
      vacationsRes = await dbQuery(`
        SELECT vacations.*, users.username
        FROM vacations
        JOIN users ON vacations.user_id = users.id
        WHERE vacations.user_id = ?
        ORDER BY vacations.created_at DESC
      `, [userId]);
    }

    const usersRes = await dbQuery(
      'SELECT id, username, role, COALESCE(vacation_allowance, 30) as vacation_allowance FROM users ORDER BY username ASC'
    );

    const currentYear    = new Date().getFullYear();
    const vacationBalances = {};
    for (const u of (usersRes.rows || [])) {
      const approvedRes = await dbQuery(
        `SELECT start_date, end_date FROM vacations WHERE user_id = ? AND type = 'Urlaub' AND status = 'Genehmigt'`,
        [u.id]
      );
      let usedDays = 0;
      for (const v of (approvedRes.rows || [])) {
        const start = new Date(v.start_date);
        const end   = new Date(v.end_date);
        if (end.getFullYear() < currentYear || start.getFullYear() > currentYear) continue;
        const s = new Date(Math.max(start, new Date(currentYear, 0, 1)));
        const e = new Date(Math.min(end,   new Date(currentYear, 11, 31)));
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
          const dow = d.getDay();
          if (dow !== 0 && dow !== 6) usedDays++;
        }
      }
      vacationBalances[u.id] = {
        allowance: u.vacation_allowance || 30,
        used:      usedDays,
        remaining: (u.vacation_allowance || 30) - usedDays
      };
    }

    res.render('vacations', {
      vacations:       vacationsRes.rows || [],
      users:           usersRes.rows || [],
      user:            req.user,
      currentUser:     req.user,
      vacationBalances,
      currentYear
    });
  } catch (err) {
    console.error('Fehler beim Laden der Urlaubsübersicht:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// URLAUBSANTRAG HINZUFÜGEN
// ==========================================
router.post('/add', upload.single('document'), async (req, res) => {
  try {
    const userId                      = req.user.id;
    const { type, start_date, end_date, reason } = req.body;
    const fileUrl                     = req.file ? req.file.path : null;

    await dbQuery(
      `INSERT INTO vacations (user_id, type, start_date, end_date, reason, file_url, status) VALUES (?, ?, ?, ?, ?, ?, 'Beantragt')`,
      [userId, type || 'Urlaub', start_date, end_date, reason || null, fileUrl]
    );
    res.redirect('/vacations');
  } catch (err) {
    console.error('Fehler beim Speichern des Urlaubsantrags:', err.message);
    res.status(500).send('Fehler beim Speichern der Abwesenheit.');
  }
});

// ==========================================
// STATUS ÄNDERN (nur Admin)
// ==========================================
router.post('/status', requireAdmin, async (req, res) => {
  const { id, status } = req.body;
  try {
    await dbQuery('UPDATE vacations SET status = ? WHERE id = ?', [status, id]);
    res.redirect('/vacations');
  } catch (err) {
    console.error('Fehler beim Aktualisieren des Urlaubsstatus:', err.message);
    res.status(500).send('Fehler beim Aktualisieren des Status');
  }
});

// ==========================================
// URLAUBSANTRAG LÖSCHEN (nur Admin)
// ==========================================
router.post('/delete', requireAdmin, async (req, res) => {
  const { id } = req.body;
  try {
    await dbQuery('DELETE FROM vacations WHERE id = ?', [id]);
    res.redirect('/vacations');
  } catch (err) {
    console.error('Fehler beim Löschen des Urlaubsantrags:', err.message);
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// JAHRESANSPRUCH SETZEN (nur Admin)
// ==========================================
router.post('/set-allowance', requireAdmin, async (req, res) => {
  const { user_id, vacation_allowance } = req.body;
  const days = parseInt(vacation_allowance || '30', 10);
  try {
    await dbQuery('UPDATE users SET vacation_allowance = ? WHERE id = ?', [days, user_id]);
  } catch (err) {
    console.error('Fehler beim Setzen des Urlaubsanspruchs:', err.message);
  }
  res.redirect('/vacations');
});

module.exports = router;
