const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  sqlite = require("sqlite3"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
delete process.env.DATABASE_URL;
delete process.env.BACKUP_EMAIL;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
test("backup reports skipped/failed/success honestly, preserves last success and snapshots committed WAL content", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-")),
    db = new sqlite.Database(path.join(folder, "source.sqlite"));
  const run = (sql) =>
    new Promise((resolve, reject) =>
      db.exec(sql, (e) => (e ? reject(e) : resolve())),
    );
  let firma = {},
    mails = 0,
    failMail = false;
  require.cache[require.resolve("../config/database")] = { exports: db };
  require.cache[require.resolve("../utils/companySettings")] = {
    exports: {
      getFirma: async () => firma,
      setFirmaValue: async (k, v) => {
        firma = { ...firma, [k]: v };
      },
    },
  };
  require.cache[require.resolve("nodemailer")] = {
    exports: {
      createTransport: () => ({
        sendMail: async (mail) => {
          mails++;
          assert.ok(fs.statSync(mail.attachments[0].path).size > 0);
          if (failMail) throw Error("synthetic SMTP failure");
        },
      }),
    },
  };
  const backup = require("../utils/backup"),
    status = require("../utils/backupStatus");
  try {
    await run(
      "PRAGMA journal_mode=WAL;CREATE TABLE sample(value TEXT);INSERT INTO sample VALUES('committed in WAL');",
    );
    assert.ok(fs.statSync(path.join(folder, "source.sqlite-wal")).size > 0);
    assert.deepEqual(await backup.runBackup(), { ok: false, skipped: true });
    assert.equal(status.summary(firma).mail_result, "skipped");
    assert.equal(mails, 0);
    const file = await backup.createBackupFile();
    const copy = new sqlite.Database(file.path, sqlite.OPEN_READONLY);
    const rows = await new Promise((resolve, reject) =>
      copy.all("SELECT value FROM sample", (e, r) =>
        e ? reject(e) : resolve(r),
      ),
    );
    assert.equal(rows[0].value, "committed in WAL");
    await new Promise((r) => copy.close(r));
    assert.ok(status.summary(firma).file_success_at);
    await backup.cleanupBackup(file.path);
    assert.ok(!fs.existsSync(path.dirname(file.path)));
    firma = {
      ...firma,
      smtp_backup_email: "test@example.invalid",
      smtp_user: "test@example.invalid",
      smtp_pass: "synthetic-only",
    };
    const together = await Promise.all([
      backup.runBackup(),
      backup.runBackup(),
    ]);
    assert.ok(together.every((r) => r.ok));
    assert.equal(mails, 1);
    const success = status.summary(firma).mail_success_at;
    assert.ok(success);
    assert.equal(status.summary(firma).warning, false);
    failMail = true;
    assert.equal((await backup.runBackup()).failed, true);
    assert.equal(status.summary(firma).mail_success_at, success);
    assert.equal(status.summary(firma).mail_result, "failed");
    assert.equal(status.summary(firma).warning, true);
    assert.equal(
      status.summary({
        ...firma,
        backup_status: JSON.stringify({
          mail_success_at: "2020-01-01",
          mail_result: "success",
        }),
      }).warning,
      true,
    );
    const original = db.backup;
    db.backup = () => {
      throw Error("synthetic copy failure");
    };
    await assert.rejects(backup.createBackupFile(), /Sicherungsdatei/);
    db.backup = original;
    assert.equal(status.summary(firma).file_result, "failed");
  } finally {
    await new Promise((r) => db.close(r));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
