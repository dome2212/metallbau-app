/**
 * Anwesenheit – "Wer ist gerade wo eingestempelt?"
 * Büro-Rollen (CHEF, ADMIN, BUERO). Ein Mitarbeiter gilt als "da", wenn sein
 * letzter Stempel ein EINSTEMPELN (IN) ist und nicht älter als 16 Stunden.
 * Stempel ohne Auftrag = Werkstatt / Firma, mit Auftrag = Baustelle.
 */
const express = require('express');
const router  = express.Router();
const { requireOffice } = require('../middleware/auth');
const { dbQuery } = require('../utils/db');

const isPg = !!process.env.DATABASE_URL;
router.use(requireOffice);

async function loadPresence() {
  const cut  = isPg ? "NOW() - INTERVAL '16 hours'" : "datetime('now','-16 hours')";
  const hhmm = isPg
    ? "TO_CHAR(l.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'HH24:MI')"
    : "strftime('%H:%M', l.timestamp)";
  const rows = (await dbQuery(`
    SELECT u.id AS user_id, u.username, l.project_id, p.title AS project_title,
           c.company_name, c.contact_person, ${hhmm} AS since
    FROM users u
    JOIN time_logs l ON l.id = (
      SELECT id FROM time_logs WHERE user_id = u.id ORDER BY timestamp DESC, id DESC LIMIT 1)
    LEFT JOIN projects  p ON p.id = l.project_id
    LEFT JOIN customers c ON c.id = COALESCE(l.customer_id, p.customer_id)
    WHERE l.type = 'IN' AND l.timestamp > ${cut}
    ORDER BY u.username ASC`)).rows;

  const werkstatt = { key: 'werkstatt', label: 'Werkstatt / Firma', sub: '', url: null, people: [] };
  const sites = new Map();
  for (const r of rows) {
    const person = { name: r.username, since: r.since || '' };
    if (!r.project_id) { werkstatt.people.push(person); continue; }
    if (!sites.has(r.project_id)) {
      sites.set(r.project_id, {
        key: 'p' + r.project_id,
        label: r.project_title || ('Auftrag ' + r.project_id),
        sub: r.company_name || r.contact_person || '',
        url: '/projects/' + r.project_id,
        people: [],
      });
    }
    sites.get(r.project_id).people.push(person);
  }
  const groups = [];
  if (werkstatt.people.length) groups.push(werkstatt);
  groups.push(...sites.values());
  return { total: rows.length, groups };
}

router.get('/data', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await loadPresence());
  } catch (e) {
    console.error('⚠️ Anwesenheit:', e.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

router.get('/', (req, res) => {
  res.render('anwesenheit', { currentUser: req.user, user: req.user });
});

module.exports = router;
