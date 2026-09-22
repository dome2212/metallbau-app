// Setzt das Passwort des bestehenden CHEF-Accounts in der lokalen
// database.sqlite neu, ohne irgendwelche anderen Daten zu verändern.
//
// Aufruf im Projektordner (wo auch server.js liegt):
//   node reset-chef-password.js
//
// Optional eigenes Passwort vergeben statt eines zufälligen:
//   node reset-chef-password.js MeinNeuesPasswort123

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Konnte database.sqlite nicht öffnen:', err.message);
    process.exit(1);
  }
});

const newPassword = process.argv[2] || crypto.randomBytes(9).toString('base64url');
const hashed = bcrypt.hashSync(newPassword, 10);

db.get(`SELECT id, username FROM users WHERE role = 'CHEF' LIMIT 1`, (err, row) => {
  if (err) {
    console.error('❌ Fehler beim Suchen des Chef-Accounts:', err.message);
    process.exit(1);
  }
  if (!row) {
    console.error('⚠️  Kein CHEF-Account gefunden. Beim nächsten "npm start" wird automatisch einer angelegt.');
    process.exit(0);
  }
  db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashed, row.id], (updErr) => {
    if (updErr) {
      console.error('❌ Fehler beim Aktualisieren:', updErr.message);
      process.exit(1);
    }
    console.log('==========================================');
    console.log('✅ Passwort zurückgesetzt!');
    console.log('   User: ' + row.username);
    console.log('   PW:   ' + newPassword);
    console.log('   ⚠️  Bitte nach dem Login sofort in deinem Profil ändern!');
    console.log('==========================================');
    db.close();
  });
});
