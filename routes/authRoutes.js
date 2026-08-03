const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { JWT_SECRET, verifyToken } = require('../middleware/auth');
const { dbQuery } = require('../utils/db');

// Initialen Admin-User anlegen, falls noch keiner existiert
async function createDefaultAdmin() {
  try {
    const result = await dbQuery(`SELECT id FROM users WHERE username = 'admin'`);
    const user = result.rows[0];

    if (!user) {
      // Zufälliges, sicheres Passwort statt hartkodiertem Wert
      const tempPassword = crypto.randomBytes(9).toString('base64url'); // z.B. "kX9pQ2m..."
      const hashedPassword = await bcrypt.hash(tempPassword, 10);
      await dbQuery(
        `INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'ADMIN')`,
        ['admin', hashedPassword]
      );
      console.log('==========================================');
      console.log('🔑 Standard-Admin angelegt!');
      console.log('   User: admin');
      console.log('   PW:   ' + tempPassword);
      console.log('   ⚠️  Bitte SOFORT nach dem ersten Login ändern!');
      console.log('==========================================');
    }
  } catch (err) {
    console.error('❌ Fehler beim Prüfen/Erstellen des Admin-Users:', err.message);
  }
}

createDefaultAdmin();

// GET: Login-Seite anzeigen
router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// POST: Login verarbeiten
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await dbQuery(`SELECT * FROM users WHERE username = ?`, [username]);
    const user = result.rows[0];

    if (!user) {
      return res.render('login', { error: 'Ungültiger Benutzername oder Passwort' });
    }

    // Passwort vergleichen
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.render('login', { error: 'Ungültiger Benutzername oder Passwort' });
    }

    // JWT-Token erstellen (8 Stunden Schichtdauer)
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Token als HTTP-Only Cookie speichern
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // nur über HTTPS senden
      sameSite: 'lax',                                 // CSRF-Schutz
      maxAge: 8 * 60 * 60 * 1000 // 8 Stunden
    });

    res.redirect('/');
  } catch (error) {
    console.error('❌ Login-Fehler:', error.message);
    res.render('login', { error: 'Fehler bei der Anmeldung. Bitte erneut versuchen.' });
  }
});

// GET: Logout
router.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

// ==========================================
// PROFIL – Passwort selbst ändern
// ==========================================
router.get('/profile', verifyToken, (req, res) => {
  res.render('profile', { error: null, success: null });
});

router.post('/profile/change-password', verifyToken, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return res.render('profile', { error: 'Alle Felder sind Pflichtfelder.', success: null });
  }
  if (new_password.length < 6) {
    return res.render('profile', { error: 'Das neue Passwort muss mindestens 6 Zeichen haben.', success: null });
  }
  if (new_password !== confirm_password) {
    return res.render('profile', { error: 'Die neuen Passwörter stimmen nicht überein.', success: null });
  }

  try {
    const result = await dbQuery('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.render('profile', { error: 'Benutzer nicht gefunden.', success: null });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.render('profile', { error: 'Das aktuelle Passwort ist falsch.', success: null });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await dbQuery('UPDATE users SET password_hash = ? WHERE id = ?', [hashed, req.user.id]);

    res.render('profile', { error: null, success: 'Passwort erfolgreich geändert.' });
  } catch (err) {
    console.error('Fehler beim Passwort ändern:', err.message);
    res.render('profile', { error: 'Serverfehler. Bitte erneut versuchen.', success: null });
  }
});

module.exports = router;
