/**
 * Proaktive Lagerbestand-Warnung
 * ─────────────────────────────────────────────────────────────────────────────
 * Bisher wurde ein niedriger Lagerbestand nur passiv im Dashboard-Widget
 * angezeigt (man musste aktiv reinschauen). Dieses Modul schickt zusätzlich
 * einmal täglich eine WhatsApp-Sammel-Nachricht ans Admin-/Chef-Team, wenn
 * Artikel unter ihren Mindestbestand gefallen sind – nach demselben Muster,
 * das für Urlaubsanträge bereits verwendet wird.
 *
 * Steuerbar über den Admin-Panel-Schalter "lager_alert_enabled"
 * (Standard: aus).
 */

const { dbQuery } = require('./db');
const { getFirma } = require('./companySettings');
const { sendWhatsApp } = require('./notifier');

function isTruthy(val) {
  return val === true || val === 'true' || val === 1 || val === '1';
}

async function checkLowStock() {
  const firma = await getFirma().catch(() => ({}));
  if (!isTruthy(firma.lager_alert_enabled)) return; // Standardmäßig deaktiviert

  try {
    const result = await dbQuery(`
      SELECT bezeichnung, profil, menge, einheit, mindestbestand
      FROM lager_items
      WHERE mindestbestand > 0 AND menge <= mindestbestand
      ORDER BY (mindestbestand - menge) DESC
      LIMIT 20
    `);
    const rows = result.rows || [];
    if (rows.length === 0) return;

    const lines = rows.map(r =>
      `• ${r.bezeichnung || r.profil || 'Artikel'}: ${r.menge} ${r.einheit || ''} (Mindestbestand: ${r.mindestbestand})`
    );
    const msg = `🏭 Lagerbestand-Warnung – ${rows.length} Artikel unter Mindestbestand:\n` + lines.join('\n');

    const adminRes = await dbQuery(
      `SELECT whatsapp_phone, whatsapp_api_key FROM users
       WHERE role IN ('ADMIN','CHEF') AND whatsapp_notify = true
         AND whatsapp_phone IS NOT NULL AND whatsapp_api_key IS NOT NULL`
    );
    for (const admin of (adminRes.rows || [])) {
      sendWhatsApp(admin.whatsapp_phone, msg, admin.whatsapp_api_key).catch(() => {});
    }
  } catch (err) {
    console.error('[Lagerbestand-Warnung] Fehler bei der Prüfung:', err.message);
  }
}

// ── Cron: täglich um 07:00 Uhr (Europe/Berlin), vor Arbeitsbeginn ───────────
function startLagerAlertCron() {
  function msUntil(hour) {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const delay = msUntil(7);
    setTimeout(async () => {
      await checkLowStock();
      setInterval(checkLowStock, 24 * 60 * 60 * 1000);
    }, delay);
  }

  schedule();
  console.log('[Lagerbestand-Warnung] Tägliche Prüfung um 07:00 Uhr eingerichtet.');
}

module.exports = { startLagerAlertCron, checkLowStock };
