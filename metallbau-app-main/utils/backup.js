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

const nodemailer = require('nodemailer');
const { exec }   = require('child_process');
const fs         = require('fs');
const path       = require('path');
const { getFirma } = require('./companySettings');

const isPg = !!process.env.DATABASE_URL;

// ── Transporter ──────────────────────────────────────────────────────────────
async function getTransporter() {
  const firma = await getFirma().catch(() => ({}));
  const host  = process.env.SMTP_HOST || firma.smtp_host || 'smtp.gmail.com';
  const port  = parseInt(process.env.SMTP_PORT || firma.smtp_port || '587', 10);
  const user  = process.env.SMTP_USER || firma.smtp_user || '';
  const pass  = process.env.SMTP_PASS || firma.smtp_pass || '';
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

// ── Backup erstellen & versenden ─────────────────────────────────────────────
async function runBackup() {
  const firma = await getFirma().catch(() => ({}));
  const to    = process.env.BACKUP_EMAIL || firma.smtp_backup_email || '';
  if (!to) {
    console.log('[Backup] BACKUP_EMAIL nicht gesetzt – Backup übersprungen.');
    return;
  }
  const smtpUser = process.env.SMTP_USER || firma.smtp_user || '';
  const smtpPass = process.env.SMTP_PASS || firma.smtp_pass || '';
  if (!smtpUser || !smtpPass) {
    console.log('[Backup] SMTP nicht konfiguriert – Backup übersprungen.');
    return;
  }

  const firmaInfo = firma.name ? firma : await getFirma().catch(() => ({ name: 'Metallbau' }));
  const dateStr  = new Date().toLocaleDateString('de-DE').replace(/\./g, '-');
  const timeStr  = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }).replace(':', '-');
  const filename = `backup_${dateStr}_${timeStr}`;

  try {
    let attachmentPath, attachmentName;

    if (isPg) {
      // ── PostgreSQL: pg_dump ───────────────────────────────────────────────
      attachmentPath = path.join('/tmp', `${filename}.sql`);
      attachmentName = `${filename}.sql`;

      await new Promise((resolve, reject) => {
        // DATABASE_URL enthält alle Verbindungsdaten
        const cmd = `pg_dump "${process.env.DATABASE_URL}" --no-password -F p -f "${attachmentPath}"`;
        exec(cmd, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve();
        });
      });
    } else {
      // ── SQLite: Datei direkt anhängen ─────────────────────────────────────
      const dbPath   = path.join(__dirname, '..', 'database.sqlite');
      attachmentPath = path.join('/tmp', `${filename}.sqlite`);
      attachmentName = `${filename}.sqlite`;
      fs.copyFileSync(dbPath, attachmentPath);
    }

    // ── E-Mail versenden ─────────────────────────────────────────────────────
    const transporter = await getTransporter();
    const fileSize    = (fs.statSync(attachmentPath).size / 1024).toFixed(1);

    await transporter.sendMail({
      from:    `"${firmaInfo.name} Backup" <${smtpUser}>`,
      to,
      subject: `🗄️ Datenbank-Backup ${dateStr} – ${firmaInfo.nameKurz || firmaInfo.name}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;color:#1f2328">
          <h2 style="color:#3b82d4">🗄️ Automatisches Datenbank-Backup</h2>
          <p>Das tägliche Backup der App-Datenbank wurde erfolgreich erstellt.</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">
            <tr style="background:#f7f8fa">
              <td style="padding:8px 12px;font-weight:600;border:1px solid #e5e7eb">Firma</td>
              <td style="padding:8px 12px;border:1px solid #e5e7eb">${firmaInfo.name}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;font-weight:600;border:1px solid #e5e7eb">Datum</td>
              <td style="padding:8px 12px;border:1px solid #e5e7eb">${dateStr}</td>
            </tr>
            <tr style="background:#f7f8fa">
              <td style="padding:8px 12px;font-weight:600;border:1px solid #e5e7eb">Datei</td>
              <td style="padding:8px 12px;border:1px solid #e5e7eb">${attachmentName}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;font-weight:600;border:1px solid #e5e7eb">Größe</td>
              <td style="padding:8px 12px;border:1px solid #e5e7eb">${fileSize} KB</td>
            </tr>
            <tr style="background:#f7f8fa">
              <td style="padding:8px 12px;font-weight:600;border:1px solid #e5e7eb">Typ</td>
              <td style="padding:8px 12px;border:1px solid #e5e7eb">${isPg ? 'PostgreSQL (pg_dump)' : 'SQLite'}</td>
            </tr>
          </table>
          <p style="color:#57606a;font-size:13px">
            Diese E-Mail wurde automatisch generiert. Bitte Anhang sicher aufbewahren.
          </p>
        </div>`,
      attachments: [{ filename: attachmentName, path: attachmentPath }],
    });

    console.log(`[Backup] ✅ Backup erfolgreich an ${to} gesendet (${fileSize} KB)`);

    // Temp-Datei aufräumen
    fs.unlink(attachmentPath, () => {});

  } catch (err) {
    console.error('[Backup] ❌ Fehler beim Backup:', err.message);
    // Fehler-E-Mail an Admin schicken
    try {
      const transporter = await getTransporter();
      await transporter.sendMail({
        from:    `"${firmaInfo.name} Backup" <${smtpUser}>`,
        to,
        subject: `❌ Backup FEHLGESCHLAGEN ${dateStr} – ${firmaInfo.nameKurz || firmaInfo.name}`,
        text:    `Das automatische Backup ist fehlgeschlagen:\n\n${err.message}`,
      });
    } catch (_) {}
  }
}

// ── Cron-Job: täglich um 00:00 Europe/Berlin ─────────────────────────────────
function startBackupCron() {
  function msUntilMidnight() {
    const now     = new Date();
    const next    = new Date(now);
    next.setHours(24, 0, 0, 0); // nächste Mitternacht (lokal, Prozess läuft auf Europe/Berlin)
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const delay = msUntilMidnight();
    const hh    = Math.floor(delay / 3600000);
    const mm    = Math.floor((delay % 3600000) / 60000);
    console.log(`[Backup] Nächstes Backup in ${hh}h ${mm}min`);

    setTimeout(async () => {
      await runBackup();
      // Danach täglich wiederholen
      setInterval(runBackup, 24 * 60 * 60 * 1000);
    }, delay);
  }

  schedule();
}

module.exports = { startBackupCron, runBackup };
