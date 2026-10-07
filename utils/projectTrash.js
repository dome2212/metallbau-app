/**
 * utils/projectTrash.js – Papierkorb für Aufträge
 *  - hardDeleteProject(id): löscht einen Auftrag samt abhängiger Daten in EINER Transaktion
 *  - purgeOldTrash(days):   löscht Aufträge, die länger als `days` Tage im Papierkorb liegen
 *  - startTrashPurgeSchedule(): täglicher automatischer Lauf (Standard: 30 Tage, per
 *    Umgebungsvariable TRASH_RETENTION_DAYS änderbar; 0 = nie automatisch löschen)
 */
const { dbQuery, withTransaction } = require('./db');
const { logAudit } = require('./audit');

const isPg = !!process.env.DATABASE_URL;
const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.TRASH_RETENTION_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

async function hardDeleteProject(id) {
  await withTransaction(async (tx) => {
    for (const t of ['project_tasks', 'project_notes', 'project_photos', 'project_measurements',
                     'project_sketches', 'project_files', 'project_status_log', 'lager_entnahmen',
                     'staff_assignments']) {
      await tx.query(`DELETE FROM ${t} WHERE project_id = ?`, [id]);
    }
    // Stunden, Termine und Belege bleiben erhalten – nur die Verknüpfung wird gelöst
    for (const t of ['time_logs', 'appointments', 'documents']) {
      await tx.query(`UPDATE ${t} SET project_id = NULL WHERE project_id = ?`, [id]);
    }
    await tx.query('DELETE FROM projects WHERE id = ?', [id]);
  });
}

async function purgeOldTrash(days = RETENTION_DAYS) {
  if (!days || days <= 0) return 0;
  const cutoff = isPg
    ? `deleted_at < NOW() - (? * INTERVAL '1 day')`
    : `deleted_at < datetime('now', '-' || ? || ' days')`;
  const r = await dbQuery(`SELECT id, title FROM projects WHERE deleted_at IS NOT NULL AND ${cutoff}`, [days]);
  let n = 0;
  for (const p of (r.rows || [])) {
    try {
      await hardDeleteProject(p.id);
      await logAudit({ user: { username: 'System (automatisch)' } }, `nach ${days} Tagen automatisch endgültig gelöscht`, 'project', p.id, p.title);
      n++;
    } catch (e) {
      console.error(`⚠️ Papierkorb-Bereinigung: Auftrag ${p.id} nicht gelöscht (zurückgerollt):`, e.message);
    }
  }
  if (n) console.log(`🗑️ Papierkorb: ${n} Auftrag/Aufträge nach ${days} Tagen automatisch endgültig gelöscht.`);
  return n;
}

function startTrashPurgeSchedule() {
  if (!RETENTION_DAYS) { console.log('[Papierkorb] Automatische Bereinigung ist deaktiviert.'); return; }
  const run = () => purgeOldTrash().catch(e => console.error('⚠️ Papierkorb-Bereinigung fehlgeschlagen:', e.message));
  setTimeout(run, 60 * 1000).unref();                 // 1 Min. nach dem Start (Migrationen sind dann durch)
  setInterval(run, 24 * 60 * 60 * 1000).unref();      // danach täglich
  console.log(`[Papierkorb] Endgültiges Löschen nach ${RETENTION_DAYS} Tagen (täglich geprüft).`);
}

module.exports = { hardDeleteProject, purgeOldTrash, startTrashPurgeSchedule, RETENTION_DAYS };
