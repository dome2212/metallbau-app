const express = require('express');
const router  = express.Router();
const { dbQuery }      = require('../utils/db');
const { requireAdmin } = require('../middleware/auth');
const { sendPush }     = require('../utils/webpush');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function weekdayToday() {
  // JS: 0=So … 6=Sa  → wir nutzen 1=Mo … 7=So
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

function itemDueToday(item) {
  if (!item || item.active === 0 || item.active === false) return false;
  if (item.frequency === 'daily') return true;
  if (item.frequency === 'weekly') {
    const wd = item.weekday != null ? parseInt(item.weekday, 10) : null;
    if (wd == null || isNaN(wd)) return true; // wöchentlich ohne festen Tag = immer anzeigen
    return wd === weekdayToday();
  }
  return true;
}

// ==========================================
// AUFGABEN-ÜBERSICHT
// ==========================================
router.get('/', async (req, res) => {
  const userId   = req.user.id;
  const userRole = req.user.role;

  try {
    let tasksRes;
    if (userRole === 'CHEF' || userRole === 'ADMIN') {
      // Chef/Admin sehen alle Aufgaben
      tasksRes = await dbQuery(`
        SELECT t.*, u1.username as assigned_to_name, u2.username as assigned_by_name
        FROM tasks t
        LEFT JOIN users u1 ON t.assigned_to = u1.id
        LEFT JOIN users u2 ON t.assigned_by = u2.id
        ORDER BY
          CASE WHEN t.status = 'Offen' THEN 0 ELSE 1 END,
          CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END,
          t.due_date ASC,
          t.created_at DESC
      `);
    } else {
      // Mitarbeiter sehen nur eigene Aufgaben + Aufgaben für "Alle" (assigned_to IS NULL)
      tasksRes = await dbQuery(`
        SELECT t.*, u1.username as assigned_to_name, u2.username as assigned_by_name
        FROM tasks t
        LEFT JOIN users u1 ON t.assigned_to = u1.id
        LEFT JOIN users u2 ON t.assigned_by = u2.id
        WHERE t.assigned_to = ? OR t.assigned_to IS NULL
        ORDER BY
          CASE WHEN t.status = 'Offen' THEN 0 ELSE 1 END,
          CASE WHEN t.due_date IS NULL OR t.due_date = '' THEN 1 ELSE 0 END,
          t.due_date ASC,
          t.created_at DESC
      `, [userId]);
    }

    const usersRes = await dbQuery(
      `SELECT id, username, role FROM users WHERE role = 'EMPLOYEE' ORDER BY username ASC`
    );

    res.render('tasks', {
      tasks:       tasksRes.rows || [],
      users:       usersRes.rows || [],
      user:        req.user,
      currentUser: req.user,
      activeTab:  'aufgaben',
      putzItems:  [],
      putzAllItems: [],
      putzDoneCount: 0,
      putzTotalToday: 0,
      putzToday: todayISO(),
    });
  } catch (err) {
    console.error('Fehler beim Laden der Aufgaben:', err.message);
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// AUFGABE ANLEGEN (nur Chef/Admin)
// ==========================================
router.post('/add', requireAdmin, async (req, res) => {
  try {
    const { title, description, category, assigned_to, due_date, priority } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).send('Titel ist erforderlich');
    }

    const assignedTo = assigned_to && assigned_to !== '' ? parseInt(assigned_to, 10) : null;

    const result = await dbQuery(
      `INSERT INTO tasks (title, description, category, assigned_to, assigned_by, due_date, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Offen')`,
      [
        title.trim(),
        description || null,
        category || 'Werkstatt',
        assignedTo,
        req.user.id,
        due_date || null,
        priority || 'Normal'
      ]
    );

    // Push-Benachrichtigung an zugewiesenen Mitarbeiter (oder alle, falls "Alle Mitarbeiter")
    const catLabel = category || 'Werkstatt';
    const dueLabel = due_date ? ` (fällig ${due_date})` : '';
    const pushPayload = {
      title: `🔧 Neue Aufgabe: ${title.trim()}`,
      body:  `${catLabel}${dueLabel} – zugewiesen von ${req.user.username}`,
      url:   '/tasks'
    };

    if (assignedTo) {
      sendPush(pushPayload, assignedTo).catch(() => {});
    } else {
      // An alle Mitarbeiter
      const allEmployees = await dbQuery(`SELECT id FROM users WHERE role = 'EMPLOYEE'`);
      for (const emp of (allEmployees.rows || [])) {
        sendPush(pushPayload, emp.id).catch(() => {});
      }
    }

    res.redirect('/tasks');
  } catch (err) {
    console.error('Fehler beim Anlegen der Aufgabe:', err.message);
    res.status(500).send('Fehler beim Speichern der Aufgabe.');
  }
});

// ==========================================
// STATUS ÄNDERN (Mitarbeiter: eigene Aufgabe; Chef/Admin: alle)
// ==========================================
router.post('/status', async (req, res) => {
  try {
    const { id, status } = req.body;
    const taskRes = await dbQuery('SELECT * FROM tasks WHERE id = ?', [id]);
    const task = taskRes.rows && taskRes.rows[0];
    if (!task) return res.status(404).send('Aufgabe nicht gefunden');

    const isOwner = task.assigned_to == req.user.id || task.assigned_to === null || task.assigned_to === undefined;
    const isBoss  = req.user.role === 'CHEF' || req.user.role === 'ADMIN';
    if (!isOwner && !isBoss) {
      return res.status(403).send('Keine Berechtigung für diese Aufgabe');
    }

    const completedAt = status === 'Erledigt' ? new Date().toISOString() : null;
    await dbQuery('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?', [status, completedAt, id]);

    // Chef/Admin informieren, wenn ein Mitarbeiter eine Aufgabe erledigt
    if (status === 'Erledigt' && !isBoss) {
      const adminsRes = await dbQuery(`SELECT id FROM users WHERE role IN ('CHEF','ADMIN')`);
      for (const admin of (adminsRes.rows || [])) {
        sendPush({
          title: `✅ Aufgabe erledigt`,
          body:  `${req.user.username} hat „${task.title}" erledigt.`,
          url:   '/tasks'
        }, admin.id).catch(() => {});
      }
    }

    res.redirect('/tasks');
  } catch (err) {
    console.error('Fehler beim Ändern des Aufgaben-Status:', err.message);
    res.status(500).send('Fehler beim Aktualisieren des Status');
  }
});

// ==========================================
// AUFGABE LÖSCHEN (nur Chef/Admin)
// ==========================================
router.post('/delete', requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    await dbQuery('DELETE FROM tasks WHERE id = ?', [id]);
    res.redirect('/tasks');
  } catch (err) {
    console.error('Fehler beim Löschen der Aufgabe:', err.message);
    res.status(500).send('Fehler beim Löschen');
  }
});



// ==========================================
// PUTZPLAN
// ==========================================


router.get('/putzplan', async (req, res) => {
  try {
    const usersRes = await dbQuery(
      `SELECT id, username, role FROM users WHERE role IN ('EMPLOYEE','CHEF','ADMIN') ORDER BY username ASC`
    );
    let items = [];
    let logsToday = [];
    try {
      const itemsRes = await dbQuery(`
        SELECT p.*, u.username AS assigned_to_name
        FROM cleaning_plan p
        LEFT JOIN users u ON p.assigned_to = u.id
        WHERE p.active = 1
        ORDER BY p.sort_order ASC, p.id ASC
      `);
      items = itemsRes.rows || [];
      const logsRes = await dbQuery(`
        SELECT l.*, u.username AS done_by_name
        FROM cleaning_logs l
        LEFT JOIN users u ON l.done_by = u.id
        WHERE l.done_date = ?
      `, [todayISO()]);
      logsToday = logsRes.rows || [];
    } catch (e) {
      console.warn('Putzplan laden (Migration 17?):', e.message);
    }

    const doneMap = {};
    for (const l of logsToday) {
      doneMap[l.plan_item_id] = l;
    }

    const todayItems = items.filter(itemDueToday).map(it => ({
      ...it,
      done: !!doneMap[it.id],
      log: doneMap[it.id] || null
    }));

    const doneCount = todayItems.filter(i => i.done).length;

    res.render('tasks', {
      tasks: [],
      users: usersRes.rows || [],
      user: req.user,
      currentUser: req.user,
      activeTab: 'putzplan',
      putzItems: todayItems,
      putzAllItems: items,
      putzDoneCount: doneCount,
      putzTotalToday: todayItems.length,
      putzToday: todayISO(),
    });
  } catch (err) {
    console.error('Putzplan:', err.message);
    res.status(500).send('Fehler beim Laden des Putzplans');
  }
});

router.post('/putzplan/add', requireAdmin, async (req, res) => {
  try {
    const { title, area, frequency, weekday, assigned_to } = req.body;
    if (!title || !title.trim()) return res.status(400).send('Titel erforderlich');
    const assignedTo = assigned_to && assigned_to !== '' ? parseInt(assigned_to, 10) : null;
    const wd = frequency === 'weekly' && weekday !== '' && weekday != null ? parseInt(weekday, 10) : null;
    await dbQuery(
      `INSERT INTO cleaning_plan (title, area, frequency, weekday, assigned_to, sort_order, active)
       VALUES (?, ?, ?, ?, ?, 100, 1)`,
      [title.trim(), area || 'Werkstatt', frequency || 'daily', wd, assignedTo]
    );
    res.redirect('/tasks/putzplan');
  } catch (err) {
    console.error('Putzplan add:', err.message);
    res.status(500).send('Fehler beim Anlegen. (Migration 17?)');
  }
});

router.post('/putzplan/delete', requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    await dbQuery(`UPDATE cleaning_plan SET active = 0 WHERE id = ?`, [id]);
    res.redirect('/tasks/putzplan');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

router.post('/putzplan/done', async (req, res) => {
  try {
    const { id, note } = req.body;
    const date = todayISO();
    // already done today?
    const exist = await dbQuery(
      `SELECT id FROM cleaning_logs WHERE plan_item_id = ? AND done_date = ?`,
      [id, date]
    );
    if ((exist.rows || []).length === 0) {
      await dbQuery(
        `INSERT INTO cleaning_logs (plan_item_id, done_date, done_by, note) VALUES (?, ?, ?, ?)`,
        [id, date, req.user.id, note || null]
      );
    }
    res.redirect('/tasks/putzplan');
  } catch (err) {
    console.error('Putzplan done:', err.message);
    res.status(500).send('Fehler beim Abhaken');
  }
});

router.post('/putzplan/undo', async (req, res) => {
  try {
    const { id } = req.body;
    await dbQuery(
      `DELETE FROM cleaning_logs WHERE plan_item_id = ? AND done_date = ?`,
      [id, todayISO()]
    );
    res.redirect('/tasks/putzplan');
  } catch (err) {
    res.status(500).send('Fehler');
  }
});


module.exports = router;
