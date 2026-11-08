/**
 * Gemeinsamer E-Mail-Versand (Backup, Rechnungen, Mahnungen, Lagerwarnung …)
 * ─────────────────────────────────────────────────────────────────────────────
 * Zugangsdaten: .env (SMTP_HOST/PORT/USER/PASS/SECURE/FROM) hat Vorrang,
 * sonst die Einstellungen aus dem Admin-Panel (System → E-Mail / SMTP).
 * Bei bekannten Anbietern (web.de, GMX, Gmail, T-Online, Outlook, iCloud …) wird
 * der SMTP-Server automatisch aus der Absender-Adresse abgeleitet.
 */
const nodemailer = require('nodemailer');
const { getFirma } = require('./companySettings');
const { reveal } = require('./secretBox');

const PROVIDERS = {
  'web.de':          { host: 'smtp.web.de',               port: 587 },
  'gmx.de':          { host: 'mail.gmx.net',              port: 587 },
  'gmx.net':         { host: 'mail.gmx.net',              port: 587 },
  'gmx.at':          { host: 'mail.gmx.net',              port: 587 },
  'gmail.com':       { host: 'smtp.gmail.com',            port: 587 },
  'googlemail.com':  { host: 'smtp.gmail.com',            port: 587 },
  't-online.de':     { host: 'securesmtp.t-online.de',    port: 587 },
  'outlook.com':     { host: 'smtp-mail.outlook.com',     port: 587 },
  'outlook.de':      { host: 'smtp-mail.outlook.com',     port: 587 },
  'hotmail.com':     { host: 'smtp-mail.outlook.com',     port: 587 },
  'hotmail.de':      { host: 'smtp-mail.outlook.com',     port: 587 },
  'live.de':         { host: 'smtp-mail.outlook.com',     port: 587 },
  'icloud.com':      { host: 'smtp.mail.me.com',          port: 587 },
  'me.com':          { host: 'smtp.mail.me.com',          port: 587 },
  'yahoo.com':       { host: 'smtp.mail.yahoo.com',       port: 465 },
  'yahoo.de':        { host: 'smtp.mail.yahoo.com',       port: 465 },
  'freenet.de':      { host: 'mx.freenet.de',             port: 587 },
};

async function getConfig() {
  const firma = await getFirma().catch(() => ({}));
  return configSync(firma);
}

function configSync(firma) {
  firma = firma || {};
  const user = (process.env.SMTP_USER || firma.smtp_user || '').trim();
  const pass = process.env.SMTP_PASS || reveal(firma.smtp_pass) || '';
  const domain = user.includes('@') ? user.split('@')[1].toLowerCase() : '';
  const provider = PROVIDERS[domain] || null;
  const host = (process.env.SMTP_HOST || firma.smtp_host || (provider && provider.host) || '').trim();
  const port = parseInt(process.env.SMTP_PORT || firma.smtp_port || (provider && provider.port) || '587', 10);
  const secure = process.env.SMTP_SECURE !== undefined ? String(process.env.SMTP_SECURE) !== 'false' : port === 465;
  const from = (process.env.SMTP_FROM || (user.includes('@') ? user : '')).trim();
  const fromName = firma.name || 'Metallbau';
  return { host, port, secure, user, pass, from, fromName, firma };
}

/** Liste der fehlenden Angaben (leer = alles da). */
function missingParts(cfg) {
  const m = [];
  if (!cfg.host) m.push('SMTP-Server');
  if (!cfg.user) m.push('SMTP-Benutzername');
  if (!cfg.pass) m.push('SMTP-Passwort');
  return m;
}

function transporterFrom(cfg) {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    requireTLS: !cfg.secure && cfg.port === 587,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
  });
}

/** Verständliche deutsche Fehlerbeschreibung (ohne Zugangsdaten). */
function describeError(err) {
  const code = err && err.code, rc = err && err.responseCode;
  if (code === 'EAUTH' || rc === 535 || rc === 534)
    return 'Anmeldung beim Mailserver abgelehnt. Benutzername/Passwort prüfen. Bei web.de, GMX und Gmail muss im Postfach der SMTP-Zugriff erlaubt bzw. ein App-Passwort angelegt werden.';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT')
    return 'Zeitüberschreitung: Der Mailserver antwortet nicht. Host und Port prüfen (oft 587 oder 465) oder ob der Hoster den Mailport sperrt.';
  if (['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EDNS', 'ESOCKET'].includes(code))
    return 'Mailserver nicht erreichbar. SMTP-Host und Port prüfen (z.B. smtp.web.de, Port 587).';
  if (code === 'EENVELOPE') return 'Empfänger- oder Absenderadresse wurde abgelehnt.';
  if (rc === 552 || rc === 552) return 'Der Anhang ist für den Mailserver zu groß.';
  if (rc === 553 || rc === 550) return 'Der Mailserver hat die Absenderadresse abgelehnt (Absender muss zum SMTP-Konto passen).';
  return 'E-Mail-Versand fehlgeschlagen' + (code ? ' (' + code + ')' : '') + '.';
}

/**
 * E-Mail senden.
 * @returns {{ok:boolean, error?:string, missing?:string[]}}
 */
async function sendMail({ to, subject, text, html, attachments }) {
  const cfg = await getConfig();
  const missing = missingParts(cfg);
  if (!to) return { ok: false, error: 'Keine Empfänger-Adresse.' };
  if (missing.length) return { ok: false, missing, error: 'E-Mail nicht eingerichtet – es fehlt: ' + missing.join(', ') + '.' };
  try {
    await transporterFrom(cfg).sendMail({
      from: cfg.from ? `"${cfg.fromName.replace(/"/g, '')}" <${cfg.from}>` : cfg.user,
      to, subject, text, html, attachments,
    });
    return { ok: true };
  } catch (err) {
    console.error('[Mail] Versand fehlgeschlagen:', err.code || '', err.responseCode || '', (err.message || '').split('\n')[0].slice(0, 200));
    return { ok: false, error: describeError(err), code: err.code };
  }
}

module.exports = { getConfig, configSync, missingParts, sendMail, describeError, PROVIDERS };
