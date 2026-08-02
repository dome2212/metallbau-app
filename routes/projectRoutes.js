const express = require('express');
const router = express.Router();
const db = require('../config/database');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { v2: cloudinary } = require('cloudinary');
const { sendEmail, sendWhatsApp } = require('../utils/notifier'); // Benachrichtigungs-Service importieren

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'metallbau-management', allowed_formats: ['jpg', 'png', 'jpeg', 'pdf', 'webp'] }
});
const upload = multer({ storage: storage, limits: { fileSize: 15 * 1024 * 1024 } });

const dbQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    db.query(pgSql, params, (err, res) => {
      if (err) return reject(err);
      resolve({ rows: res.rows || [], lastID: res.rows?.[0]?.id });
    });
  });
};

router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT projects.*, customers.company_name, customers.contact_person, customers.street, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id ORDER BY projects.created_at DESC
    `;
    const projRes = await dbQuery(sql);
    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');
    res.render('projects', { projects: projRes.rows || [], customers: custRes.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

router.post('/add', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { customer_id, title, description, total_price, status } = req.body;
  const parsedPrice = parseFloat(String(total_price || '0').replace(',', '.')) || 0;
  try {
    await dbQuery(`INSERT INTO projects (customer_id, title, description, total_price, status) VALUES (?, ?, ?, ?, ?)`,
      [customer_id || null, title, description || null, parsedPrice, status || 'In Planung']);
    res.redirect('/projects');
  } catch (err) {
    res.status(500).send('Fehler beim Erstellen');
  }
});

// ERWEITERTE STATUS-ROUTE MIT AUTOMATISCHEN BENACHRICHTIGUNGEN
router.post('/update-status', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id, status } = req.body;
  try {
    // 1. Status in der Datenbank aktualisieren
    await dbQuery('UPDATE projects SET status = ? WHERE id = ?', [status, id]);

    // 2. Projektdaten und Kundendaten (E-Mail & Telefon) für die Benachrichtigung abrufen
    const projRes = await dbQuery(`
      SELECT projects.title, customers.email, customers.phone, customers.company_name, customers.contact_person 
      FROM projects 
      LEFT JOIN customers ON projects.customer_id = customers.id 
      WHERE projects.id = ?
    `, [id]);

    const project = projRes.rows[0];

    if (project && project.email) {
      const recipientName = project.company_name || project.contact_person || 'Sehr geehrter Kunde';
      
      // E-Mail senden
      await sendEmail(
        project.email,
        `Status-Update zu Ihrem Projekt: ${project.title}`,
        `<p>Guten Tag ${recipientName},</p>
         <p>der Status Ihres Projektes <b>"${project.title}"</b> hat sich geändert.</p>
         <p>Neuer Status: <b>${status}</b></p>
         <p>Mit freundlichen Grüßen<br>Ihr Metallbau-Team</p>`
      );

      // Optional: WhatsApp senden, falls Telefonnummer vorhanden
      if (project.phone) {
        await sendWhatsApp(
          project.phone,
          `Hallo! Status-Update für Projekt "${project.title}": Der neue Status ist "${status}".`
        );
      }
    }

    res.redirect('back');
  } catch (err) {
    console.error('Fehler bei Status-Update & Benachrichtigung:', err);
    res.status(500).send('Fehler');
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const projRes = await dbQuery(`SELECT projects.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city FROM projects LEFT JOIN customers ON projects.customer_id = customers.id WHERE projects.id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).send('Nicht gefunden');

    const [filesRes, appRes, photosRes, measurementsRes, notesRes, tasksRes] = await Promise.all([
      dbQuery('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery('SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC', [project.customer_id]),
      dbQuery('SELECT * FROM project_photos WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery('SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery('SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC', [id])
    ]);

    res.render('project-detail', {
      project, files: filesRes.rows, appointments: appRes.rows, photos: photosRes.rows,
      measurements: measurementsRes.rows, notes: notesRes.rows, tasks: tasksRes.rows
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

router.post('/:id/upload', upload.single('file'), async (req, res) => {
  if (req.file) {
    await dbQuery(`INSERT INTO project_files (project_id, filename, original_name, file_type, file_url) VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.path]);
  }
  res.redirect(`/projects/${req.params.id}`);
});

router.post('/:id/photos/upload', upload.single('photo'), async (req, res) => {
  if (req.file) {
    await dbQuery(`INSERT INTO project_photos (project_id, file_url, original_name) VALUES (?, ?, ?)`,
      [req.params.id, req.file.path, req.file.originalname]);
  }
  res.redirect(`/projects/${req.params.id}`);
});

router.post('/:id/tasks/add', upload.single('photo'), async (req, res) => {
  const { title, category, description } = req.body;
  if (title && title.trim()) {
    await dbQuery(`INSERT INTO project_tasks (project_id, title, category, description, photo_url, status) VALUES (?, ?, ?, ?, ?, 'Offen')`,
      [req.params.id, title.trim(), category || 'Restarbeit', description || null, req.file ? req.file.path : null]);
  }
  res.redirect(`/projects/${req.params.id}`);
});

router.post('/:id/measurements/add', async (req, res) => {
  const { component_name, width, height, angle, quantity, note } = req.body;
  if (component_name) {
    await dbQuery(`INSERT INTO project_measurements (project_id, component_name, width, height, angle, quantity, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, component_name, width || null, height || null, angle || null, parseInt(quantity || '1', 10), note || null]);
  }
  res.redirect(`/projects/${req.params.id}`);
});

router.post('/:id/notes/add', async (req, res) => {
  const { note_text } = req.body;
  if (note_text && note_text.trim()) {
    await dbQuery(`INSERT INTO project_notes (project_id, note_text) VALUES (?, ?)`, [req.params.id, note_text.trim()]);
  }
  res.redirect(`/projects/${req.params.id}`);
});

router.post('/measurements/delete', async (req, res) => {
  await dbQuery('DELETE FROM project_measurements WHERE id = ?', [req.body.measurement_id]);
  res.redirect(`/projects/${req.body.project_id}`);
});

router.post('/notes/delete', async (req, res) => {
  await dbQuery('DELETE FROM project_notes WHERE id = ?', [req.body.note_id]);
  res.redirect(`/projects/${req.body.project_id}`);
});

router.post('/photos/delete', async (req, res) => {
  await dbQuery('DELETE FROM project_photos WHERE id = ?', [req.body.photo_id]);
  res.redirect(`/projects/${req.body.project_id}`);
});

router.post('/files/delete', async (req, res) => {
  await dbQuery('DELETE FROM project_files WHERE id = ?', [req.body.file_id]);
  res.redirect(`/projects/${req.body.project_id}`);
});

router.post('/tasks/delete', async (req, res) => {
  await dbQuery('DELETE FROM project_tasks WHERE id = ?', [req.body.task_id]);
  res.redirect(`/projects/${req.body.project_id}`);
});

router.post('/tasks/status', async (req, res) => {
  await dbQuery('UPDATE project_tasks SET status = ? WHERE id = ?', [req.body.status || 'Offen', req.body.task_id]);
  res.redirect(`/projects/${req.body.project_id}`);
});

router.post('/delete', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  await dbQuery('DELETE FROM project_files WHERE project_id = ?', [req.body.id]);
  await dbQuery('DELETE FROM projects WHERE id = ?', [req.body.id]);
  res.redirect('/projects');
});

module.exports = router;
