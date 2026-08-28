/**
 * Proaktive Lagerbestand-Warnung
 * - Täglich 07:00: Sammelwarnung (WhatsApp + Push + E-Mail an ADMIN/CHEF)
 * - Sofort bei Entnahme unter Mindestbestand (Push + optional WhatsApp)
 * Steuerbar über firma.lager_alert_enabled
 */

const { dbQuery } = require('./db');
const { getFirma } = require('./companySettings');
const { sendWhatsApp, sendEmail } = require('./notifier');
const { sendPush } = require('./webpush');

function isTruthy(val) {
  return val === true || val === 'true' || val === 1 || val === '1';
}

async function getAdminContacts() {
  const adminRes = await dbQuery(
    `SELECT id, email, whatsapp_phone, whatsapp_api_key, whatsapp_notify
     FROM users WHERE role IN ('ADMIN','CHEF')`
  );
  return adminRes.rows || [];
}

async function notifyAdmins({ title, body, url, whatsappText }) {
  const admins = await getAdminContacts();

  // Push an alle Subscriptions der Admins
  for (const a of admins) {
    if (a.id) {
      sendPush({ title, body, url: url || '/lager' }, a.id).catch(() => {});
    }
  }
  // Fallback: alle Subscriptions (falls user_id null)
  sendPush({ title, body, url: url || '/lager' }, null).catch(() => {});

  for (const a of admins) {
    if (a.whatsapp_notify && a.whatsapp_phone && a.whatsapp_api_key && whatsappText) {
      sendWhatsApp(a.whatsapp_phone, whatsappText, a.whatsapp_api_key).catch(() => {});
    }
    if (a.email && body) {
      sendEmail(
        a.email,
        title || 'Lagerbestand-Warnung',
        `<p>${String(body).replace(/\n/g, '<br>')}</p><p><a href="${url || '/lager'}">Zum Lager</a></p>`
      ).catch(() => {});
    }
  }
}

async function checkLowStock() {
  const firma = await getFirma().catch(() => ({}));
  if (!isTruthy(firma.lager_alert_enabled)) return;

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
      `• ${r.bezeichnung || r.profil || 'Artikel'}: ${r.menge} ${r.einheit || ''} (Min: ${r.mindestbestand})`
    );
    const body = `${rows.length} Artikel unter Mindestbestand:\n` + lines.join('\n');
    const msg = `🏭 Lagerbestand-Warnung – ${rows.length} Artikel unter Mindestbestand:\n` + lines.join('\n');

    await notifyAdmins({
      title: 'Lagerbestand-Warnung',
      body: body.slice(0, 180),
      url: '/lager',
      whatsappText: msg
    });
  } catch (err) {
    console.error('[Lagerbestand-Warnung] Fehler:', err.message);
  }
}

/** Sofort-Warnung nach Entnahme, wenn Artikel unter Mindestbestand fällt */
async function notifyIfLowStock(item, neuerBestand) {
  try {
    const firma = await getFirma().catch(() => ({}));
    if (!isTruthy(firma.lager_alert_enabled)) return;
    const min = Number(item.mindestbestand || 0);
    if (!(min > 0) || !(neuerBestand <= min)) return;

    const name = item.bezeichnung || item.profil || 'Artikel';
    const body = `${name}: Bestand ${neuerBestand} ${item.einheit || ''} (Mindestbestand ${min})`;
    await notifyAdmins({
      title: 'Mindestbestand erreicht',
      body,
      url: '/lager',
      whatsappText: `⚠️ Mindestbestand: ${body}`
    });
  } catch (err) {
    console.error('[Lager Sofort-Warnung]', err.message);
  }
}

function startLagerAlertCron() {
  function msUntil(hour) {
    const now = new Date();
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
  console.log('[Lagerbestand-Warnung] Tägliche Prüfung um 07:00 + Push/E-Mail aktiv.');
}

module.exports = { startLagerAlertCron, checkLowStock, notifyIfLowStock };
