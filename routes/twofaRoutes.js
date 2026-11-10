/**
 * Zwei-Faktor-Anmeldung einrichten / ausschalten (Profil) – nur Büro-Rollen.
 * Eingebunden unter /profile/2fa (nach verifyToken).
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const twofa   = require('../utils/twofa');
const { toSvg } = require('../utils/qrcode');
const { dbQuery } = require('../utils/db');

router.use((req, res, next) => {
  if (!twofa.OFFICE_ROLES.includes(req.user.role)) {
    return res.status(403).send('<h1>403</h1><p>Die Zwei-Faktor-Anmeldung gilt nur für Büro, Admin und Chef.</p><a href="/">← Zurück</a>');
  }
  next();
});

async function page(req, res, extra = {}) {
  const u = await twofa.getState(req.user.id);
  const enabled = twofa.isEnabled(u);
  let secret = null, qr = null;
  if (!enabled) {
    secret = await twofa.pendingSecret(req.user.id);
    if (secret) {
      const issuer = (res.locals.firma && res.locals.firma.nameKurz) || 'Metallbau';
      qr = toSvg(twofa.otpauthUri(secret, req.user.username, issuer), { size: 220 });
    }
  }
  let codesLeft = 0;
  try { codesLeft = JSON.parse((u && u.totp_recovery) || '[]').length; } catch (_) {}
  res.render('twofa', {
    currentUser: req.user, enabled, secret, qr, codesLeft,
    required: (res.locals.firma || {}).require_2fa === 'true',
    error: null, success: null, recoveryCodes: null,
    notice: req.query.recovery_left != null
      ? `Du hast dich mit einem Wiederherstellungscode angemeldet. Es sind noch ${parseInt(req.query.recovery_left, 10) || 0} Codes übrig – bitte bald neue erzeugen.`
      : (req.query.required ? 'Der Chef verlangt die Zwei-Faktor-Anmeldung. Bitte zuerst einrichten.' : null),
    ...extra,
  });
}

router.get('/', async (req, res, next) => { try { await page(req, res); } catch (e) { next(e); } });

// Schritt 1: neues Geheimnis erzeugen (QR-Code anzeigen)
router.post('/start', async (req, res, next) => {
  try {
    const u = await twofa.getState(req.user.id);
    if (!twofa.isEnabled(u)) await twofa.startSetup(req.user.id);
    res.redirect('/profile/2fa');
  } catch (e) { next(e); }
});

// Schritt 2: Code aus der App bestätigen → aktiv + Wiederherstellungscodes (nur jetzt sichtbar)
router.post('/confirm', async (req, res, next) => {
  try {
    const codes = await twofa.enable(req.user.id, req.body.code);
    if (!codes) return page(req, res, { error: 'Der Code stimmt nicht. Bitte den aktuellen 6-stelligen Code aus der App eingeben.' });
    res.render('twofa', {
      currentUser: req.user, enabled: true, secret: null, qr: null, codesLeft: codes.length,
      required: false, error: null, notice: null,
      success: 'Zwei-Faktor-Anmeldung ist jetzt aktiv.', recoveryCodes: codes,
    });
  } catch (e) { next(e); }
});

// Neue Wiederherstellungscodes (die alten werden ungültig): Passwort + aktueller Code
router.post('/codes', async (req, res, next) => {
  try {
    const r = await dbQuery('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const okPw = r.rows[0] && await bcrypt.compare(String(req.body.password || ''), r.rows[0].password_hash);
    if (!okPw) return page(req, res, { error: 'Das Passwort ist falsch.' });
    const chk = await twofa.verifyLogin(req.user.id, req.body.code);
    if (!chk.ok) return page(req, res, { error: chk.locked ? `Zu viele Fehlversuche. Bitte in ${chk.locked} Minuten erneut versuchen.` : 'Der Code ist falsch.' });
    const codes = await twofa.regenerateCodes(req.user.id);
    res.render('twofa', {
      currentUser: req.user, enabled: true, secret: null, qr: null, codesLeft: codes.length,
      required: (res.locals.firma || {}).require_2fa === 'true', error: null, notice: null,
      success: 'Neue Wiederherstellungscodes erzeugt. Die alten sind ungültig.', recoveryCodes: codes,
    });
  } catch (e) { next(e); }
});

// Ausschalten: Passwort + aktueller Code
router.post('/disable', async (req, res, next) => {
  try {
    if ((res.locals.firma || {}).require_2fa === 'true') {
      return page(req, res, { error: 'Die Zwei-Faktor-Anmeldung ist vom Chef vorgeschrieben und kann nicht ausgeschaltet werden.' });
    }
    const r = await dbQuery('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const okPw = r.rows[0] && await bcrypt.compare(String(req.body.password || ''), r.rows[0].password_hash);
    if (!okPw) return page(req, res, { error: 'Das Passwort ist falsch.' });
    const chk = await twofa.verifyLogin(req.user.id, req.body.code);
    if (!chk.ok) return page(req, res, { error: chk.locked ? `Zu viele Fehlversuche. Bitte in ${chk.locked} Minuten erneut versuchen.` : 'Der Code ist falsch.' });
    await twofa.disable(req.user.id);
    page(req, res, { success: 'Zwei-Faktor-Anmeldung wurde ausgeschaltet.' });
  } catch (e) { next(e); }
});

module.exports = router;
