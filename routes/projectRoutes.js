const express   = require('express');
const router    = express.Router();
const multer    = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { v2: cloudinary }    = require('cloudinary');
const { dbQuery }           = require('../utils/db');
const { requireAdmin, hasPerm } = require('../middleware/auth');
const { getFirma }          = require('../utils/companySettings');
const { sendWhatsApp }      = require('../utils/notifier');

const isPg = !!process.env.DATABASE_URL;

let PDFKit;
try { PDFKit = require('pdfkit'); } catch (_) {}

const upload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'metallbau-management', allowed_formats: ['jpg', 'png', 'jpeg', 'pdf', 'webp'] }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/'))
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

async function callAI(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY nicht konfiguriert.');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.APP_URL || 'https://metallbau-app.onrender.com',
      'X-Title': 'Metallbau App'
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.choices[0].message.content;
}

// Vision-fähige KI (Bilder + Text) – Fallback-Kette über kostenlose Modelle
const VISION_MODELS_FREE = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
];

async function callAIWithImages(prompt, imageBuffers) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY nicht konfiguriert.');

  const imageParts = imageBuffers.map(({ buffer, mimetype }) => ({
    type: 'image_url',
    image_url: { url: `data:${mimetype};base64,${buffer.toString('base64')}` }
  }));

  let lastError;
  for (const model of VISION_MODELS_FREE) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.APP_URL || 'https://metallbau-app.onrender.com',
        'X-Title': 'Metallbau App'
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: prompt }, ...imageParts]
        }],
        temperature: 0.7
      })
    });
    const data = await res.json();
    if (!res.ok) {
      const code = data?.error?.code;
      if (code === 429 || code === 404 || code === 400) { lastError = data; continue; }
      throw new Error(JSON.stringify(data));
    }
    return data.choices[0].message.content;
  }
  throw new Error('Alle Vision-Modelle nicht verfügbar: ' + JSON.stringify(lastError));
}

function fetchWeather(lat, lng, dateStr) {
  const https = require('https');
  return new Promise((resolve) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr);
    if (Math.round((target - today) / 86400000) > 16) return resolve(null);
    const params = new URLSearchParams({
      latitude: lat, longitude: lng,
      daily: 'weathercode,windspeed_10m_max,windgusts_10m_max,precipitation_sum',
      timezone: 'Europe/Berlin', start_date: dateStr, end_date: dateStr, wind_speed_unit: 'kmh'
    });
    https.get(`https://api.open-meteo.com/v1/forecast?${params}`, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          const d = json.daily;
          if (!d || !d.time || d.time.length === 0) return resolve(null);
          const windgusts = d.windgusts_10m_max[0] || 0;
          const precip    = d.precipitation_sum[0] || 0;
          const wcode     = d.weathercode[0]        || 0;
          let warningLevel = 'ok';
          if (windgusts >= 55 || precip >= 10 || wcode >= 80) warningLevel = 'danger';
          else if (windgusts >= 40 || precip >= 5  || wcode >= 61) warningLevel = 'warn';
          resolve({ windspeed: Math.round(d.windspeed_10m_max[0] || 0), windgusts: Math.round(windgusts), precipitation: Math.round(precip * 10) / 10, weathercode: wcode, warningLevel });
        } catch (_) { resolve(null); }
      });
      resp.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

// ==========================================
// PROJEKTLISTE
// ==========================================
router.get('/', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'projects', firma, true, true)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
  try {
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person, customers.street, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id
      ORDER BY projects.created_at DESC
    `);
    const custRes = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');
    res.render('projects', { projects: projRes.rows || [], customers: custRes.rows || [] });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// PROJEKT ANLEGEN
// ==========================================
router.post('/add', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { customer_id, title, description, total_price, status } = req.body;
  const parsedPrice = parseFloat(String(total_price || '0').replace(',', '.')) || 0;
  try {
    await dbQuery(
      `INSERT INTO projects (customer_id, title, description, total_price, status) VALUES (?, ?, ?, ?, ?)`,
      [customer_id || null, title, description || null, parsedPrice, status || 'In Planung']
    );

    // WhatsApp-Benachrichtigung an alle Mitarbeiter
    const usersRes = await dbQuery(
      `SELECT whatsapp_phone, whatsapp_api_key FROM users WHERE whatsapp_notify = true AND whatsapp_phone IS NOT NULL AND whatsapp_api_key IS NOT NULL`
    );
    const msg = `🏗️ Neuer Auftrag: "${title}"${description ? ' – ' + description : ''}`;
    for (const u of (usersRes.rows || [])) {
      sendWhatsApp(u.whatsapp_phone, msg, u.whatsapp_api_key).catch(() => {});
    }

    res.redirect('/projects');
  } catch (err) {
    res.status(500).send('Fehler beim Erstellen des Auftrags');
  }
});

// ==========================================
// STATUS SCHNELL ÄNDERN
// ==========================================
router.post('/update-status', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id, status } = req.body;
  try {
    await dbQuery('UPDATE projects SET status = ? WHERE id = ?', [status, id]);
    res.redirect('back');
  } catch (err) {
    res.status(500).send('Fehler beim Aktualisieren des Status');
  }
});

// ==========================================
// PROJEKT BEARBEITEN
// ==========================================
router.post('/:id/edit', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id } = req.params;
  const { title, description, total_price, status } = req.body;
  const parsedPrice = parseFloat(String(total_price || '0').replace(',', '.')) || 0;
  try {
    await dbQuery(
      'UPDATE projects SET title = ?, description = ?, total_price = ?, status = ? WHERE id = ?',
      [title, description || null, parsedPrice, status || 'In Planung', id]
    );
    res.redirect(`/projects/${id}`);
  } catch (err) {
    res.status(500).send('Fehler beim Speichern der Änderungen');
  }
});

// ==========================================
// PROJEKTDETAIL
// ==========================================
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person, customers.email, customers.phone, customers.street, customers.zip, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.id = ?
    `, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).send('Auftrag nicht gefunden');

    const [filesRes, appRes, photosRes, measurementsRes, notesRes, tasksRes, usersRes] = await Promise.all([
      dbQuery('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery('SELECT * FROM appointments WHERE customer_id = ? ORDER BY start_date DESC', [project.customer_id]),
      dbQuery('SELECT * FROM project_photos WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery('SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery('SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC', [id]),
      dbQuery(`SELECT project_tasks.*, users.username as assigned_username FROM project_tasks LEFT JOIN users ON project_tasks.assigned_to = users.id WHERE project_tasks.project_id = ? ORDER BY project_tasks.created_at DESC`, [id]),
      dbQuery('SELECT id, username FROM users ORDER BY username ASC')
    ]);

    const FIRM_LAT = parseFloat(process.env.FIRM_LAT || '51.3069467');
    const FIRM_LNG = parseFloat(process.env.FIRM_LNG || '6.9483845');
    const appointmentsWithWeather = await Promise.all(
      (appRes.rows || []).map(async (app) => {
        if (!app.start_date) return { ...app, weather: null };
        const weather = await fetchWeather(
          project.site_lat || FIRM_LAT,
          project.site_lng || FIRM_LNG,
          app.start_date.split('T')[0]
        );
        return { ...app, weather };
      })
    );

    res.render('project-detail', {
      project,
      files:        filesRes.rows        || [],
      appointments: appointmentsWithWeather,
      photos:       photosRes.rows       || [],
      measurements: measurementsRes.rows || [],
      notes:        notesRes.rows        || [],
      tasks:        tasksRes.rows        || [],
      users:        usersRes.rows        || []
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// PROJEKT LÖSCHEN
// ==========================================
router.post('/delete', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id } = req.body;
  try {
    // Alle abhängigen Daten zuerst löschen
    await dbQuery('DELETE FROM project_tasks        WHERE project_id = ?', [id]);
    await dbQuery('DELETE FROM project_notes        WHERE project_id = ?', [id]);
    await dbQuery('DELETE FROM project_photos       WHERE project_id = ?', [id]);
    await dbQuery('DELETE FROM project_measurements WHERE project_id = ?', [id]);
    await dbQuery('DELETE FROM project_sketches     WHERE project_id = ?', [id]);
    await dbQuery('DELETE FROM project_files        WHERE project_id = ?', [id]);
    await dbQuery('DELETE FROM projects             WHERE id = ?',         [id]);
    res.redirect('/projects');
  } catch (err) {
    res.status(500).send('Fehler beim Löschen');
  }
});

// ==========================================
// FOTOS HOCHLADEN / LÖSCHEN
// ==========================================
router.post('/:id/photos/upload', upload.single('photo'), async (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.redirect(`/projects/${projectId}`);
  try {
    await dbQuery(
      `INSERT INTO project_photos (project_id, file_url, original_name) VALUES (?, ?, ?)`,
      [projectId, req.file.path, req.file.originalname]
    );
  } catch (err) { console.error('Fehler beim Foto-Upload:', err.message); }
  res.redirect(`/projects/${projectId}`);
});

router.post('/photos/delete', async (req, res) => {
  const { photo_id, project_id } = req.body;
  try { await dbQuery('DELETE FROM project_photos WHERE id = ?', [photo_id]); } catch (_) {}
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// AUFMASS HINZUFÜGEN / LÖSCHEN
// ==========================================
router.post('/:id/measurements/add', async (req, res) => {
  const projectId = req.params.id;
  const { component_name, width, height, angle, quantity, note } = req.body;
  if (!component_name) return res.redirect(`/projects/${projectId}`);
  try {
    await dbQuery(
      `INSERT INTO project_measurements (project_id, component_name, width, height, angle, quantity, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [projectId, component_name, width || null, height || null, angle || null, parseInt(quantity || '1', 10), note || null]
    );
  } catch (err) { console.error('Fehler beim Speichern des Aufmaßes:', err.message); }
  res.redirect(`/projects/${projectId}`);
});

router.post('/measurements/delete', async (req, res) => {
  const { measurement_id, project_id } = req.body;
  try { await dbQuery('DELETE FROM project_measurements WHERE id = ?', [measurement_id]); } catch (_) {}
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// NOTIZEN HINZUFÜGEN / LÖSCHEN
// ==========================================
router.post('/:id/notes/add', async (req, res) => {
  const projectId = req.params.id;
  const { note_text } = req.body;
  if (!note_text || !note_text.trim()) return res.redirect(`/projects/${projectId}`);
  try {
    await dbQuery(`INSERT INTO project_notes (project_id, note_text) VALUES (?, ?)`, [projectId, note_text.trim()]);
  } catch (err) { console.error('Fehler beim Speichern der Notiz:', err.message); }
  res.redirect(`/projects/${projectId}`);
});

router.post('/:id/notes/audio', audioUpload.single('audio'), async (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'Keine Audiodatei empfangen.' });
  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'metallbau-audio-notes', resource_type: 'video', format: 'webm' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    const label = (req.body.label || '').trim() || '🎙️ Sprachnotiz';
    await dbQuery(
      `INSERT INTO project_notes (project_id, note_text, audio_url) VALUES (?, ?, ?)`,
      [projectId, label, result.secure_url]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Audio-Upload Fehler:', err);
    res.status(500).json({ error: 'Upload fehlgeschlagen.' });
  }
});

router.post('/notes/delete', async (req, res) => {
  const { note_id, project_id } = req.body;
  try { await dbQuery('DELETE FROM project_notes WHERE id = ?', [note_id]); } catch (_) {}
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// AUFGABEN & MÄNGEL
// ==========================================
router.post('/:id/tasks/add', upload.single('photo'), async (req, res) => {
  const projectId = req.params.id;
  const { title, category, description, due_date, assigned_to } = req.body;
  if (!title || !title.trim()) return res.redirect(`/projects/${projectId}`);
  try {
    await dbQuery(
      `INSERT INTO project_tasks (project_id, title, description, category, status, photo_url, due_date, assigned_to) VALUES (?, ?, ?, ?, 'Offen', ?, ?, ?)`,
      [projectId, title.trim(), description ? description.trim() : null, category || 'Restarbeit', req.file ? req.file.path : null, due_date || null, assigned_to || null]
    );
  } catch (err) { console.error('Fehler beim Speichern der Aufgabe:', err.message); }
  res.redirect(`/projects/${projectId}`);
});

router.post('/tasks/status', async (req, res) => {
  const { task_id, project_id, status } = req.body;
  try { await dbQuery('UPDATE project_tasks SET status = ? WHERE id = ?', [status, task_id]); } catch (_) {}
  res.redirect(`/projects/${project_id}`);
});

router.post('/tasks/delete', async (req, res) => {
  const { task_id, project_id } = req.body;
  try { await dbQuery('DELETE FROM project_tasks WHERE id = ?', [task_id]); } catch (_) {}
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// DATEIEN HOCHLADEN / LÖSCHEN
// ==========================================
router.post('/:id/upload', upload.single('file'), async (req, res) => {
  const projectId = req.params.id;
  if (!req.file) return res.redirect(`/projects/${projectId}`);
  try {
    await dbQuery(
      `INSERT INTO project_files (project_id, filename, original_name, file_type, file_url) VALUES (?, ?, ?, ?, ?)`,
      [projectId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.path]
    );
  } catch (err) { console.error('Fehler beim Upload:', err.message); }
  res.redirect(`/projects/${projectId}`);
});

router.post('/files/delete', async (req, res) => {
  const { file_id, project_id } = req.body;
  try { await dbQuery('DELETE FROM project_files WHERE id = ?', [file_id]); } catch (_) {}
  res.redirect(`/projects/${project_id}`);
});

// ==========================================
// GEO-FENCING KOORDINATEN SETZEN
// ==========================================
router.post('/:id/set-location', async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).send('Zugriff verweigert');
  const { id } = req.params;
  const { site_lat, site_lng, site_radius, site_note } = req.body;
  try {
    await dbQuery(
      'UPDATE projects SET site_lat = ?, site_lng = ?, site_radius = ?, site_note = ? WHERE id = ?',
      [
        site_lat && site_lat !== '' ? parseFloat(site_lat)   : null,
        site_lng && site_lng !== '' ? parseFloat(site_lng)   : null,
        parseInt(site_radius || '200', 10),
        site_note && site_note.trim() !== '' ? site_note.trim() : null,
        id
      ]
    );
  } catch (err) { console.error('Fehler beim Speichern der Baustellenkoordinaten:', err.message); }
  res.redirect(`/projects/${id}`);
});

// ==========================================
// LIEFERSCHEIN / STUNDENNACHWEIS PDF
// ==========================================
router.get('/:id/pdf', async (req, res) => {
  const { id } = req.params;
  try {
    if (!PDFKit) return res.status(500).send('PDFKit nicht geladen.');

    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person,
             customers.street, customers.zip, customers.city, customers.phone, customers.email
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).send('Auftrag nicht gefunden');

    const firma = await getFirma();

    const tsColPdf = isPg
      ? `TO_CHAR(tl.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')`
      : `strftime('%Y-%m-%d %H:%M:%S', tl.timestamp)`;
    const logsRes = await dbQuery(`
      SELECT tl.*, u.username, ${tsColPdf} as local_ts
      FROM time_logs tl JOIN users u ON tl.user_id = u.id
      WHERE tl.customer_id = ?
      ORDER BY tl.timestamp ASC`, [project.customer_id || -1]);

    const measRes  = await dbQuery('SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at ASC', [id]);
    const tasksRes = await dbQuery('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at ASC', [id]);
    const notesRes = await dbQuery('SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC', [id]);

    const logRows = (logsRes.rows || []).map(l => ({ ...l, ts: l.local_ts || String(l.timestamp) }));
    let totalWorkedMs = 0;
    for (let i = 0; i < logRows.length; i++) {
      if (logRows[i].type !== 'IN') continue;
      const next = logRows[i + 1];
      if (next && next.type === 'OUT') {
        const s = new Date(logRows[i].ts.replace(' ', 'T')).getTime();
        const e = new Date(next.ts.replace(' ', 'T')).getTime();
        if (e > s) totalWorkedMs += (e - s);
      }
    }
    const totalHours = (totalWorkedMs / 3600000).toFixed(2);

    const doc      = new PDFKit({ margin: 50, size: 'A4' });
    const safeTitle = project.title.replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '_').slice(0, 60);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=Lieferschein_${safeTitle}.pdf`);
    doc.pipe(res);

    const L = 50, W = 495;
    const today = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#1e293b').text(firma.name.toUpperCase(), L, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(firma.slogan, L, 74);
    doc.moveTo(L, 88).lineTo(L + W, 88).lineWidth(1.5).strokeColor('#3b82f6').stroke();

    doc.rect(360, 50, 185, 60).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#64748b').text('AUFTRAGS-NR.', 368, 56);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e293b').text(`#${project.id}`, 368, 67);
    doc.fontSize(8).font('Helvetica').fillColor('#64748b').text(`Erstellt: ${today}`, 368, 84);
    doc.text(`Status: ${project.status}`, 368, 94);

    let y = 110;
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e293b').text(project.title, L, y);
    y += 20;
    const customer = project.company_name || project.contact_person || '–';
    const addr = [project.street, [project.zip, project.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    doc.fontSize(9).font('Helvetica').fillColor('#475569');
    doc.text(`Kunde:  ${customer}`, L, y);
    if (addr) { y += 13; doc.text(`Adresse:  ${addr}`, L, y); }
    if (project.description) { y += 13; doc.text(`Beschreibung:  ${project.description}`, L, y, { width: W }); }
    y += 20;

    const boxW = 140;
    doc.rect(L, y, boxW, 38).lineWidth(0.5).strokeColor('#cbd5e1').fillAndStroke('#f0fdf4', '#cbd5e1');
    doc.fontSize(8).font('Helvetica').fillColor('#166534').text('Geleistete Stunden', L + 8, y + 6);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#166534').text(`${totalHours} Std.`, L + 8, y + 17);
    doc.rect(L + boxW + 10, y, boxW, 38).lineWidth(0.5).strokeColor('#cbd5e1').fillAndStroke('#eff6ff', '#cbd5e1');
    doc.fontSize(8).font('Helvetica').fillColor('#1d4ed8').text('Aufmaß-Positionen', L + boxW + 18, y + 6);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#1d4ed8').text(`${measRes.rows.length}`, L + boxW + 18, y + 17);
    doc.rect(L + (boxW + 10) * 2, y, boxW, 38).lineWidth(0.5).strokeColor('#cbd5e1').fillAndStroke('#fefce8', '#cbd5e1');
    doc.fontSize(8).font('Helvetica').fillColor('#854d0e').text('Aufgaben / Mängel', L + (boxW + 10) * 2 + 8, y + 6);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#854d0e').text(`${tasksRes.rows.length}`, L + (boxW + 10) * 2 + 8, y + 17);
    y += 55;

    function sectionHeader(title, yPos) {
      doc.rect(L, yPos, W, 16).fillColor('#1e293b').fill();
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff').text(title.toUpperCase(), L + 6, yPos + 4);
      return yPos + 20;
    }
    function checkPage(neededHeight) {
      if (doc.y + neededHeight > 780) { doc.addPage(); return 50; }
      return doc.y;
    }
    function tableRow(cols, widths, startY, isHeader) {
      let x = L;
      doc.fontSize(8).font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fillColor(isHeader ? '#475569' : '#1e293b');
      cols.forEach((text, i) => {
        doc.text(String(text ?? '–'), x + 3, startY + 3, { width: widths[i] - 6, lineBreak: false });
        x += widths[i];
      });
      doc.moveTo(L, startY + 14).lineTo(L + W, startY + 14).lineWidth(0.3).strokeColor(isHeader ? '#94a3b8' : '#e2e8f0').stroke();
      return startY + 16;
    }

    doc.y = y;
    y = checkPage(60);
    y = sectionHeader('1. Arbeitsstunden-Nachweis', y);
    const colW1 = [110, 90, 90, 85, 120];
    y = tableRow(['Datum', 'Uhrzeit', 'Typ', 'Mitarbeiter', 'Notiz'], colW1, y, true);
    if (logRows.length === 0) {
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8').text('Keine Stempelzeiten erfasst.', L + 3, y + 3); y += 20;
    } else {
      logRows.forEach(log => {
        y = checkPage(20);
        const ts = log.ts || '';
        y = tableRow([ts.substring(0, 10).split('-').reverse().join('.'), ts.substring(11, 16) + ' Uhr', log.type === 'IN' ? '▶ Kommen' : '◀ Gehen', log.username || '–', log.note || '–'], colW1, y, false);
      });
    }
    y = checkPage(24);
    doc.rect(L, y, W, 18).fillColor('#f8fafc').fill();
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e293b').text(`Gesamt geleistete Stunden: ${totalHours} Std.`, L + 6, y + 5);
    y += 24;

    y = checkPage(40); y += 8;
    y = sectionHeader('2. Digitales Aufmaß', y);
    const colW2 = [150, 70, 80, 55, 55, 85];
    y = tableRow(['Bauteil / Element', 'Breite (mm)', 'Höhe / Länge (mm)', 'Winkel', 'Anz.', 'Bemerkung'], colW2, y, true);
    if (measRes.rows.length === 0) {
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8').text('Keine Aufmaße erfasst.', L + 3, y + 3); y += 20;
    } else {
      measRes.rows.forEach(m => {
        y = checkPage(20);
        y = tableRow([m.component_name, m.width ? m.width + ' mm' : '–', m.height ? m.height + ' mm' : '–', m.angle ? m.angle + '°' : '–', m.quantity || 1, m.note || '–'], colW2, y, false);
      });
    }

    y = checkPage(40); y += 8;
    y = sectionHeader('3. Aufgaben & Mängel', y);
    const colW3 = [155, 80, 65, W - 155 - 80 - 65];
    y = tableRow(['Titel', 'Kategorie', 'Status', 'Beschreibung'], colW3, y, true);
    if (tasksRes.rows.length === 0) {
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8').text('Keine Aufgaben erfasst.', L + 3, y + 3); y += 20;
    } else {
      tasksRes.rows.forEach(t => { y = checkPage(20); y = tableRow([t.title, t.category || '–', t.status || '–', t.description || '–'], colW3, y, false); });
    }

    if (notesRes.rows.length > 0) {
      y = checkPage(40); y += 8;
      y = sectionHeader('4. Baustellen-Notizen', y);
      notesRes.rows.forEach(n => {
        y = checkPage(30);
        doc.fontSize(8).font('Helvetica').fillColor('#475569').text(new Date(n.created_at).toLocaleDateString('de-DE') + '  ', L + 3, y + 2, { continued: true, width: 60 });
        doc.font('Helvetica').fillColor('#1e293b').text(n.note_text, { width: W - 70 });
        y = doc.y + 4;
        doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.3).strokeColor('#e2e8f0').stroke(); y += 4;
      });
    }

    const range = doc.bufferedPageRange ? doc.bufferedPageRange() : null;
    if (range) {
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.moveTo(L, 820).lineTo(L + W, 820).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
        doc.fontSize(7).font('Helvetica').fillColor('#94a3b8').text(
          `${firma.nameKurz} · Auftrag #${project.id} · ${project.title} · Seite ${i + 1} von ${range.count} · Erstellt: ${today}`,
          L, 826, { width: W, align: 'center' }
        );
      }
    }
    doc.end();
  } catch (err) {
    console.error('Fehler beim Erzeugen des Lieferschein-PDF:', err.message);
    res.status(500).send('Fehler beim Erstellen des PDF.');
  }
});

// ==========================================
// RECHNUNG AUS AUFTRAG ERSTELLEN
// ==========================================
router.get('/:id/create-invoice', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person,
             customers.email, customers.phone, customers.street, customers.zip, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).send('Projekt nicht gefunden');

    const hoursRes = await (isPg
      ? dbQuery(`
          SELECT users.username,
                 SUM(CASE WHEN tl_in.type = 'IN' THEN EXTRACT(EPOCH FROM (tl_out.ts - tl_in.timestamp)) / 3600 ELSE 0 END) AS hours
          FROM time_logs tl_in
          JOIN users ON tl_in.user_id = users.id
          LEFT JOIN LATERAL (
            SELECT timestamp AS ts FROM time_logs
            WHERE user_id = tl_in.user_id AND project_id = tl_in.project_id
              AND type = 'OUT' AND timestamp > tl_in.timestamp
            ORDER BY timestamp ASC LIMIT 1
          ) tl_out ON true
          WHERE tl_in.project_id = $1 AND tl_in.type = 'IN'
          GROUP BY users.username
        `, [id])
      : dbQuery(`
          SELECT u.username,
                 SUM(
                   CASE WHEN tl_in.type = 'IN' THEN
                     (JULIANDAY((
                       SELECT tl_out.timestamp FROM time_logs tl_out
                       WHERE tl_out.user_id = tl_in.user_id
                         AND tl_out.project_id = tl_in.project_id
                         AND tl_out.type = 'OUT'
                         AND tl_out.timestamp > tl_in.timestamp
                       ORDER BY tl_out.timestamp ASC LIMIT 1
                     )) - JULIANDAY(tl_in.timestamp)) * 24
                   ELSE 0 END
                 ) AS hours
          FROM time_logs tl_in
          JOIN users u ON tl_in.user_id = u.id
          WHERE tl_in.project_id = ? AND tl_in.type = 'IN'
          GROUP BY u.username
        `, [id])
    ).catch(() => ({ rows: [] }));

    let hourRows = (hoursRes.rows || [])
      .filter(r => parseFloat(r.hours) > 0)
      .map(r => ({ ...r, hours: Math.round(parseFloat(r.hours) * 100) / 100 }));

    const invoiceNumber = 'RE-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
    res.render('project-invoice-create', { project, hourRows, invoiceNumber });
  } catch (err) {
    console.error('Fehler bei Rechnungsvorschau:', err.message);
    res.status(500).send('Fehler beim Laden der Rechnungsvorschau');
  }
});

router.post('/:id/create-invoice', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { invoice_number, due_days, description, quantity, unit, price } = req.body;

  const descs  = Array.isArray(description) ? description : (description ? [description] : []);
  const qtys   = Array.isArray(quantity)    ? quantity    : (quantity    ? [quantity]    : []);
  const units  = Array.isArray(unit)        ? unit        : (unit        ? [unit]        : []);
  const prices = Array.isArray(price)       ? price       : (price       ? [price]       : []);

  const itemsToInsert = [];
  let totalAmount = 0;
  for (let i = 0; i < descs.length; i++) {
    if (!descs[i] || descs[i].trim() === '') continue;
    const qty = parseFloat(String(qtys[i]   || '1').replace(',', '.')) || 1;
    const prc = parseFloat(String(prices[i] || '0').replace(',', '.')) || 0;
    totalAmount += qty * prc;
    itemsToInsert.push({ description: descs[i].trim(), quantity: qty, unit: units[i] || 'Psch', price: prc });
  }

  const _firma  = await getFirma();
  const days    = parseInt(due_days || String(_firma.zahlungsfrist), 10);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + days);

  try {
    const projRes    = await dbQuery('SELECT customer_id FROM projects WHERE id = ?', [id]);
    const customerId = projRes.rows[0]?.customer_id || null;
    const invRes     = await dbQuery(
      `INSERT INTO invoices (invoice_number, customer_id, total_amount, status, due_date) VALUES (?, ?, ?, 'Gesendet', ?)`,
      [invoice_number, customerId, totalAmount, dueDate.toISOString().split('T')[0]]
    );
    const invoiceId = invRes.lastID;
    for (const item of itemsToInsert) {
      await dbQuery('INSERT INTO invoice_items (invoice_id, description, quantity, unit, price) VALUES (?, ?, ?, ?, ?)',
        [invoiceId, item.description, item.quantity, item.unit, item.price]);
    }
    await dbQuery("UPDATE projects SET status = 'Abgeschlossen' WHERE id = ?", [id]).catch(() => {});
    res.redirect('/documents/invoices/' + invoiceId);
  } catch (err) {
    console.error('Fehler beim Erstellen der Rechnung aus Auftrag:', err.message);
    res.status(500).send('Fehler beim Erstellen der Rechnung');
  }
});

// ==========================================
// KI-ENDPUNKTE
// ==========================================
router.post('/:id/ai-summary', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { id } = req.params;
  try {
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id WHERE projects.id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).json({ error: 'Auftrag nicht gefunden.' });

    const [notesRes, tasksRes, measRes] = await Promise.all([
      dbQuery('SELECT note_text FROM project_notes WHERE project_id = ? ORDER BY created_at ASC', [id]),
      dbQuery('SELECT title, category, status FROM project_tasks WHERE project_id = ? ORDER BY created_at ASC', [id]),
      dbQuery('SELECT component_name, width, height, quantity FROM project_measurements WHERE project_id = ? ORDER BY created_at ASC', [id])
    ]);
    const notes    = (notesRes.rows || []).map(n => `- ${n.note_text}`).join('\n') || 'Keine Notizen.';
    const tasks    = (tasksRes.rows || []).map(t => `- [${t.status}] ${t.category}: ${t.title}`).join('\n') || 'Keine Aufgaben.';
    const measures = (measRes.rows || []).map(m => `- ${m.component_name}: ${m.width || '–'}×${m.height || '–'} mm, Anzahl ${m.quantity || 1}`).join('\n') || 'Kein Aufmaß.';

    const prompt = `Du bist ein Assistent eines Metallbaubetriebs. Erstelle einen knappen deutschen Statusbericht (max. 8 Sätze) für den folgenden Auftrag.\n\nAuftrag: ${project.title}\nKunde: ${project.company_name || project.contact_person || 'Unbekannt'}\nStatus: ${project.status}\nBeschreibung: ${project.description || 'Keine.'}\n\nNotizen:\n${notes}\n\nAufgaben / Mängel:\n${tasks}\n\nAufmaß:\n${measures}\n\nSchreibe jetzt den Statusbericht:`;
    const text = await callAI(prompt);
    res.json({ summary: text });
  } catch (err) {
    console.error('KI Fehler (ai-summary):', err);
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

router.post('/:id/ai-checklist', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { id } = req.params;
  try {
    const projRes = await dbQuery(`SELECT title, description, status FROM projects WHERE id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).json({ error: 'Auftrag nicht gefunden.' });

    const prompt = `Du bist ein erfahrener Metallbaumeister. Erstelle eine praxisnahe Aufgaben-Checkliste für den folgenden Metallbau-Auftrag.\nAntworte NUR mit einem gültigen JSON-Array (maximal 8 Einträge):\n[\n  {"title": "Aufgabe 1", "category": "Restarbeit"},\n  ...\n]\nErlaubte Kategorien: Restarbeit, Mangel, Bestellung\n\nAuftrag: ${project.title}\nBeschreibung: ${project.description || 'Keine.'}\nStatus: ${project.status}`;
    const text  = await callAI(prompt);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'KI konnte keine Checkliste erstellen.' });
    res.json({ tasks: JSON.parse(match[0]) });
  } catch (err) {
    console.error('KI Fehler (ai-checklist):', err);
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

router.post('/:id/generate-quote', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { id } = req.params;
  try {
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person,
             customers.email, customers.phone, customers.street, customers.zip, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id WHERE projects.id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

    const [measurementsRes, notesRes] = await Promise.all([
      dbQuery('SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at ASC', [id]),
      dbQuery('SELECT note_text FROM project_notes WHERE project_id = ? ORDER BY created_at ASC', [id])
    ]);
    const massText    = (measurementsRes.rows || []).length > 0 ? measurementsRes.rows.map(m => `- ${m.component_name}: Breite ${m.width || '–'} mm, Höhe/Länge ${m.height || '–'} mm${m.angle ? ', Winkel ' + m.angle + '°' : ''}, Anzahl: ${m.quantity || 1}${m.note ? ', Bemerkung: ' + m.note : ''}`).join('\n') : 'Keine Maße erfasst.';
    const notizenText = (notesRes.rows || []).length > 0 ? notesRes.rows.map(n => `- ${n.note_text}`).join('\n') : 'Keine Notizen vorhanden.';

    const firma = await getFirma();
    const prompt = `Du bist ein professioneller Angebotsschreiber für den Metallbaubetrieb "${firma.name}", ${firma.strasse}, ${firma.plzOrt}.\n\nErstelle auf Basis der folgenden Projektdaten ein formelles, professionelles Angebot in deutscher Sprache.\n\n**Projektdaten:**\n- Projekttitel: ${project.title}\n- Beschreibung: ${project.description || 'Keine.'}\n- Status: ${project.status}\n- Kunde: ${project.company_name || project.contact_person || 'Unbekannt'}\n\n**Erfasste Maße:**\n${massText}\n\n**Projektnotizen:**\n${notizenText}\n\nErstelle jetzt das Angebot:`.trim();
    const text = await callAI(prompt);
    res.json({ quote: text });
  } catch (err) {
    console.error('KI Fehler (generate-quote):', err);
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

// Route: KI-Angebot mit Bildanalyse (Vision)
router.post('/:id/generate-quote-with-images', imageUpload.array('images', 3), async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert.' });
  const { id } = req.params;
  try {
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person,
             customers.email, customers.phone, customers.street, customers.zip, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id WHERE projects.id = ?`, [id]);
    const project = projRes.rows[0];
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });

    const [measurementsRes, notesRes] = await Promise.all([
      dbQuery('SELECT * FROM project_measurements WHERE project_id = ? ORDER BY created_at ASC', [id]),
      dbQuery('SELECT note_text FROM project_notes WHERE project_id = ? ORDER BY created_at ASC', [id])
    ]);
    const massText    = (measurementsRes.rows || []).length > 0
      ? measurementsRes.rows.map(m => `- ${m.component_name}: Breite ${m.width || '–'} mm, Höhe/Länge ${m.height || '–'} mm${m.angle ? ', Winkel ' + m.angle + '°' : ''}, Anzahl: ${m.quantity || 1}${m.note ? ', Bemerkung: ' + m.note : ''}`).join('\n')
      : 'Keine Maße erfasst.';
    const notizenText = (notesRes.rows || []).length > 0
      ? notesRes.rows.map(n => `- ${n.note_text}`).join('\n')
      : 'Keine Notizen vorhanden.';

    const imageBuffers = (req.files || []).map(f => ({ buffer: f.buffer, mimetype: f.mimetype }));

    const bildHinweis = imageBuffers.length > 0
      ? `\n\nZusätzlich wurden ${imageBuffers.length} Foto(s) hochgeladen. Analysiere diese Bilder und extrahiere daraus relevante Informationen (z.B. sichtbare Maße, Materialien, Bauzustand, Beschädigungen, Konstruktionsdetails) und fließe diese Erkenntnisse in das Angebot ein.`
      : '';

    const firma = await getFirma();
    const prompt = `Du bist ein professioneller Angebotsschreiber für den Metallbaubetrieb "${firma.name}", ${firma.strasse}, ${firma.plzOrt}.\n\nErstelle auf Basis der folgenden Projektdaten ein formelles, professionelles Angebot in deutscher Sprache.\n\n**Projektdaten:**\n- Projekttitel: ${project.title}\n- Beschreibung: ${project.description || 'Keine.'}\n- Status: ${project.status}\n- Kunde: ${project.company_name || project.contact_person || 'Unbekannt'}\n\n**Erfasste Maße:**\n${massText}\n\n**Projektnotizen:**\n${notizenText}${bildHinweis}\n\nErstelle jetzt das Angebot:`.trim();

    const text = imageBuffers.length > 0
      ? await callAIWithImages(prompt, imageBuffers)
      : await callAI(prompt);

    res.json({ quote: text });
  } catch (err) {
    console.error('KI Fehler (generate-quote-with-images):', err);
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler') });
  }
});

module.exports = router;

