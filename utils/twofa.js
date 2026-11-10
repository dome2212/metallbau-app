/**
 * Zwei-Faktor-Anmeldung (TOTP, kompatibel mit Google/Microsoft Authenticator, Aegis, 2FAS …)
 * ─────────────────────────────────────────────────────────────────────────────
 * Nur für Büro-Rollen (CHEF, ADMIN, BUERO). Keine zusätzliche Bibliothek nötig (RFC 6238 mit crypto).
 * Das Geheimnis wird verschlüsselt gespeichert (utils/secretBox). Wiederherstellungscodes nur als Hash.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { dbQuery } = require('./db');
const { encrypt, reveal } = require('./secretBox');

const OFFICE_ROLES = ['CHEF', 'ADMIN', 'BUERO'];
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(str) {
  let bits = 0, value = 0; const out = [];
  for (const c of String(str).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function newSecret() { return base32(crypto.randomBytes(20)); }

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1000000).padStart(6, '0');
}
/** Liefert den passenden Zeitschritt oder null (Toleranz ±1 Schritt = ±30 s). */
function matchStep(secret, token, now = Date.now()) {
  const t = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const cur = Math.floor(now / 1000 / STEP);
  for (const d of [0, -1, 1]) {
    const a = Buffer.from(hotp(secret, cur + d)), b = Buffer.from(t);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return cur + d;
  }
  return null;
}
function otpauthUri(secret, account, issuer) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

// ── Wiederherstellungscodes ───────────────────────────────────────────────────
function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const r = crypto.randomBytes(5).toString('hex').toUpperCase();   // 10 Zeichen
    return r.slice(0, 5) + '-' + r.slice(5);
  });
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── Zugriff auf die Datenbank ─────────────────────────────────────────────────
async function getState(userId) {
  const r = await dbQuery('SELECT id, username, role, totp_secret, totp_enabled, totp_last_step, totp_recovery FROM users WHERE id = ?', [userId]);
  return r.rows[0] || null;
}
const isEnabled = (u) => !!u && Number(u.totp_enabled) === 1 && !!u.totp_secret;
const needsTwoFactor = (u) => !!u && OFFICE_ROLES.includes(u.role) && isEnabled(u);

async function startSetup(userId) {
  const secret = newSecret();
  await dbQuery('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = NULL, totp_recovery = NULL WHERE id = ?', [encrypt(secret), userId]);
  return secret;
}
async function pendingSecret(userId) {
  const u = await getState(userId);
  return u && u.totp_secret && !isEnabled(u) ? reveal(u.totp_secret) : null;
}
async function enable(userId, token) {
  const secret = await pendingSecret(userId);
  if (!secret) return null;
  const step = matchStep(secret, token);
  if (step === null) return null;
  const codes = newRecoveryCodes();
  const hashed = await Promise.all(codes.map((c) => bcrypt.hash(normCode(c), 8)));
  await dbQuery('UPDATE users SET totp_enabled = 1, totp_last_step = ?, totp_recovery = ? WHERE id = ?', [step, JSON.stringify(hashed), userId]);
  return codes;
}
async function regenerateCodes(userId) {
  const codes = newRecoveryCodes();
  const hashed = await Promise.all(codes.map((c) => bcrypt.hash(normCode(c), 8)));
  await dbQuery('UPDATE users SET totp_recovery = ? WHERE id = ?', [JSON.stringify(hashed), userId]);
  return codes;
}
async function disable(userId) {
  await dbQuery('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL, totp_recovery = NULL WHERE id = ?', [userId]);
}

// Fehlversuche je Benutzer (Schutz vor Durchprobieren der 6 Ziffern)
const fails = new Map();
function lockedFor(userId) {
  const f = fails.get(userId);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
function noteFail(userId) {
  const f = fails.get(userId) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
  fails.set(userId, f);
}

/**
 * Prüft Authenticator-Code ODER Wiederherstellungscode.
 * @returns {{ok:boolean, locked?:number, recovery?:boolean, left?:number}}
 */
async function verifyLogin(userId, input) {
  const wait = lockedFor(userId);
  if (wait) return { ok: false, locked: wait };
  const u = await getState(userId);
  if (!isEnabled(u)) return { ok: true };
  const secret = reveal(u.totp_secret);
  const step = matchStep(secret, input);
  if (step !== null) {
    if (u.totp_last_step != null && step <= Number(u.totp_last_step)) { noteFail(userId); return { ok: false }; } // Code schon benutzt
    await dbQuery('UPDATE users SET totp_last_step = ? WHERE id = ?', [step, userId]);
    fails.delete(userId);
    return { ok: true };
  }
  const code = normCode(input);
  if (code.length === 10) {
    let list = [];
    try { list = JSON.parse(u.totp_recovery || '[]'); } catch (_) {}
    for (let i = 0; i < list.length; i++) {
      if (await bcrypt.compare(code, list[i])) {
        list.splice(i, 1);
        await dbQuery('UPDATE users SET totp_recovery = ? WHERE id = ?', [JSON.stringify(list), userId]);
        fails.delete(userId);
        return { ok: true, recovery: true, left: list.length };
      }
    }
  }
  noteFail(userId);
  return { ok: false };
}

/** Pflicht-Einrichtung: leitet Büro-Nutzer ohne 2FA auf die Einrichtungsseite, wenn der Chef 2FA verlangt. */
function requireSetupMiddleware() {
  return async function (req, res, next) {
    try {
      if (!req.user || !OFFICE_ROLES.includes(req.user.role)) return next();
      const p = req.path;
      if (p.startsWith('/profile/2fa') || p === '/logout' || p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/img/')) return next();
      const firma = res.locals.firma || {};
      if (firma.require_2fa !== 'true') return next();
      const u = await getState(req.user.id);
      if (isEnabled(u)) return next();
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/profile/2fa?required=1');
      return res.status(403).json({ error: 'Zwei-Faktor-Anmeldung muss zuerst eingerichtet werden.' });
    } catch (e) { next(e); }
  };
}

module.exports = {
  OFFICE_ROLES, newSecret, matchStep, otpauthUri, getState, isEnabled, needsTwoFactor,
  startSetup, pendingSecret, enable, disable, regenerateCodes, verifyLogin, lockedFor, requireSetupMiddleware,
  _test: { base32, unbase32, hotp },
};
