const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET ist nicht gesetzt. Server wird nicht gestartet.');
  process.exit(1);
}

// ── Rollen-Hierarchie ──────────────────────────────────────────────────────
// CHEF     → alles sehen und machen (inkl. Geldsummen, Systemeinstellungen)
// ADMIN    → Verwaltung (Einstellungen, Nutzer), Geld nur wenn freigeschaltet
// EMPLOYEE → Werkstatt: eigene Zeit, Kalender, zugewiesene Aufträge, Urlaub

const ROLES = ['CHEF', 'ADMIN', 'EMPLOYEE'];

const ROLE_LABELS = {
  CHEF: 'Chef',
  ADMIN: 'Admin',
  EMPLOYEE: 'Mitarbeiter',
};

function verifyToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    res.locals.currentUser = verified;
    next();
  } catch (err) {
    res.clearCookie('token');
    return res.redirect('/login');
  }
}

function requireChef(req, res, next) {
  if (req.user && req.user.role === 'CHEF') return next();
  res.status(403).send(
    '<h1>403 – Zugriff verweigert</h1>' +
    '<p>Diese Funktion ist nur für den Chef sichtbar.</p>' +
    '<a href="/">← Zurück zum Dashboard</a>'
  );
}

/** CHEF oder ADMIN */
function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'CHEF' || req.user.role === 'ADMIN')) return next();
  res.status(403).send(
    '<h1>403 – Zugriff verweigert</h1>' +
    '<p>Nur Administratoren haben Zugriff auf diesen Bereich.</p>' +
    '<a href="/">← Zurück zum Dashboard</a>'
  );
}

function hasPerm(user, area, firma = {}, adminDef = true, employeeDef = false) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;
  if (user.role === 'ADMIN') {
    const key = `perm_admin_${area}`;
    return firma[key] !== undefined ? firma[key] !== 'false' : adminDef;
  }
  const key = `perm_employee_${area}`;
  return firma[key] !== undefined ? firma[key] !== 'false' : employeeDef;
}

function canSeeMoney(user, firma = {}) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;
  if (user.role === 'ADMIN') {
    return firma.perm_admin_money === 'true';
  }
  return false;
}

module.exports = {
  verifyToken,
  requireAdmin,
  requireChef,
  canSeeMoney,
  hasPerm,
  ROLES,
  ROLE_LABELS,
  JWT_SECRET,
};
