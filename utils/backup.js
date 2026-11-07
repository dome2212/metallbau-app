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

const nodemailer = require("nodemailer");
const { execFile } = require("child_process");
const { promisify } = require("util");
const runFile = promisify(execFile);
const os = require("os");
const status = require("./backupStatus");
const fs = require("fs");
const path = require("path");
const { getFirma } = require("./companySettings");

const isPg = !!process.env.DATABASE_URL;

// ── Transporter ──────────────────────────────────────────────────────────────
async function getTransporter() {
  const firma = await getFirma().catch(() => ({}));
  const host = process.env.SMTP_HOST || firma.smtp_host || "smtp.gmail.com";
  const port = parseInt(process.env.SMTP_PORT || firma.smtp_port || "587", 10);
  const user = process.env.SMTP_USER || firma.smtp_user || "";
  const pass = process.env.SMTP_PASS || firma.smtp_pass || "";
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
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
  const to = process.env.BACKUP_EMAIL || firma.smtp_backup_email || "";
  const smtpUser = process.env.SMTP_USER || firma.smtp_user || "";
  const smtpPass = process.env.SMTP_PASS || firma.smtp_pass || "";
  const attempt = new Date().toISOString();
  await status.record({ mail_attempt_at: attempt, mail_result: "running" });
  if (!to || !smtpUser || !smtpPass) {
    await status.record({ mail_result: "skipped" });
    return { ok: false, skipped: true };
  }
  let file;
  try {
    file = await createBackupFile(false);
    const transporter = await getTransporter();
    await transporter.sendMail({
      from: smtpUser,
      to,
      subject: "Datenbank-Backup – " + (firma.name || "Metallbau"),
      text:
        "Datenbanksicherung vom " +
        attempt +
        ". Den Anhang bitte sicher aufbewahren.",
      attachments: [{ filename: file.name, path: file.path }],
    });
    await status.record({
      mail_result: "success",
      mail_success_at: new Date().toISOString(),
    });
    return { ok: true };
  } catch (error) {
    // Status is intentionally generic: database/tool errors may contain connection details.
    await status.record({ mail_result: "failed" });
    console.error("[Backup] Sicherung oder Versand fehlgeschlagen.");
    return { ok: false, failed: true };
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
  return {
    type: "sqlite",
    message: "SQLite-Backup wiederhergestellt. Server ggf. neu starten.",
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
