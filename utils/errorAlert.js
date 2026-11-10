/**
 * Fehlerhinweis per E-Mail an den Chef
 * ─────────────────────────────────────────────────────────────────────────────
 * Meldet: Serverfehler (HTTP 500), Abstürze, fehlgeschlagene Backups.
 * Empfänger: ERROR_ALERT_EMAIL (.env) → Admin-Panel "Fehler-E-Mail" → Backup-E-Mail.
 * Schutz vor Mail-Flut: gleiche Meldung höchstens alle 30 Min., insgesamt höchstens 10 Mails pro Stunde.
 * Es werden keine Passwörter, Cookies oder Formulardaten verschickt – nur Fehlertext und Pfad.
 */
const mailer = require('./mailer');
const { getFirma } = require('./companySettings');

const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_PER_HOUR = 10;
const seen = new Map();   // Schlüssel → Zeitpunkt der letzten Mail
let sentTimes = [];

async function recipient() {
  const firma = await getFirma().catch(() => ({}));
  return (process.env.ERROR_ALERT_EMAIL || firma.error_alert_email || process.env.BACKUP_EMAIL || firma.smtp_backup_email || '').trim();
}

const oneLine = (s, n = 300) => String(s || '').split('\n')[0].slice(0, n);

/**
 * @param {string} kind  z. B. 'Serverfehler', 'Absturz', 'Backup'
 * @param {Error|string} err
 * @param {{path?:string, method?:string, user?:string, force?:boolean}} ctx
 */
async function notifyError(kind, err, ctx = {}) {
  try {
    const to = await recipient();
    if (!to) return { ok: false, reason: 'kein Empfänger' };

    const msg = oneLine(err && err.message ? err.message : err);
    const key = kind + '|' + (ctx.path || '') + '|' + msg;
    const now = Date.now();
    if (!ctx.force) {
      if (seen.has(key) && now - seen.get(key) < COOLDOWN_MS) return { ok: false, reason: 'bereits gemeldet' };
      sentTimes = sentTimes.filter((t) => now - t < 3600000);
      if (sentTimes.length >= MAX_PER_HOUR) return { ok: false, reason: 'Limit erreicht' };
    }
    seen.set(key, now);
    sentTimes.push(now);
    if (seen.size > 200) for (const k of [...seen.keys()].slice(0, 100)) seen.delete(k);

    const firma = await getFirma().catch(() => ({}));
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : '';
    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    const lines = [
      `${kind} in der Metallbau-App (${firma.nameKurz || firma.name || ''})`,
      '',
      `Zeit:     ${time}`,
      `Meldung:  ${msg}`,
      ctx.path ? `Seite:    ${ctx.method || ''} ${String(ctx.path).split('?')[0]}` : null,
      ctx.user ? `Benutzer: ${ctx.user}` : null,
      stack ? `\nTechnische Details:\n${stack}` : null,
      '',
      'Diese Nachricht wird für dieselbe Meldung höchstens alle 30 Minuten verschickt.',
    ].filter((l) => l !== null);

    return await mailer.sendMail({ to, subject: `⚠️ ${kind} – ${firma.nameKurz || 'Metallbau-App'}`, text: lines.join('\n') });
  } catch (e) {
    console.error('[Fehlerhinweis] Konnte nicht gesendet werden:', (e && e.message || '').slice(0, 120));
    return { ok: false };
  }
}

/** Express-Fehler: nur echte Serverfehler (>= 500) melden. */
function fromExpress(err, req, status) {
  if (status < 500) return;
  notifyError('Serverfehler', err, {
    path: req && (req.originalUrl || req.url), method: req && req.method,
    user: req && req.user ? `${req.user.username} (${req.user.role})` : '',
  });
}

/** Abstürze melden, dann – wie bisher – beenden (Docker startet neu). */
function installCrashHandlers() {
  let crashing = false;
  const handle = (kind) => async (err) => {
    console.error('[CRASH]', kind, err && err.stack ? err.stack : err);
    if (crashing) return;
    crashing = true;
    await Promise.race([
      notifyError('Absturz (' + kind + ') – Server startet neu', err, { force: true }),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    process.exit(1);
  };
  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}

module.exports = { notifyError, fromExpress, installCrashHandlers, recipient };
