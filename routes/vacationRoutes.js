const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { v2: cloudinary } = require('cloudinary');
const dbQuery = require('../utils/dbQuery');

const upload = multer({ storage: new CloudinaryStorage({ cloudinary, params: { folder: 'metallbau-management', allowed_formats: ['jpg', 'png', 'jpeg', 'pdf', 'webp'] } }) });

router.get('/', async (req, res) => {
  const vacationsRes = req.user.role === 'ADMIN'
    ? await dbQuery(`SELECT vacations.*, users.username FROM vacations JOIN users ON vacations.user_id = users.id ORDER BY vacations.created_at DESC`)
    : await dbQuery(`SELECT * FROM vacations WHERE user_id = ? ORDER BY created_at DESC`, [req.user.id]);
  const usersRes = await dbQuery('SELECT id, username, role FROM users ORDER BY username ASC');
  res.render('vacations', { vacations: vacationsRes.rows, users: usersRes.rows, user: req.user, currentUser: req.user });
});

router.post('/add', upload.single('document'), async (req, res) => {
  const userId = req.user.id;
  const { type, start_date, end_date, reason } = req.body;
  await dbQuery(`INSERT INTO vacations (user_id, type, start_date, end_date, reason, file_url, status) VALUES (?, ?, ?, ?, ?, ?, 'Beantragt')`,
    [userId, type || 'Urlaub', start_date, end_date, reason || null, req.file ? req.file.path : null]);
  res.redirect('/vacations');
});

router.post('/status', requireAdmin, async (req, res) => {
  await dbQuery('UPDATE vacations SET status = ? WHERE id = ?', [req.body.status, req.body.id]);
  res.redirect('/vacations');
});

router.post('/delete', requireAdmin, async (req, res) => {
  await dbQuery('DELETE FROM vacations WHERE id = ?', [req.body.id]);
  res.redirect('/vacations');
});

module.exports = router;
