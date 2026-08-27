/**
 * Automatisches Mahnwesen
 * ─────────────────────────────────────────────────────────────────────────────
 * Prüft täglich, welche Rechnungen überfällig sind (due_date in der Vergangenheit,
 * status NICHT 'Bezahlt'), und verschickt:
 *   1. Eine Erinnerungs-E-Mail an den Kunden (sofern eine E-Mail-Adresse hinterlegt ist)
 *   2. Eine WhatsApp-Benachrichtigung ans Admin-/Chef-Team (interne Info, damit
 *      niemand eine überfällige Rechnung übersieht)
 *
 * Steuerbar über den Admin-Panel-Schalter "dunning_enabled" (Standard: aus,
 * muss also bewusst aktiviert werden, damit keine ungewollten Kunden-E-Mails
 * verschickt werden).
 *
 * Pro Rechnung wird nur einmal pro Kalendertag erinnert (kein Spam bei jedem
 * Cron-Durchlauf).
 */

const { dbQuery } = require('./db');
const { getFirma } = require('./companySettings');
const { sendEmail, sendWhatsApp } = require('./notifier');

const isPg = !!process.env.DATABASE_URL;

// Merkt sich "invoiceId:YYYY-MM-DD" für bereits verschickte Erinnerungen heute
const remindedToday = new Set();

function isTruthy(val) {
  return val === true || val === 'true' || val === 1 || val === '1';
}

async function checkOverdueInvoices() {
  const firma = await getFirma().catch(() => ({}));
  if (!isTruthy(firma.dunning_enabled)) return; // Standardmäßig deaktiviert

  try {
    const sql = `
      SELECT d.id, d.doc_number, d.total_amount, d.due_date,
             c.company_name, c.contact_person, c.email
      FROM documents d
      LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.doc_type = 'INVOICE'
        AND d.status != 'Bezahlt'
        AND d.due_date IS NOT NULL
        AND d.due_date < ${isPg ? 'CURRENT_DATE' : "date('now')"}
    `;
    const result = await dbQuery(sql);
    const rows = result.rows || [];
    if (rows.length === 0) return;

    const today = new Date().toISOString().split('T')[0];
    const overdueForAdmin = [];

    for (const inv of rows) {
      const dedupeKey = `${inv.id}:${today}`;
      if (remindedToday.has(dedupeKey)) continue;

      const daysOverdue = Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000);
      const amount = Number(inv.total_amount || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 });
      const kundeName = inv.company_name || inv.contact_person || 'Kunde';

      // 1) E-Mail an den Kunden (nur wenn Kunden-Kontakt-Mail vorhanden)
      if (inv.email) {
        await sendEmail(
          inv.email,
          `Zahlungserinnerung – Rechnung ${inv.doc_number}`,
          `<p>Sehr geehrte Damen und Herren,</p>
           <p>unsere Rechnung <strong>${inv.doc_number}</strong> über <strong>${amount} €</strong>
           war am ${new Date(inv.due_date).toLocaleDateString('de-DE')} fällig und ist nach unseren
           Unterlagen noch nicht beglichen (${daysOverdue} Tag(e) überfällig).</p>
           <p>Falls die Zahlung bereits erfolgt ist, betrachten Sie dieses Schreiben bitte als
           gegenstandslos. Andernfalls bitten wir um kurzfristigen Ausgleich.</p>
           <p>Mit freundlichen Grüßen<br>${firma.name || ''}</p>`
        ).catch(() => {});
      }

      overdueForAdmin.push(`${inv.doc_number} – ${kundeName} – ${amount} € (${daysOverdue}T überfällig)`);
      remindedToday.add(dedupeKey);
    }

    // 2) Interne Sammel-Info ans Admin-/Chef-Team per WhatsApp
    if (overdueForAdmin.length > 0) {
      const adminRes = await dbQuery(
        `SELECT whatsapp_phone, whatsapp_api_key FROM users
         WHERE role IN ('ADMIN','CHEF') AND whatsapp_notify = true
           AND whatsapp_phone IS NOT NULL AND whatsapp_api_key IS NOT NULL`
      );
      const msg = `🧾 ${overdueForAdmin.length} überfällige Rechnung(en):\n` + overdueForAdmin.join('\n');
      for (const admin of (adminRes.rows || [])) {
        sendWhatsApp(admin.whatsapp_phone, msg, admin.whatsapp_api_key).catch(() => {});
      }
    }

    // Merkliste nicht unbegrenzt wachsen lassen
    if (remindedToday.size > 5000) remindedToday.clear();
  } catch (err) {
    console.error('[Mahnwesen] Fehler bei der Prüfung:', err.message);
  }
}

// ── Cron: täglich um 08:00 Uhr (Europe/Berlin) ───────────────────────────────
function startDunningCron() {
  function msUntil(hour) {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const delay = msUntil(8);
    setTimeout(async () => {
      await checkOverdueInvoices();
      setInterval(checkOverdueInvoices, 24 * 60 * 60 * 1000);
    }, delay);
  }

  schedule();
  console.log('[Mahnwesen] Tägliche Prüfung um 08:00 Uhr eingerichtet.');
}

module.exports = { startDunningCron, checkOverdueInvoices };
