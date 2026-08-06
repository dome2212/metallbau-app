const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'geheimes_metallbau_passwort_123';

// ── Rollen-Hierarchie ──────────────────────────────────────────────────────
// CHEF     → alles sehen und machen (inkl. Geldsummen)
// ADMIN    → alles außer Geldsummen (ehem. Manager / Admin-Assistent)
// EMPLOYEE → nur eigene Zeiterfassung, Kalender, Aufträge, Urlaub

/** Prüft, ob der Nutzer eingeloggt ist */
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

/** Nur CHEF darf diese Route aufrufen */
function requireChef(req, res, next) {
  if (req.user && req.user.role === 'CHEF') return next();
  res.status(403).send(
    '<h1>403 – Zugriff verweigert</h1>' +
    '<p>Diese Funktion ist nur für den Chef sichtbar.</p>' +
    '<a href="/">← Zurück zum Dashboard</a>'
  );
}

/** CHEF oder ADMIN dürfen diese Route aufrufen (kein EMPLOYEE) */
function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'CHEF' || req.user.role === 'ADMIN')) return next();
  res.status(403).send(
    '<h1>403 – Zugriff verweigert</h1>' +
    '<p>Nur Administratoren haben Zugriff auf diesen Bereich.</p>' +
    '<a href="/">← Zurück zum Dashboard</a>'
  );
}

/**
 * Prüft ob ein User Zugriff auf einen konfigurierbaren Bereich hat.
 * @param {object} user  - req.user (hat .role)
 * @param {string} area  - z.B. 'projects', 'documents', 'money'
 * @param {object} firma - Einstellungen aus DB (getFirma())
 * @param {boolean} adminDef   - Default für ADMIN wenn kein DB-Eintrag
 * @param {boolean} employeeDef - Default für EMPLOYEE wenn kein DB-Eintrag
 */
function hasPerm(user, area, firma, adminDef = true, employeeDef = false) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;
  const role = user.role === 'ADMIN' ? 'admin' : 'employee';
  const key  = `perm_${role}_${area}`;
  const def  = user.role === 'ADMIN' ? adminDef : employeeDef;
  return firma[key] !== undefined ? firma[key] !== 'false' : def;
}

/** Hilfsfunktion für Views: Darf der eingeloggte User Geldbeträge sehen?
 *  CHEF immer; ADMIN nur wenn perm_admin_money nicht explizit auf false gesetzt. */
function canSeeMoney(user, firma = {}) {
  if (!user) return false;
  if (user.role === 'CHEF') return true;
  if (user.role === 'ADMIN') {
    return firma.perm_admin_money === 'true';
  }
  return false;
}

module.exports = { verifyToken, requireAdmin, requireChef, canSeeMoney, hasPerm, JWT_SECRET };
