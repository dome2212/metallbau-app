/**
 * Automatisches Datenbank-Backup
 * ─────────────────────────────────────────────────────────────────────────────
 * Läuft täglich um Mitternacht (Europe/Berlin).
 * PostgreSQL: pg_dump als .sql-Datei → per E-Mail als Anhang
 * SQLite:     .sqlite-Datei direkt → per E-Mail als Anhang
 *
 * Benötigte Umgebungsvariablen:
 *   BACKUP_EMAIL   – Ziel-Adresse (z.B. chef@meine-firma.de)
 *   SMTP_HOST      – z.B. smtp.gmail.com
 *   SMTP_PORT      – z.B. 587
 *   SMTP_USER      – Absender-E-Mail
 *   SMTP_PASS      – Passwort / App-Passwort
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const runFile = promisify(execFile);
const os = require("os");
const status = require("./backupStatus");
const fs = require("fs");
const path = require("path");
const { getFirma } = require("./companySettings");
const mailer = require("./mailer");

const isPg = !!process.env.DATABASE_URL;

// Lokale Sicherungen auf dem Server (unabhängig vom E-Mail-Versand).
// Damit sie einen Neustart/Neubau des Containers überleben, muss der Ordner als
// Volume eingebunden sein, z.B. in docker-compose.yml:  ./data/backups:/srv/app/app/data/backups
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "data", "backups");
const KEEP_LOCAL = parseInt(process.env.BACKUP_KEEP || "14", 10);

async function saveLocalCopy(file) {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  await fs.promises.copyFile(file.path, path.join(BACKUP_DIR, file.name));
  await fs.promises.chmod(path.join(BACKUP_DIR, file.name), 0o600).catch(() => {});
  const all = (await fs.promises.readdir(BACKUP_DIR))
    .filter((n) => /^backup_.*\.(sqlite|sql)$/.test(n))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_LOCAL)))
    await fs.promises.rm(path.join(BACKUP_DIR, old), { force: true });
  return all.length;
}

// ── Backup erstellen & versenden ─────────────────────────────────────────────
let activeBackup;
async function runBackup() {
  if (activeBackup) return activeBackup;
  activeBackup = sendBackup().finally(() => {
    activeBackup = null;
  });
  return activeBackup;
}
async function sendBackup() {
  const firma = await getFirma();
  const to = (process.env.BACKUP_EMAIL || firma.smtp_backup_email || "").trim();
  const attempt = new Date().toISOString();
  await status.record({ mail_attempt_at: attempt, mail_result: "running", mail_reason: "" });
  let file;
  try {
    file = await createBackupFile(false);
  } catch (error) {
    await status.record({ mail_result: "failed", file_result: "failed", mail_reason: "Sicherungsdatei konnte nicht erstellt werden." });
    console.error("[Backup] Sicherungsdatei konnte nicht erstellt werden.");
    return { ok: false, failed: true, reason: "Sicherungsdatei konnte nicht erstellt werden." };
  }
  try {
    // 1) Lokale Kopie auf dem Server – klappt auch ohne E-Mail
    try {
      await saveLocalCopy(file);
      await status.record({ local_success_at: new Date().toISOString(), file_success_at: new Date().toISOString(), file_result: "success" });
    } catch (e) {
      console.error("[Backup] Lokale Kopie nicht möglich:", e.code || e.message);
    }

    // 2) Per E-Mail versenden
    const cfg = await mailer.getConfig();
    const missing = mailer.missingParts(cfg);
    if (!to) missing.unshift("Backup-E-Mail (Empfänger)");
    if (missing.length) {
      const reason = "Nicht eingerichtet – es fehlt: " + missing.join(", ") + ".";
      await status.record({ mail_result: "skipped", mail_reason: reason });
      return { ok: false, skipped: true, reason };
    }
    const result = await mailer.sendMail({
      to,
      subject: "Datenbank-Backup – " + (firma.name || "Metallbau"),
      text: "Datenbanksicherung vom " + new Date(attempt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) + ". Den Anhang bitte sicher aufbewahren.",
      attachments: [{ filename: file.name, path: file.path }],
    });
    if (!result.ok) {
      await status.record({ mail_result: "failed", mail_reason: result.error });
      return { ok: false, failed: true, reason: result.error };
    }
    await status.record({ mail_result: "success", mail_success_at: new Date().toISOString(), mail_reason: "" });
    return { ok: true };
  } catch (error) {
    // Status bewusst allgemein: Datenbank-/Tool-Fehler können Verbindungsdaten enthalten.
    await status.record({ mail_result: "failed", mail_reason: "Unerwarteter Fehler beim Backup." });
    console.error("[Backup] Sicherung oder Versand fehlgeschlagen.", error && error.code ? error.code : "");
    return { ok: false, failed: true, reason: "Unerwarteter Fehler beim Backup." };
  } finally {
    if (file) await cleanupBackup(file.path);
  }
}
async function cleanupBackup(filePath) {
  if (path.basename(path.dirname(filePath)).startsWith("metallbau-backup-"))
    await fs.promises.rm(path.dirname(filePath), {
      recursive: true,
      force: true,
    });
}

// ── Cron-Job: täglich um 00:00 Europe/Berlin ─────────────────────────────────
function startBackupCron() {
  function msUntilMidnight() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // nächste Mitternacht (lokal, Prozess läuft auf Europe/Berlin)
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const delay = msUntilMidnight();
    const hh = Math.floor(delay / 3600000);
    const mm = Math.floor((delay % 3600000) / 60000);
    console.log(`[Backup] Nächstes Backup in ${hh}h ${mm}min`);

    setTimeout(async () => {
      const execute = () =>
        runBackup().catch(() =>
          console.error("[Backup] Status konnte nicht gespeichert werden."),
        );
      await execute();
      // Recalculate midnight after each run, including daylight-saving transitions.
      schedule();
    }, delay);
  }

  schedule();
}

// ── Backup-Datei erzeugen (ohne E-Mail) – für Download im Admin ──────────────
async function createBackupFile(track = true) {
  const folder = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "metallbau-backup-"),
  );
  const name =
    "backup_" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    (isPg ? ".sql" : ".sqlite");
  const target = path.join(folder, name);
  try {
    if (isPg) {
      await runFile(
        "pg_dump",
        [
          "--dbname",
          process.env.DATABASE_URL,
          "--no-password",
          "-F",
          "p",
          "-f",
          target,
        ],
        { timeout: 120000, maxBuffer: 1024 * 1024 },
      );
    } else {
      // sqlite3_backup includes committed WAL pages; copying the database file alone does not.
      const db = require("../config/database");
      await new Promise((resolve, reject) => {
        const backup = db.backup(target, (error) => {
          if (error) return reject(error);
          backup.step(-1, (error) =>
            backup.finish((finishError) =>
              error || finishError ? reject(error || finishError) : resolve(),
            ),
          );
        });
      });
    }
    const stat = await fs.promises.stat(target);
    if (!stat.size) throw new Error("Leere Sicherung.");
    await fs.promises.chmod(target, 0o600);
    if (track)
      await status.record({
        file_success_at: new Date().toISOString(),
        file_result: "success",
      });
    return { path: target, name };
  } catch (error) {
    await cleanupBackup(target);
    if (track) await status.record({ file_result: "failed" });
    throw new Error(
      "Die Sicherungsdatei konnte nicht erstellt werden. Bitte Datenbank und Backupwerkzeuge prüfen.",
    );
  }
}

// ── Backup wiederherstellen (Datei-Upload) ───────────────────────────────────
// SQLite: ersetzt database.sqlite
// PostgreSQL: führt .sql per psql aus (DATABASE_URL muss gesetzt sein)
async function restoreBackupFile(uploadedPath, originalName) {
  const lower = (originalName || "").toLowerCase();
  if (isPg) {
    if (!lower.endsWith(".sql")) {
      throw new Error(
        "Für PostgreSQL bitte eine .sql-Datei (pg_dump) hochladen.",
      );
    }
    await runFile(
      "psql",
      [
        "--dbname",
        process.env.DATABASE_URL,
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        uploadedPath,
      ],
      { timeout: 120000, maxBuffer: 50 * 1024 * 1024 },
    );
    return { type: "postgres", message: "PostgreSQL-Backup eingespielt." };
  }

  if (
    !lower.endsWith(".sqlite") &&
    !lower.endsWith(".db") &&
    !lower.endsWith(".sqlite3")
  ) {
    throw new Error("Für SQLite bitte eine .sqlite-Datei hochladen.");
  }
  // Nur echte SQLite-Dateien einspielen (Kopfzeile prüfen), sonst würde die Datenbank zerstört.
  const head = Buffer.alloc(16);
  const fd = fs.openSync(uploadedPath, "r");
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString("latin1") !== "SQLite format 3\u0000")
    throw new Error("Die Datei ist keine gültige SQLite-Datenbank.");
  const dbPath = path.join(__dirname, "..", "database.sqlite");
  const bakPath = path.join(
    __dirname,
    "..",
    `database.sqlite.bak-${Date.now()}`,
  );
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, bakPath);
  }
  fs.copyFileSync(uploadedPath, dbPath);
  for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(dbPath + ext, { force: true }); } catch (_) {} }
  return {
    type: "sqlite",
    message: "SQLite-Backup wiederhergestellt. Die App startet neu.",
    restart: true,
    backupOfOld: bakPath,
  };
}

module.exports = {
  startBackupCron,
  runBackup,
  createBackupFile,
  cleanupBackup,
  restoreBackupFile,
};
