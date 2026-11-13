const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET ist nicht gesetzt. Server wird nicht gestartet.');
  process.exit(1);
}

// ── Rollen-Hierarchie ──────────────────────────────────────────────────────
// CHEF     → alles sehen und machen (inkl. Geldsummen, Systemeinstellungen)
// ADMIN    → Verwaltung (Einstellungen, Nutzer), Geld nur wenn freigeschaltet
// BUERO    → Sekretariat: Angebote, Rechnungen, Kunden, Aufträge, Zeiten, Urlaub, Kalender.
//            Geld sichtbar (abschaltbar), aber KEINE Nutzerverwaltung, Firmendaten, Admin-Panel, Backup.
// EMPLOYEE → Werkstatt: eigene Zeit, Kalender, zugewiesene Aufträge, Urlaub

const ROLES = ['CHEF', 'ADMIN', 'BUERO', 'EMPLOYEE'];

const ROLE_LABELS = {
  CHEF: 'Chef',
  ADMIN: 'Admin',
  BUERO: 'Büro',
  EMPLOYEE: 'Mitarbeiter',
};

/** Rollen mit Büro-/Verwaltungszugriff (operativ): CHEF, ADMIN, BUERO */
const OFFICE_ROLES = ['CHEF', 'ADMIN', 'BUERO'];

/** Standardwerte der Rolle BÜRO je Bereich (im Admin-Panel → Zugriff änderbar). */
const BUERO_DEFAULTS = {
  projects: true, calendar: true, timetracking: true, vacations: true,
  tasks: true, chat: true, farben: true, customers: true, documents: true,
  articles: true, map: true, lager: true, reports: true, money: true,
  stamp_edit: true, cad: false, schnittliste: false,
};

function isOffice(user) {
  return !!user && OFFICE_ROLES.includes(user.role);
}

function verifyToken(req, res, next) {
  const token = req.cookies.token;
  // Bei GET merken wir uns die Ziel-Seite (z.B. gescannter Stempel-QR-Code),
  // damit man nach dem Login direkt dort landet.
  const loginUrl = (req.method === 'GET' && req.originalUrl && req.originalUrl !== '/' && !req.originalUrl.startsWith('/login'))
    ? '/login?next=' + encodeURIComponent(req.originalUrl)
    : '/login';
  if (!token) return res.redirect(loginUrl);
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    res.locals.currentUser = verified;
    next();
  } catch (err) {
    res.clearCookie('token');
    return res.redirect(loginUrl);
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

/** CHEF, ADMIN oder BÜRO – für operative Verwaltung (Belege, Aufträge, Zeiten, Urlaub …) */
function requireOffice(req, res, next) {
  if (isOffice(req.user)) return next();
  res.status(403).send(
    '<h1>403 – Zugriff verweigert</h1>' +
    '<p>Nur das Büro und die Verwaltung haben Zugriff auf diesen Bereich.</p>' +
    '<a href="/">← Zurück zum Dashboard</a>'
  );
}

function hasPerm(user, area, firma = {}, adminDef = true, employeeDef = false) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;
  if (user.role === 'BUERO') {
    const key = `perm_buero_${area}`;
    const def = BUERO_DEFAULTS[area] !== undefined ? BUERO_DEFAULTS[area] : adminDef;
    return firma[key] !== undefined ? firma[key] !== 'false' : def;
  }
  if (user.role === 'ADMIN') {
    const key = `perm_admin_${area}`;
    return firma[key] !== undefined ? firma[key] !== 'false' : adminDef;
  }
  const key = `perm_employee_${area}`;
  return firma[key] !== undefined ? firma[key] !== 'false' : employeeDef;
}

/**
 * Einheitlicher Zugriffs-Guard über die Berechtigungs-Matrix (Admin-Panel → Zugriff).
 * CHEF darf immer. ADMIN/EMPLOYEE: gespeicherter Matrix-Wert, sonst Standardwert.
 *   router.use(requirePerm('lager', true, false));
 *   router.get('/', requirePerm('reports'), handler);   // Standard: ADMIN ja, EMPLOYEE nein
 */
function requirePerm(area, adminDef = true, employeeDef = false, label = null) {
  return async function (req, res, next) {
    try {
      const { getFirma } = require('../utils/companySettings'); // lazy: vermeidet Zirkelbezug
      const firma = await getFirma();
      if (hasPerm(req.user, area, firma, adminDef, employeeDef)) return next();
      const wantsJson = (req.get('Accept') || '').includes('application/json')
        || (req.get('Content-Type') || '').includes('application/json')
        || req.xhr;
      if (wantsJson) {
        return res.status(403).json({ error: label ? ('Kein Zugriff auf ' + label) : 'Zugriff verweigert' });
      }
      return res.status(403).send(
        '<h1>403 – Zugriff verweigert</h1>' +
        (label ? `<p>Kein Zugriff auf ${label}.</p>` : '') +
        '<a href="/">← Zurück zum Dashboard</a>'
      );
    } catch (e) {
      next(e);
    }
  };
}

function canSeeMoney(user, firma = {}) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;
  if (user.role === 'ADMIN') {
    return firma.perm_admin_money === 'true';
  }
  if (user.role === 'BUERO') {
    return firma.perm_buero_money !== 'false';
  }
  return false;
}

module.exports = {
  verifyToken,
  requireAdmin,
  requireChef,
  requireOffice,
  isOffice,
  OFFICE_ROLES,
  BUERO_DEFAULTS,
  canSeeMoney,
  hasPerm,
  requirePerm,
  ROLES,
  ROLE_LABELS,
  JWT_SECRET,
};
