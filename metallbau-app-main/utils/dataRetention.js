/**
 * Automatische Datenaufbewahrung / Löschfrist
 * ─────────────────────────────────────────────────────────────────────────────
 * Löscht Zeiterfassungs-Einträge (time_logs, inkl. GPS-Standort), die älter
 * sind als die im Admin-Panel eingestellte Aufbewahrungsfrist
 * ("data_retention_years", Standard: 10 Jahre, 0 = deaktiviert).
 *
 * Läuft einmal täglich, kurz nach dem automatischen Backup (01:00 Uhr),
 * damit im Zweifel noch eine Backup-Kopie der Daten existiert, bevor sie
 * aus der Live-Datenbank entfernt werden.
 *
 * WICHTIG: Betrifft bewusst NUR time_logs (personenbezogene Zeiterfassung /
 * Standortdaten der Mitarbeiter). Rechnungen, Angebote und Kundendaten sind
 * i.d.R. aus steuerlichen Gründen (GoBD) aufbewahrungspflichtig und werden
 * hier NICHT angefasst.
 */

const { dbQuery } = require('./db');
const { getFirma } = require('./companySettings');

const isPg = !!process.env.DATABASE_URL;

async function purgeOldTimeLogs() {
  const firma = await getFirma().catch(() => ({}));
  const years = parseInt(firma.data_retention_years || '10', 10);
  if (!years || years <= 0) {
    console.log('[Datenaufbewahrung] Automatische Löschung deaktiviert (0 Jahre eingestellt).');
    return;
  }

  try {
    const sql = isPg
      ? `DELETE FROM time_logs WHERE timestamp < NOW() - INTERVAL '${years} years'`
      : `DELETE FROM time_logs WHERE timestamp < datetime('now', '-${years} years')`;
    const result = await dbQuery(sql);
    const count = (result && (result.rowCount ?? result.changes)) || 0;
    if (count > 0) {
      console.log(`[Datenaufbewahrung] ${count} Zeiterfassungs-Einträge älter als ${years} Jahre gelöscht.`);
    } else {
      console.log(`[Datenaufbewahrung] Keine Einträge älter als ${years} Jahre gefunden.`);
    }
  } catch (err) {
    console.error('[Datenaufbewahrung] Fehler beim Löschen alter Einträge:', err.message);
  }
}

// ── Cron-Job: täglich um 01:00 Uhr (Europe/Berlin) ───────────────────────────
function startRetentionCron() {
  function msUntil(hour) {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const delay = msUntil(1); // 01:00 Uhr, eine Stunde nach dem Backup
    const hh = Math.floor(delay / 3600000);
    const mm = Math.floor((delay % 3600000) / 60000);
    console.log(`[Datenaufbewahrung] Nächste Prüfung in ${hh}h ${mm}min`);

    setTimeout(async () => {
      await purgeOldTimeLogs();
      setInterval(purgeOldTimeLogs, 24 * 60 * 60 * 1000);
    }, delay);
  }

  schedule();
}

module.exports = { startRetentionCron, purgeOldTimeLogs };
