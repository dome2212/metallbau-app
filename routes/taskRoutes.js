const express = require('express');
const router  = express.Router();
const { dbQuery }      = require('../utils/db');
const { requireAdmin } = require('../middleware/auth');
const { sendPush }     = require('../utils/webpush');

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
// TASK-CHAT: Nachrichten zu einer Aufgabe laden
// ==========================================
router.get('/:id/messages', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (!taskId) return res.status(400).json({ error: 'Ungültige Task-ID' });

    // Berechtigung: Chef/Admin oder zugewiesener / "Alle"
    const taskRes = await dbQuery('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const task = taskRes.rows && taskRes.rows[0];
    if (!task) return res.status(404).json({ error: 'Aufgabe nicht gefunden' });

    const isBoss = req.user.role === 'CHEF' || req.user.role === 'ADMIN';
    const isOwner = task.assigned_to == req.user.id || task.assigned_to === null || task.assigned_to === undefined;
    if (!isBoss && !isOwner) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    const msgRes = await dbQuery(
      `SELECT m.*, u.username
       FROM task_messages m
       LEFT JOIN users u ON m.user_id = u.id
       WHERE m.task_id = ?
       ORDER BY m.created_at ASC`,
      [taskId]
    );

    res.json({ messages: msgRes.rows || [] });
  } catch (err) {
    console.error('Fehler beim Laden der Task-Nachrichten:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==========================================
// TASK-CHAT: Nachricht senden
// ==========================================
router.post('/:id/messages', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { message } = req.body;
    if (!taskId) return res.status(400).json({ error: 'Ungültige Task-ID' });
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Nachricht darf nicht leer sein' });
    }

    const taskRes = await dbQuery('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const task = taskRes.rows && taskRes.rows[0];
    if (!task) return res.status(404).json({ error: 'Aufgabe nicht gefunden' });

    const isBoss = req.user.role === 'CHEF' || req.user.role === 'ADMIN';
    const isOwner = task.assigned_to == req.user.id || task.assigned_to === null || task.assigned_to === undefined;
    if (!isBoss && !isOwner) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    await dbQuery(
      `INSERT INTO task_messages (task_id, user_id, message) VALUES (?, ?, ?)`,
      [taskId, req.user.id, String(message).trim()]
    );

    // Push an Gegenüber: wenn Mitarbeiter schreibt → Chef/Admin; wenn Chef schreibt → zugewiesener MA
    const pushPayload = {
      title: `💬 Chat: ${task.title}`,
      body:  `${req.user.username}: ${String(message).trim().slice(0, 80)}`,
      url:   '/tasks'
    };

    if (isBoss) {
      if (task.assigned_to) {
        sendPush(pushPayload, task.assigned_to).catch(() => {});
      } else {
        const allEmployees = await dbQuery(`SELECT id FROM users WHERE role = 'EMPLOYEE'`);
        for (const emp of (allEmployees.rows || [])) {
          sendPush(pushPayload, emp.id).catch(() => {});
        }
      }
    } else {
      const adminsRes = await dbQuery(`SELECT id FROM users WHERE role IN ('CHEF','ADMIN')`);
      for (const admin of (adminsRes.rows || [])) {
        sendPush(pushPayload, admin.id).catch(() => {});
      }
    }

    // Neueste Nachrichten zurückgeben
    const msgRes = await dbQuery(
      `SELECT m.*, u.username
       FROM task_messages m
       LEFT JOIN users u ON m.user_id = u.id
       WHERE m.task_id = ?
       ORDER BY m.created_at ASC`,
      [taskId]
    );

    res.json({ ok: true, messages: msgRes.rows || [] });
  } catch (err) {
    console.error('Fehler beim Senden der Task-Nachricht:', err.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// ==========================================
// TASK-CHAT: Nachricht löschen
// ==========================================
router.post('/:id/messages/delete', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.body.message_id || req.body.id, 10);
    if (!taskId || !msgId) return res.status(400).json({ error: 'Ungültige ID' });

    const msgRes = await dbQuery('SELECT * FROM task_messages WHERE id = ? AND task_id = ?', [msgId, taskId]);
    const msg = msgRes.rows && msgRes.rows[0];
    if (!msg) return res.status(404).json({ error: 'Nachricht nicht gefunden' });

    const isBoss = req.user.role === 'CHEF' || req.user.role === 'ADMIN';
    const isOwn = Number(msg.user_id) === Number(req.user.id);
    if (!isOwn && !isBoss) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Löschen' });
    }

    await dbQuery('DELETE FROM task_messages WHERE id = ?', [msgId]);

    const listRes = await dbQuery(
      `SELECT m.*, u.username
       FROM task_messages m
       LEFT JOIN users u ON m.user_id = u.id
       WHERE m.task_id = ?
       ORDER BY m.created_at ASC`,
      [taskId]
    );
    res.json({ ok: true, messages: listRes.rows || [] });
  } catch (err) {
    console.error('Fehler beim Löschen der Task-Nachricht:', err.message);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

module.exports = router;
