const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { JWT_SECRET } = require('../middleware/auth');

// Initialen Admin-User anlegen, falls noch keiner existiert
function createDefaultAdmin() {
  db.get(`SELECT id FROM users WHERE username = 'admin'`, async (err, user) => {
    if (err) {
      console.error('❌ Fehler beim Prüfen des Admin-Users:', err.message);
      return;
    }

    if (!user) {
      try {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        db.run(
          `INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'ADMIN')`,
          ['admin', hashedPassword],
          (err) => {
            if (err) console.error('❌ Fehler beim Erstellen des Admins:', err.message);
            else console.log('🔑 Standard-Admin angelegt: User: "admin" | PW: "admin123"');
          }
        );
      } catch (hashErr) {
        console.error('❌ Fehler beim Passworthashing:', hashErr.message);
      }
    }
  });
}

createDefaultAdmin();

// GET: Login-Seite anzeigen
router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// POST: Login verarbeiten
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) {
      return res.render('login', { error: 'Ungültiger Benutzername oder Passwort' });
    }

    try {
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
        maxAge: 8 * 60 * 60 * 1000 // 8 Stunden
      });

      res.redirect('/');
    } catch (error) {
      console.error('❌ Login-Fehler:', error.message);
      res.render('login', { error: 'Fehler bei der Anmeldung. Bitte erneut versuchen.' });
    }
  });
});

// GET: Logout
router.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

module.exports = router;