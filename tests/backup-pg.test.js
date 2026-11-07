const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  crypto = require("crypto"),
  { Pool } = require("pg");
const socket = process.env.PR25_PG_SOCKET;
test(
  "PostgreSQL backup produces a nonempty pg_dump file and removes its private temporary directory",
  { skip: !socket },
  async () => {
    const options = {
        host: socket,
        port: Number(process.env.PR25_PG_PORT || 55432),
        database: "postgres",
        user: "postgres",
      },
      admin = new Pool(options),
      name = "backup_test_" + crypto.randomBytes(5).toString("hex");
    await admin.query('CREATE DATABASE "' + name + '"');
    const pool = new Pool({ ...options, database: name });
    let file;
    try {
      await pool.query(
        "CREATE TABLE sample(value TEXT);INSERT INTO sample VALUES('synthetic backup fixture')",
      );
      const uri = new URL("postgresql://postgres@localhost/" + name);
      uri.searchParams.set("host", socket);
      uri.searchParams.set("port", String(options.port));
      process.env.DATABASE_URL = uri.toString();
      let settings = {};
      require.cache[require.resolve("../utils/companySettings")] = {
        exports: {
          getFirma: async () => settings,
          setFirmaValue: async (k, v) => {
            settings[k] = v;
          },
        },
      };
      const backup = require("../utils/backup");
      file = await backup.createBackupFile();
      const text = fs.readFileSync(file.path, "utf8");
      assert.match(text, /COPY public.sample/);
      assert.match(text, /synthetic backup fixture/);
      assert.match(file.name, /\.sql$/);
      assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
      await backup.cleanupBackup(file.path);
      assert.equal(fs.existsSync(file.path), false);
      assert.ok(JSON.parse(settings.backup_status).file_success_at);
    } finally {
      if (file)
        fs.rmSync(require("path").dirname(file.path), {
          recursive: true,
          force: true,
        });
      await pool.end();
      await admin.query('DROP DATABASE "' + name + '"');
      await admin.end();
    }
  },
);
