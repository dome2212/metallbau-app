const { getFirma, setFirmaValue } = require("./companySettings");
let pending = Promise.resolve();
function parse(firma) {
  try {
    const data = JSON.parse(firma.backup_status || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}
function record(patch) {
  const task = pending.then(async () => {
    const previous = parse(await getFirma());
    await setFirmaValue(
      "backup_status",
      JSON.stringify({ ...previous, ...patch }),
    );
  });
  pending = task.catch(() => {});
  return task;
}
function summary(firma, now = Date.now()) {
  const state = parse(firma),
    configured = Boolean(
      (process.env.BACKUP_EMAIL || firma.smtp_backup_email) &&
        (process.env.SMTP_USER || firma.smtp_user) &&
        (process.env.SMTP_PASS || firma.smtp_pass),
    );
  const stale =
    !state.mail_success_at ||
    !Number.isFinite(Date.parse(state.mail_success_at)) ||
    now - Date.parse(state.mail_success_at) > 36 * 3600000;
  const running = state.mail_result === "running";
  const interrupted =
    running &&
    (!state.mail_attempt_at ||
      now - Date.parse(state.mail_attempt_at) > 3600000);
  const warning =
    !configured ||
    stale ||
    interrupted ||
    ["failed", "skipped"].includes(state.mail_result);
  const message = !configured
    ? "Automatisches E-Mail-Backup ist nicht vollständig eingerichtet."
    : interrupted
      ? "Der letzte Backupversuch wurde nicht abgeschlossen."
      : state.mail_result === "failed"
        ? "Der letzte E-Mail-Backupversuch ist fehlgeschlagen."
        : state.mail_result === "skipped"
          ? "Der letzte Backupversuch wurde übersprungen."
          : stale
            ? "Keine erfolgreiche E-Mail-Sicherung in den letzten 36 Stunden bestätigt."
            : running
              ? "Backup wird gerade erstellt."
              : "Automatisches Backup zuletzt erfolgreich versandt.";
  return { ...state, configured, warning, message };
}
module.exports = { record, summary };
