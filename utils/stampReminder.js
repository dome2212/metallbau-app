/**
 * Erinnerung bei vergessenem Ausstempeln
 * ─────────────────────────────────────────────────────────────────────────────
 * Erinnert Mitarbeiter, die noch eingestempelt sind:
 *  - nach X Stunden am Stück ("stamp_reminder_hours", 0 = aus) und/oder
 *  - zur Feierabend-Uhrzeit ("stamp_reminder_time", z.B. 18:30, leer = aus).
 * Kanal: Push aufs Handy (wenn aktiviert) plus WhatsApp (CallMeBot), falls im
 * Mitarbeiter-Profil eingerichtet.
 *
 * Pro offener Stempel-Sitzung wird nur einmal erinnert (In-Memory-Merkliste –
 * bei einem Server-Neustart kann es daher im Ausnahmefall zu einer zweiten
 * Erinnerung für dieselbe Sitzung kommen; unkritisch für diesen Zweck).
 */

const { dbQuery } = require('./db');
const { getFirma } = require('./companySettings');
const { sendWhatsApp } = require('./notifier');
const { sendPush } = require('./webpush');

const isPg = !!process.env.DATABASE_URL;

// Merkt sich, für welche (offenen) IN-Buchungen bereits erinnert wurde.
const remindedLogIds = new Set();

function isTruthy(val) {
  return val === true || val === 'true' || val === 1 || val === '1';
}

// SQLite liefert UTC-Text ("YYYY-MM-DD HH:MM:SS"), PostgreSQL ein Date.
function toMs(ts) {
  if (ts instanceof Date) return ts.getTime();
  const str = String(ts);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str.slice(10)) ? str.replace(' ', 'T') : str.replace(' ', 'T') + 'Z').getTime();
}

// Uhrzeit/Datum in Berlin: { date: 'YYYY-MM-DD', minutes: Minuten seit Mitternacht }
function berlinParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function parseTime(str) {                       // "18:30" -> 1110, sonst null
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

async function checkForgottenStamps() {
  const firma = await getFirma().catch(() => ({}));
  const hours = parseFloat(firma.stamp_reminder_hours || '0') || 0;     // 0 = aus
  const eveningMin = parseTime(firma.stamp_reminder_time);              // leer = aus
  if (hours <= 0 && eveningMin == null) return;

  try {
    // Letzter Zeiterfassungs-Eintrag pro Mitarbeiter
    const sql = isPg
      ? `SELECT DISTINCT ON (tl.user_id) tl.id, tl.user_id, tl.type, tl.timestamp,
                u.username, u.whatsapp_phone, u.whatsapp_api_key, u.whatsapp_notify
         FROM time_logs tl
         JOIN users u ON u.id = tl.user_id
         ORDER BY tl.user_id, tl.timestamp DESC`
      : `SELECT tl.id, tl.user_id, tl.type, tl.timestamp,
                u.username, u.whatsapp_phone, u.whatsapp_api_key, u.whatsapp_notify
         FROM time_logs tl
         JOIN users u ON u.id = tl.user_id
         WHERE tl.id IN (SELECT MAX(id) FROM time_logs GROUP BY user_id)`;

    const rows = (await dbQuery(sql)).rows || [];
    const now  = Date.now();
    const nowB = berlinParts(now);

    for (const row of rows) {
      if (row.type !== 'IN') continue;                       // schon ausgestempelt -> nichts zu tun

      const startedAt = toMs(row.timestamp);
      if (!startedAt || Number.isNaN(startedAt)) continue;
      const elapsedHours = (now - startedAt) / 3600000;
      const startB = berlinParts(startedAt);

      // Auslöser 1: X Stunden am Stück eingestempelt
      const tooLong = hours > 0 && elapsedHours >= hours;
      // Auslöser 2: Feierabend-Uhrzeit erreicht, Schicht begann vorher (heute oder an einem früheren Tag)
      const evening = eveningMin != null
        && (startB.date < nowB.date || (startB.date === nowB.date && startB.minutes < eveningMin && nowB.minutes >= eveningMin));
      if (!tooLong && !evening) continue;

      const reminderKey = 'inlog-' + row.id;
      if (remindedLogIds.has(reminderKey)) continue;
      remindedLogIds.add(reminderKey);

      const dur = elapsedHours.toFixed(1).replace('.', ',');
      const msg = `⏰ Hallo ${row.username}, du bist seit ca. ${dur} Std. eingestempelt. ` +
                  `Falls du das Ausstempeln vergessen hast, bitte in der App nachtragen.`;

      // Push-Benachrichtigung aufs Handy (wenn Benachrichtigungen aktiviert sind)
      sendPush({ title: '⏰ Noch eingestempelt?', body: `Du bist seit ${dur} Std. eingestempelt. Ausstempeln vergessen?`, url: '/timetracking' }, row.user_id)
        .catch(e => console.error('[Stempel-Erinnerung] Push:', e.message));

      // WhatsApp zusätzlich, falls eingerichtet
      if (isTruthy(row.whatsapp_notify) && row.whatsapp_phone && row.whatsapp_api_key) {
        await sendWhatsApp(row.whatsapp_phone, msg, row.whatsapp_api_key)
          .catch(e => console.error('[Stempel-Erinnerung] WhatsApp:', e.message));
      }
    }

    // Merkliste nicht unbegrenzt wachsen lassen
    if (remindedLogIds.size > 5000) remindedLogIds.clear();
  } catch (err) {
    console.error('[Stempel-Erinnerung] Fehler bei der Prüfung:', err.message);
  }
}

// ── Alle 30 Minuten prüfen ───────────────────────────────────────────────────
function startStampReminderCron() {
  setTimeout(checkForgottenStamps, 60 * 1000); // kurz nach Serverstart einmal prüfen
  setInterval(checkForgottenStamps, 30 * 60 * 1000);
  console.log('[Stempel-Erinnerung] Prüfung aktiv (alle 30 Minuten).');
}

module.exports = { startStampReminderCron, checkForgottenStamps };
