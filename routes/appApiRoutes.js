const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');
const isPg = !!process.env.DATABASE_URL;

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  const like   = `%${q}%`;
  const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'CHEF';
  const likeOp  = isPg ? 'ILIKE' : 'LIKE';

  try {
    const [projRes, appRes, notesRes, custRes, usersRes, articlesRes] = await Promise.all([
      dbQuery(`
        SELECT p.id, p.title, p.status, p.description, c.company_name, c.contact_person
        FROM projects p LEFT JOIN customers c ON p.customer_id = c.id
        WHERE p.title ${likeOp} ? OR p.description ${likeOp} ?
           OR c.company_name ${likeOp} ? OR c.contact_person ${likeOp} ?
        ORDER BY p.created_at DESC LIMIT 6`, [like, like, like, like]),
      dbQuery(`
        SELECT a.id, a.title, a.start_date, a.description, c.company_name, c.contact_person
        FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id
        WHERE a.title ${likeOp} ? OR a.description ${likeOp} ?
           OR c.company_name ${likeOp} ? OR c.contact_person ${likeOp} ?
        ORDER BY a.start_date DESC LIMIT 4`, [like, like, like, like]),
      dbQuery(`
        SELECT n.id, n.note_text, n.project_id, p.title as project_title
        FROM project_notes n LEFT JOIN projects p ON n.project_id = p.id
        WHERE n.note_text ${likeOp} ?
        ORDER BY n.created_at DESC LIMIT 4`, [like]),
      isAdmin ? dbQuery(`
        SELECT id, company_name, contact_person, city
        FROM customers
        WHERE company_name ${likeOp} ? OR contact_person ${likeOp} ? OR city ${likeOp} ?
        ORDER BY company_name ASC LIMIT 5`, [like, like, like])
        : Promise.resolve({ rows: [] }),
      isAdmin ? dbQuery(`
        SELECT id, username, role FROM users
        WHERE username ${likeOp} ?
        ORDER BY username ASC LIMIT 4`, [like])
        : Promise.resolve({ rows: [] }),
      isAdmin ? dbQuery(`
        SELECT id, title, unit FROM articles
        WHERE title ${likeOp} ? OR description ${likeOp} ?
        ORDER BY title ASC LIMIT 4`, [like, like])
        : Promise.resolve({ rows: [] }),
    ]);

    const results = [
      ...(projRes.rows || []).map(r => ({
        type: 'project', icon: '🏗️',
        label: r.title,
        sub:   [r.company_name || r.contact_person, r.status].filter(Boolean).join(' · '),
        url:   `/projects/${r.id}`
      })),
      ...(custRes.rows || []).map(r => ({
        type: 'customer', icon: '👤',
        label: r.company_name || r.contact_person,
        sub:   [r.contact_person, r.city].filter(Boolean).join(' · '),
        url:   `/customers`
      })),
      ...(appRes.rows || []).map(r => ({
        type: 'appointment', icon: '📅',
        label: r.title,
        sub:   [r.company_name || r.contact_person, r.start_date ? new Date(r.start_date).toLocaleDateString('de-DE') : ''].filter(Boolean).join(' · '),
        url:   `/calendar`
      })),
      ...(notesRes.rows || []).map(r => ({
        type: 'note', icon: '📝',
        label: r.note_text.length > 70 ? r.note_text.slice(0, 70) + '…' : r.note_text,
        sub:   r.project_title ? `Auftrag: ${r.project_title}` : '',
        url:   r.project_id ? `/projects/${r.project_id}` : `/projects`
      })),
      ...(usersRes.rows || []).map(r => ({
        type: 'user', icon: '👷',
        label: r.username,
        sub:   r.role,
        url:   `/admin/users`
      })),
      ...(articlesRes.rows || []).map(r => ({
        type: 'article', icon: '📦',
        label: r.title,
        sub:   r.unit ? `Einheit: ${r.unit}` : '',
        url:   `/articles`
      })),
    ];

    res.json({ results });
  } catch (err) {
    console.error('Suche Fehler:', err.message);
    res.json({ results: [] });
  }
});

router.get('/today-hours', async (req, res) => {
  try {
    const userId = req.user.id;
    const sql = isPg
      ? `SELECT type, TO_CHAR(timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local_ts
         FROM time_logs WHERE user_id = ? AND DATE(timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') = CURRENT_DATE
         ORDER BY timestamp ASC`
      : `SELECT type, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_ts
         FROM time_logs WHERE user_id = ? AND date(timestamp) = date('now')
         ORDER BY timestamp ASC`;
    const result = await dbQuery(sql, [userId]);
    const logs   = result.rows || [];
    let totalMs  = 0;
    const now    = Date.now();
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].type !== 'IN') continue;
      const start = new Date((logs[i].local_ts || '').replace(' ', 'T')).getTime();
      const next  = logs[i + 1];
      const end   = (next && next.type === 'OUT')
        ? new Date((next.local_ts || '').replace(' ', 'T')).getTime()
        : (i === logs.length - 1 ? now : start);
      if (end > start) totalMs += end - start;
    }
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    res.json({ label: `${h} Std. ${m} Min.` });
  } catch (err) {
    res.json({ label: '–' });
  }
});

router.post('/dark-mode', async (req, res) => {
  try {
    const { dark } = req.body;
    const val = dark === true || dark === 'true' ? 1 : 0;
    await dbQuery(
      isPg
        ? `UPDATE users SET dark_mode = ? WHERE id = ?`
        : `UPDATE users SET dark_mode = ? WHERE id = ?`,
      [val, req.user.id]
    ).catch(() => {}); // Spalte existiert ggf. noch nicht — still ignorieren
    res.json({ ok: true });
  } catch (_) {
    res.json({ ok: false });
  }
});

module.exports = router;
