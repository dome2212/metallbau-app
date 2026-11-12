const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// Läuft mit dem in Node eingebauten SQLite (Node >= 22.5). Auf älteren Versionen wird der Test übersprungen.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { /* älteres Node */ }
const skip = DatabaseSync ? false : 'node:sqlite nicht verfügbar (Node >= 22.5 nötig)';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT NOT NULL, title TEXT NOT NULL,
      body TEXT, url TEXT, created_ms BIGINT NOT NULL, read_ms BIGINT
    );
    INSERT INTO users (id, username) VALUES (1,'chef'),(2,'anna'),(3,'ben');
  `);
  const dbQuery = async (sql, params = []) => {
    const st = db.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: st.all(...params), lastID: null };
    const r = st.run(...params);
    return { rows: [], lastID: Number(r.lastInsertRowid) };
  };
  return { db, dbQuery };
}

// utils/db und web-push ersetzen, damit weder echte Datenbank noch Push-Bibliothek nötig sind.
function load(dbQuery) {
  const dbPath = path.resolve(__dirname, '../utils/db.js');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'web-push') return { setVapidDetails() {}, sendNotification: async () => {} };
    if (request === '../config/database') return {};
    if (path.resolve(path.dirname(parent && parent.filename || ''), request) === dbPath.replace(/\.js$/, '')) return { dbQuery };
    return origLoad.apply(this, arguments);
  };
  try {
    for (const f of ['../utils/notifications.js', '../utils/webpush.js']) delete require.cache[require.resolve(f)];
    return { n: require('../utils/notifications.js'), push: require('../utils/webpush.js') };
  } finally { Module._load = origLoad; }
}

test('Meldung an eine Person, an alle und Entdoppelung', { skip }, async () => {
  const { dbQuery } = makeDb();
  const { n } = load(dbQuery);

  assert.equal(await n.addNotification({ title: '✅ Aufgabe', body: 'Test', url: '/tasks' }, 2), 1);
  assert.equal((await n.listForUser(2)).items.length, 1);
  assert.equal((await n.listForUser(3)).items.length, 0, 'andere Personen sehen sie nicht');

  assert.equal(await n.addNotification({ title: '📌 Pinnwand', body: 'Hallo' }, null), 3, 'null = alle Benutzer');
  // gleiche Meldung kurz danach nochmal -> keine Doppelung
  assert.equal(await n.addNotification({ title: '📌 Pinnwand', body: 'Hallo' }, null), 0);
  assert.equal((await n.listForUser(2)).items.length, 2);
});

test('Link wird auf interne Pfade begrenzt', { skip }, async () => {
  const { dbQuery } = makeDb();
  const { n } = load(dbQuery);
  for (const bad of ['javascript:alert(1)', '//evil.example', 'https://evil.example', '', null, '/ mit leerzeichen']) {
    await n.addNotification({ title: 'x' + String(bad), body: 'b', url: bad }, 1);
  }
  await n.addNotification({ title: 'gut', body: 'b', url: '/vacations?x=1' }, 1);
  const items = (await n.listForUser(1)).items;
  assert.equal(items.filter(i => i.url === '/').length, 6);
  assert.equal(items.find(i => i.title === 'gut').url, '/vacations?x=1');
});

test('gelesen markieren: nur eigene Meldungen, Zähler stimmt', { skip }, async () => {
  const { dbQuery } = makeDb();
  const { n } = load(dbQuery);
  await n.addNotification({ title: 'A', body: '1' }, 2);
  await n.addNotification({ title: 'B', body: '2' }, 2);
  await n.addNotification({ title: 'C', body: '3' }, 3);

  let l = await n.listForUser(2);
  assert.equal(l.unread, 2);
  assert.deepEqual(l.items.map(i => i.title), ['B', 'A'], 'neueste zuerst');

  await n.markRead(3, l.items[0].id);                 // fremde Meldung -> wirkungslos
  assert.equal((await n.listForUser(2)).unread, 2);

  await n.markRead(2, l.items[0].id);
  l = await n.listForUser(2);
  assert.equal(l.unread, 1);
  assert.equal(l.items[0].read, true);

  await n.markAllRead(2);
  assert.equal((await n.listForUser(2)).unread, 0);
  assert.equal((await n.listForUser(3)).unread, 1, 'andere Person bleibt ungelesen');
});

test('Aufräumen löscht nur Meldungen älter als 30 Tage', { skip }, async () => {
  const { db, dbQuery } = makeDb();
  const { n } = load(dbQuery);
  const day = 86400000;
  db.prepare('INSERT INTO notifications (user_id,title,body,url,created_ms) VALUES (1,?,?,?,?)').run('alt', '', '/', Date.now() - 31 * day);
  db.prepare('INSERT INTO notifications (user_id,title,body,url,created_ms) VALUES (1,?,?,?,?)').run('neu', '', '/', Date.now() - 29 * day);
  await n.purgeOld();
  assert.deepEqual((await n.listForUser(1)).items.map(i => i.title), ['neu']);
});

test('sendPush schreibt in die Glocke – auch ohne VAPID-Schlüssel; inApp:false überspringt', { skip }, async () => {
  const { dbQuery } = makeDb();
  const { n, push } = load(dbQuery);

  const r = await push.sendPush({ title: '📅 Neuer Termin', body: 'Montag 8 Uhr', url: '/calendar' }, 2);
  assert.equal(r.configured, false, 'ohne VAPID kein Push …');
  await new Promise(res => setTimeout(res, 50));
  assert.equal((await n.listForUser(2)).items[0].title, '📅 Neuer Termin', '… aber Glocke funktioniert');

  await push.sendPush({ title: 'Fallback', body: 'nur Push' }, null, { inApp: false });
  await new Promise(res => setTimeout(res, 50));
  assert.equal((await n.listForUser(3)).items.length, 0);
});
