const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'geheimes_metallbau_passwort_123';

// Prünft, ob der Nutzer eingeloggt ist
function verifyToken(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified; // Enthält id, username, role
    res.locals.currentUser = verified; // Für EJS-Views verfügbar machen
    next();
  } catch (err) {
    res.clearCookie('token');
    return res.redirect('/login');
  }
}

// Prüft, ob der Nutzer Admin-Rechte besitzt
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'ADMIN') {
    next();
  } else {
    res.status(403).send('<h1>403 - Zugriff verweigert</h1><p>Nur Administratoren haben Zugriff auf diesen Bereich.</p><a href="/">Zurück zum Dashboard</a>');
  }
}

module.exports = { verifyToken, requireAdmin, JWT_SECRET };