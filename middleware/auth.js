const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET ist nicht gesetzt. Server wird nicht gestartet.');
  process.exit(1);
}

// ── Rollen-Hierarchie ──────────────────────────────────────────────────────
// CHEF        → alles sehen und machen (inkl. Geldsummen, Systemeinstellungen)
// ADMIN       → Verwaltung / Werkstatt-Leitung (Einstellungen, Nutzer), Geld nur wenn freigeschaltet
// SECRETARY   → Büro / Sekretärin: Kunden, Belege, Kalender, Aufträge (Büro); kein System-Admin
// EMPLOYEE    → Werkstatt: eigene Zeit, Kalender, zugewiesene Aufträge, Urlaub

const ROLES = ['CHEF', 'ADMIN', 'SECRETARY', 'EMPLOYEE'];

const ROLE_LABELS = {
  CHEF: 'Chef',
  ADMIN: 'Admin',
  SECRETARY: 'Sekretärin',
  EMPLOYEE: 'Mitarbeiter',
};

/** Standard-Rechte für Sekretärin (wenn kein DB-Eintrag) */
const SECRETARY_DEFAULTS = {
  projects: true,
  calendar: true,
  timetracking: false,   // keine Werkstatt-Stempel-Übersicht nötig
  vacations: true,       // Abwesenheiten eintragen/sehen
  customers: true,
  documents: true,       // Angebote & Rechnungen
  articles: true,
  map: true,
  treppe: false,
  steel_calc: false,
  lager: true,
  money: true,           // Beträge auf Belegen sichtbar
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

/** CHEF oder ADMIN – Systemverwaltung (kein SECRETARY, kein EMPLOYEE) */
function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'CHEF' || req.user.role === 'ADMIN')) return next();
  res.status(403).send(
    '<h1>403 – Zugriff verweigert</h1>' +
    '<p>Nur Administratoren haben Zugriff auf diesen Bereich.</p>' +
    '<a href="/">← Zurück zum Dashboard</a>'
  );
}

/** CHEF, ADMIN oder SECRETARY – Büro-Funktionen */
function requireOffice(req, res, next) {
  if (req.user && ['CHEF', 'ADMIN', 'SECRETARY'].includes(req.user.role)) return next();
  res.status(403).send(
    '<h1>403 – Zugriff verweigert</h1>' +
    '<p>Dieser Bereich ist dem Büro vorbehalten.</p>' +
    '<a href="/">← Zurück zum Dashboard</a>'
  );
}

function isOfficeRole(user) {
  return user && ['CHEF', 'ADMIN', 'SECRETARY'].includes(user.role);
}

function isManagementRole(user) {
  return user && (user.role === 'CHEF' || user.role === 'ADMIN');
}

/**
 * Prüft Zugriff auf konfigurierbaren Bereich.
 * @param {object} user
 * @param {string} area  z.B. 'projects', 'documents', 'money'
 * @param {object} firma
 * @param {boolean} adminDef
 * @param {boolean} employeeDef
 */
function hasPerm(user, area, firma = {}, adminDef = true, employeeDef = false) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;

  if (user.role === 'SECRETARY') {
    const key = `perm_secretary_${area}`;
    const def = SECRETARY_DEFAULTS[area] !== undefined ? SECRETARY_DEFAULTS[area] : adminDef;
    return firma[key] !== undefined ? firma[key] !== 'false' : def;
  }

  if (user.role === 'ADMIN') {
    const key = `perm_admin_${area}`;
    return firma[key] !== undefined ? firma[key] !== 'false' : adminDef;
  }

  // EMPLOYEE
  const key = `perm_employee_${area}`;
  return firma[key] !== undefined ? firma[key] !== 'false' : employeeDef;
}

function canSeeMoney(user, firma = {}) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;
  if (user.role === 'SECRETARY') {
    return firma.perm_secretary_money !== undefined
      ? firma.perm_secretary_money !== 'false'
      : true;
  }
  if (user.role === 'ADMIN') {
    return firma.perm_admin_money === 'true';
  }
  return false;
}

module.exports = {
  verifyToken,
  requireAdmin,
  requireChef,
  requireOffice,
  canSeeMoney,
  hasPerm,
  isOfficeRole,
  isManagementRole,
  ROLES,
  ROLE_LABELS,
  SECRETARY_DEFAULTS,
  JWT_SECRET,
};
