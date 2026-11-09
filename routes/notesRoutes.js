/**
 * Notizen & Wiedervorlagen (Büro)
 * - Telefon-/Rückrufnotizen, Wiedervorlagen ("am … nachfassen") und freie Notizen
 * - Nur Büro-Rollen (CHEF, ADMIN, BUERO)
 */
const express = require('express');
const router  = express.Router();
const { requireOffice } = require('../middleware/auth');
const { dbQuery } = require('../utils/db');

router.use(requireOffice);

const KINDS = ['anruf', 'wiedervorlage', 'notiz'];

function todayBerlin() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const back = (req, res) => {
  const r = String(req.body.redirect || '');
  res.redirect(r.startsWith('/') && !r.startsWith('//') ? r : '/notizen');
};

const SELECT = `
  SELECT n.*, c.company_name, c.contact_person, u.username AS creator
  FROM office_notes n
  LEFT JOIN customers c ON c.id = n.customer_id
  LEFT JOIN users u ON u.id = n.created_by`;

router.get('/', async (req, res, next) => {
  try {
    const tab = req.query.tab === 'erledigt' ? 'erledigt' : 'offen';
    const today = todayBerlin();
    const rows = tab === 'offen'
      ? (await dbQuery(`${SELECT} WHERE n.status = 'offen'
          ORDER BY CASE WHEN n.due_date IS NULL OR n.due_date = '' THEN 1 ELSE 0 END, n.due_date ASC, n.id DESC`)).rows
      : (await dbQuery(`${SELECT} WHERE n.status = 'erledigt' ORDER BY n.done_at DESC, n.id DESC LIMIT 100`)).rows;
    const customers = (await dbQuery(
      `SELECT id, company_name, contact_person FROM customers ORDER BY COALESCE(company_name, contact_person)`)).rows;

    const groups = { ueberfaellig: [], heute: [], spaeter: [], ohne: [] };
    if (tab === 'offen') {
      rows.forEach(n => {
        const d = n.due_date ? String(n.due_date).slice(0, 10) : '';
        if (!d) groups.ohne.push(n);
        else if (d < today) groups.ueberfaellig.push(n);
        else if (d === today) groups.heute.push(n);
        else groups.spaeter.push(n);
      });
    }
    const pre = {
      kind: KINDS.includes(req.query.kind) ? req.query.kind : 'anruf',
      customer_id: parseInt(req.query.customer_id, 10) || '',
    };
    res.render('notizen', {
      tab, rows, groups, customers, pre, today,
      tomorrow: addDays(today, 1), nextWeek: addDays(today, 7),
      currentUser: req.user, user: req.user,
    });
  } catch (e) { next(e); }
});

router.post('/add', async (req, res, next) => {
  try {
    const b = req.body;
    const kind = KINDS.includes(b.kind) ? b.kind : 'notiz';
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return res.redirect('/notizen');
    const due = isDate(b.due_date) ? b.due_date : null;
    await dbQuery(
      `INSERT INTO office_notes (kind, title, body, customer_id, contact_name, contact_phone, due_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, title, String(b.body || '').trim().slice(0, 4000) || null,
       parseInt(b.customer_id, 10) || null,
       String(b.contact_name || '').trim().slice(0, 120) || null,
       String(b.contact_phone || '').trim().slice(0, 60) || null,
       due, req.user.id]);
    back(req, res);
  } catch (e) { next(e); }
});

router.post('/:id/done', async (req, res, next) => {
  try {
    await dbQuery(`UPDATE office_notes SET status = 'erledigt', done_by = ?, done_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [req.user.id, parseInt(req.params.id, 10)]);
    back(req, res);
  } catch (e) { next(e); }
});

router.post('/:id/reopen', async (req, res, next) => {
  try {
    await dbQuery(`UPDATE office_notes SET status = 'offen', done_by = NULL, done_at = NULL WHERE id = ?`,
      [parseInt(req.params.id, 10)]);
    back(req, res);
  } catch (e) { next(e); }
});

// Verschieben: ?days=1 / 7 oder konkretes Datum
router.post('/:id/snooze', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    let date = isDate(req.body.date) ? req.body.date : null;
    if (!date) {
      const days = Math.min(Math.max(parseInt(req.body.days, 10) || 1, 1), 365);
      date = addDays(todayBerlin(), days);
    }
    await dbQuery(`UPDATE office_notes SET due_date = ? WHERE id = ?`, [date, id]);
    back(req, res);
  } catch (e) { next(e); }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await dbQuery(`DELETE FROM office_notes WHERE id = ?`, [parseInt(req.params.id, 10)]);
    back(req, res);
  } catch (e) { next(e); }
});

module.exports = router;
