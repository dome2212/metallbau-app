/**
 * Erinnerung bei vergessenem Ausstempeln
 * ─────────────────────────────────────────────────────────────────────────────
 * Prüft regelmäßig, ob ein Mitarbeiter seit mehr als X Stunden eingestempelt
 * ist ("stamp_reminder_hours" im Admin-Panel, 0 = deaktiviert) und schickt in
 * diesem Fall eine WhatsApp-Erinnerung (CallMeBot, wie an anderer Stelle in
 * der App bereits genutzt) – vorausgesetzt, der Mitarbeiter hat WhatsApp-
 * Benachrichtigungen aktiviert und Telefonnummer + API-Key hinterlegt.
 *
 * Pro offener Stempel-Sitzung wird nur einmal erinnert (In-Memory-Merkliste –
 * bei einem Server-Neustart kann es daher im Ausnahmefall zu einer zweiten
 * Erinnerung für dieselbe Sitzung kommen; unkritisch für diesen Zweck).
 */

const { dbQuery } = require('./db');
const { getFirma } = require('./companySettings');
const { sendWhatsApp } = require('./notifier');

const isPg = !!process.env.DATABASE_URL;

// Merkt sich, für welche (offenen) IN-Buchungen bereits erinnert wurde.
const remindedLogIds = new Set();

function isTruthy(val) {
  return val === true || val === 'true' || val === 1 || val === '1';
}

async function checkForgottenStamps() {
  const firma = await getFirma().catch(() => ({}));
  const hours = parseFloat(firma.stamp_reminder_hours || '0');
  if (!hours || hours <= 0) return; // 0 = deaktiviert

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

    const result = await dbQuery(sql);
    const rows = result.rows || [];
    const now  = Date.now();

    for (const row of rows) {
      if (row.type !== 'IN') continue;                       // schon ausgestempelt -> nichts zu tun
      if (!isTruthy(row.whatsapp_notify)) continue;           // Mitarbeiter möchte keine WhatsApp-Erinnerungen
      if (!row.whatsapp_phone || !row.whatsapp_api_key) continue;

      const startedAt = new Date(String(row.timestamp).replace(' ', 'T')).getTime();
      if (!startedAt) continue;
      const elapsedHours = (now - startedAt) / 3600000;
      if (elapsedHours < hours) continue;

      const reminderKey = 'inlog-' + row.id;
      if (remindedLogIds.has(reminderKey)) continue;

      const msg = `⏰ Hallo ${row.username}, du bist seit ca. ${elapsedHours.toFixed(1)} Std. eingestempelt. ` +
                  `Falls du das Ausstempeln vergessen hast, bitte in der App nachtragen.`;
      await sendWhatsApp(row.whatsapp_phone, msg, row.whatsapp_api_key);
      remindedLogIds.add(reminderKey);
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
