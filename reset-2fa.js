// Schaltet die Zwei-Faktor-Anmeldung eines Kontos aus (Notfall: Handy UND Wiederherstellungscodes weg).
// Nur für SQLite. Beispiel (im Projektordner bzw. im App-Container):
//   node reset-2fa.js administrator
//   docker compose exec app node reset-2fa.js administrator
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const name = process.argv[2];
if (!name) { console.error('Benutzername angeben: node reset-2fa.js <benutzername>'); process.exit(1); }

const candidates = [path.join(__dirname, 'database.sqlite'), path.join(__dirname, 'data', 'database.sqlite')];
const file = candidates.find((f) => fs.existsSync(f));
if (!file) { console.error('❌ database.sqlite nicht gefunden.'); process.exit(1); }

const db = new sqlite3.Database(file);
db.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL, totp_recovery = NULL WHERE username = ?', [name], function (e) {
  if (e) { console.error('❌', e.message); process.exit(1); }
  console.log(this.changes ? `✅ 2FA für "${name}" ausgeschaltet.` : `⚠️ Benutzer "${name}" nicht gefunden.`);
  db.close();
});
