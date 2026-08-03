/**
 * apiRoutes.js – JSON-REST-API für die React Native Android-App
 *
 * Alle Endpunkte liefern JSON zurück.
 * Auth: Bearer-Token im Authorization-Header (JWT).
 * Der Token wird genau so wie im Cookie-Login erzeugt und ist damit
 * vollständig kompatibel mit dem bestehenden JWT_SECRET.
 */

const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { dbQuery }  = require('../utils/db');
const { JWT_SECRET } = require('../middleware/auth');

const isPg = !!process.env.DATABASE_URL;

// ── Auth-Middleware für API (Bearer-Token) ─────────────────────────────────
function apiAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════

// POST /api/v2/auth/login
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }
  try {
    const result = await dbQuery('SELECT * FROM users WHERE username = ?', [username]);
    const user   = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Ungültiger Benutzername oder Passwort' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Ungültiger Benutzername oder Passwort' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: 'Serverfehler beim Login' });
  }
});

// POST /api/v2/auth/change-password
router.post('/auth/change-password', apiAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Ungültige Passwortdaten (min. 6 Zeichen)' });
  }
  try {
    const result = await dbQuery('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const user   = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    const valid  = await bcrypt.compare(current_password, user.password_hash);
    if (!valid)  return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
    const hashed = await bcrypt.hash(new_password, 10);
    await dbQuery('UPDATE users SET password_hash = ? WHERE id = ?', [hashed, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v2/dashboard
router.get('/dashboard', apiAuth, async (req, res) => {
  const userId   = req.user.id;
  const userRole = req.user.role;

  try {
    if (userRole !== 'ADMIN') {
      // Mitarbeiter-Dashboard
      const now        = new Date();
      const curYear    = now.getFullYear();
      const curMonth   = now.getMonth();
      const monthStr   = `${curYear}-${String(curMonth + 1).padStart(2, '0')}`;
      const monthStart = `${monthStr}-01`;
      const daysInMon  = new Date(curYear, curMonth + 1, 0).getDate();
      const monthEnd   = `${monthStr}-${String(daysInMon).padStart(2, '0')}`;

      const sql = isPg
        ? `SELECT *, TO_CHAR(timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin','YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs WHERE user_id=? AND DATE(timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') BETWEEN ? AND ? ORDER BY timestamp ASC`
        : `SELECT *, strftime('%Y-%m-%d %H:%M:%S',timestamp) as local_timestamp FROM time_logs WHERE user_id=? AND date(timestamp) BETWEEN ? AND ? ORDER BY timestamp ASC`;

      const logs = (await dbQuery(sql, [userId, monthStart, monthEnd])).rows || [];

      let totalMs = 0, isStampedIn = false;
      for (let i = 0; i < logs.length; i++) {
        const t = new Date((logs[i].local_timestamp || logs[i].timestamp).replace(' ', 'T'));
        if (logs[i].type === 'IN') {
          isStampedIn = true;
          const start = t.getTime();
          const next  = logs[i + 1];
          let end;
          if (next && next.type === 'OUT') {
            isStampedIn = false;
            end = new Date((next.local_timestamp || next.timestamp).replace(' ', 'T')).getTime();
          } else if (i === logs.length - 1) { end = now.getTime(); }
          else { end = start; }
          if (end > start) totalMs += (end - start);
        } else if (logs[i].type === 'OUT') { isStampedIn = false; }
      }

      const monthTotalHours = (totalMs / 3600000).toFixed(2);
      let workdays = 0;
      for (let d = 1; d <= now.getDate(); d++) {
        const dow = new Date(curYear, curMonth, d).getDay();
        if (dow !== 0 && dow !== 6) workdays++;
      }
      const targetHours   = workdays * 8;
      const overtime      = parseFloat(monthTotalHours) - targetHours;

      const tickerRes = await dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 5');

      return res.json({
        role: 'EMPLOYEE',
        monthTotalHours: parseFloat(monthTotalHours),
        targetHours,
        overtimeHours:  parseFloat(overtime.toFixed(2)),
        isStampedIn,
        monthLabel: now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
        tickers:    tickerRes.rows || []
      });
    }

    // Chef-Dashboard
    const sqlOverdue = isPg
      ? `SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total FROM documents WHERE doc_type='INVOICE' AND status!='Bezahlt' AND due_date IS NOT NULL AND due_date!='' AND due_date::date<=CURRENT_DATE`
      : `SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total FROM documents WHERE doc_type='INVOICE' AND status!='Bezahlt' AND due_date IS NOT NULL AND due_date!='' AND due_date<=date('now')`;

    const [offerRes, invoiceRes, custRes, projRes, overdueRes, taskRes, recentRes, tickerRes] = await Promise.all([
      dbQuery(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total FROM documents WHERE doc_type='OFFER' AND status!='ANGENOMMEN' AND status!='ABGELEHNT'`),
      dbQuery(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total FROM documents WHERE doc_type='INVOICE' AND status!='Bezahlt'`),
      dbQuery(`SELECT COUNT(*) as count FROM customers`),
      dbQuery(`SELECT COUNT(*) as count FROM projects WHERE status NOT IN ('Abgeschlossen')`),
      dbQuery(sqlOverdue),
      dbQuery(`SELECT COUNT(*) as count FROM project_tasks WHERE status='Offen'`),
      dbQuery(`SELECT d.id,d.doc_number,d.doc_type,d.total_amount,d.status,c.company_name,c.contact_person FROM documents d LEFT JOIN customers c ON d.customer_id=c.id ORDER BY d.id DESC LIMIT 5`),
      dbQuery('SELECT * FROM tickers ORDER BY created_at DESC LIMIT 10')
    ]);

    res.json({
      role:                'ADMIN',
      openOffersCount:      offerRes.rows[0]?.count    ?? 0,
      openOffersSum:        parseFloat(offerRes.rows[0]?.total   || 0),
      openInvoicesCount:    invoiceRes.rows[0]?.count  ?? 0,
      openInvoicesSum:      parseFloat(invoiceRes.rows[0]?.total || 0),
      totalCustomers:       custRes.rows[0]?.count     ?? 0,
      activeProjectsCount:  projRes.rows[0]?.count     ?? 0,
      overdueInvoicesCount: overdueRes.rows[0]?.count  ?? 0,
      overdueInvoicesSum:   parseFloat(overdueRes.rows[0]?.total || 0),
      openTasksCount:       taskRes.rows[0]?.count     ?? 0,
      recentDocs: (recentRes.rows || []).map(d => ({
        ...d,
        customer_name: d.company_name || d.contact_person || 'Kein Kunde'
      })),
      tickers: tickerRes.rows || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PROJEKTE / AUFTRÄGE
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v2/projects
router.get('/projects', apiAuth, async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id
      ORDER BY projects.created_at DESC
    `);
    res.json(result.rows || []);
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// GET /api/v2/projects/:id
router.get('/projects/:id', apiAuth, async (req, res) => {
  try {
    const projRes  = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person,
             customers.phone, customers.email, customers.street, customers.zip, customers.city
      FROM projects LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.id = ?`, [req.params.id]);
    const project  = projRes.rows[0];
    if (!project) return res.status(404).json({ error: 'Auftrag nicht gefunden' });

    const [photosRes, notesRes, tasksRes, measureRes] = await Promise.all([
      dbQuery('SELECT * FROM project_photos WHERE project_id=? ORDER BY created_at DESC', [req.params.id]),
      dbQuery('SELECT * FROM project_notes WHERE project_id=? ORDER BY created_at DESC', [req.params.id]),
      dbQuery('SELECT * FROM project_tasks WHERE project_id=? ORDER BY created_at DESC', [req.params.id]),
      dbQuery('SELECT * FROM project_measurements WHERE project_id=? ORDER BY created_at ASC', [req.params.id])
    ]);

    res.json({
      ...project,
      photos:       photosRes.rows  || [],
      notes:        notesRes.rows   || [],
      tasks:        tasksRes.rows   || [],
      measurements: measureRes.rows || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// POST /api/v2/projects  (nur ADMIN)
router.post('/projects', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Zugriff verweigert' });
  const { customer_id, title, description, total_price, status } = req.body;
  if (!title) return res.status(400).json({ error: 'Titel erforderlich' });
  const parsedPrice = parseFloat(String(total_price || '0').replace(',', '.')) || 0;
  try {
    const r = await dbQuery(
      `INSERT INTO projects (customer_id, title, description, total_price, status) VALUES (?,?,?,?,?)`,
      [customer_id || null, title, description || null, parsedPrice, status || 'In Planung']
    );
    res.status(201).json({ id: r.lastID, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// PATCH /api/v2/projects/:id/status  (nur ADMIN)
router.patch('/projects/:id/status', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Zugriff verweigert' });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status fehlt' });
  try {
    await dbQuery('UPDATE projects SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/v2/projects/:id/notes
router.post('/projects/:id/notes', apiAuth, async (req, res) => {
  const { note_text } = req.body;
  if (!note_text) return res.status(400).json({ error: 'Notiztext fehlt' });
  try {
    const r = await dbQuery(
      `INSERT INTO project_notes (project_id, note_text) VALUES (?,?)`,
      [req.params.id, note_text]
    );
    res.status(201).json({ id: r.lastID, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// KUNDEN
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v2/customers
router.get('/customers', apiAuth, async (req, res) => {
  try {
    const result = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');
    res.json(result.rows || []);
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// POST /api/v2/customers  (nur ADMIN)
router.post('/customers', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Zugriff verweigert' });
  const { company_name, contact_person, email, phone, street, zip, city } = req.body;
  try {
    const r = await dbQuery(
      `INSERT INTO customers (company_name,contact_person,email,phone,street,zip,city) VALUES (?,?,?,?,?,?,?)`,
      [company_name||null,contact_person||null,email||null,phone||null,street||null,zip||null,city||null]
    );
    res.status(201).json({ id: r.lastID, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// PUT /api/v2/customers/:id  (nur ADMIN)
router.put('/customers/:id', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Zugriff verweigert' });
  const { company_name, contact_person, email, phone, street, zip, city } = req.body;
  try {
    await dbQuery(
      `UPDATE customers SET company_name=?,contact_person=?,email=?,phone=?,street=?,zip=?,city=? WHERE id=?`,
      [company_name||null,contact_person||null,email||null,phone||null,street||null,zip||null,city||null,req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ZEITERFASSUNG
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v2/timetracking
router.get('/timetracking', apiAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const sql = isPg
      ? `SELECT tl.*, c.company_name, c.contact_person, p.title as project_title, TO_CHAR(tl.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin','YYYY-MM-DD HH24:MI:SS') as local_timestamp FROM time_logs tl LEFT JOIN customers c ON tl.customer_id=c.id LEFT JOIN projects p ON tl.project_id=p.id WHERE tl.user_id=? AND DATE(tl.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')=CURRENT_DATE ORDER BY tl.timestamp ASC`
      : `SELECT tl.*, c.company_name, c.contact_person, p.title as project_title, strftime('%Y-%m-%d %H:%M:%S',tl.timestamp) as local_timestamp FROM time_logs tl LEFT JOIN customers c ON tl.customer_id=c.id LEFT JOIN projects p ON tl.project_id=p.id WHERE tl.user_id=? AND date(tl.timestamp)=date('now') ORDER BY tl.timestamp ASC`;

    const logs      = (await dbQuery(sql, [userId])).rows || [];
    const lastLog   = logs.length > 0 ? logs[logs.length - 1] : null;
    const isStampedIn = lastLog && lastLog.type === 'IN';

    const now = new Date();
    let totalMs = 0;
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].type !== 'IN' || !logs[i].local_timestamp) continue;
      const start = new Date(logs[i].local_timestamp.replace(' ', 'T')).getTime();
      const next  = logs[i + 1];
      let end;
      if (next && next.type === 'OUT' && next.local_timestamp) {
        end = new Date(next.local_timestamp.replace(' ', 'T')).getTime();
      } else if (i === logs.length - 1 && isStampedIn) {
        end = now.getTime();
      } else { end = start; }
      if (end > start) totalMs += (end - start);
    }

    const projRes = await dbQuery(`SELECT id,title,status,site_lat,site_lng,site_radius FROM projects WHERE status!='Abgeschlossen' ORDER BY title ASC`);

    res.json({
      isStampedIn,
      todayTotalHours: parseFloat((totalMs / 3600000).toFixed(2)),
      activeProjectId:    isStampedIn ? lastLog?.project_id    : null,
      activeProjectTitle: isStampedIn ? lastLog?.project_title : null,
      todayLogs: logs.map(l => ({
        ...l,
        display_time: l.local_timestamp ? l.local_timestamp.split(' ')[1]?.substring(0, 5) : ''
      })),
      projects: projRes.rows || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// POST /api/v2/timetracking/stamp
router.post('/timetracking/stamp', apiAuth, async (req, res) => {
  const userId   = req.user.id;
  const userRole = req.user.role;
  let { type, note, project_id, latitude, longitude } = req.body;

  if (!['IN', 'OUT', 'SWITCH'].includes(type)) {
    return res.status(400).json({ error: 'Ungültiger Typ (IN/OUT/SWITCH)' });
  }

  function dist(lat1, lon1, lat2, lon2) {
    const R = 6371e3, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  try {
    if (type === 'SWITCH') {
      const tsE = isPg ? 'NOW()' : 'CURRENT_TIMESTAMP';
      await dbQuery(`INSERT INTO time_logs (user_id,type,note,latitude,longitude,timestamp) VALUES (?,\'OUT\',?,?,?,${tsE})`,
        [userId, 'Baustelle gewechselt', latitude||null, longitude||null]);
      type = 'IN';
    }

    if (type === 'IN' && userRole !== 'ADMIN') {
      if (!latitude || !longitude) {
        return res.status(400).json({ error: 'GPS-Standort ist erforderlich zum Einstempeln.' });
      }
      const lat = parseFloat(latitude), lng = parseFloat(longitude);
      const FIRM_LAT    = parseFloat(process.env.FIRM_LAT    || '51.3069467');
      const FIRM_LNG    = parseFloat(process.env.FIRM_LNG    || '6.9483845');
      const FIRM_RADIUS = parseInt(process.env.FIRM_RADIUS_METERS || '300', 10);
      const distFirm    = dist(lat, lng, FIRM_LAT, FIRM_LNG);
      let   atSite      = distFirm <= FIRM_RADIUS;
      if (!atSite) {
        const sites = (await dbQuery(`SELECT site_lat,site_lng,site_radius FROM projects WHERE site_lat IS NOT NULL AND site_lng IS NOT NULL AND status!='Abgeschlossen'`)).rows || [];
        for (const s of sites) {
          if (dist(lat, lng, parseFloat(s.site_lat), parseFloat(s.site_lng)) <= (s.site_radius || 200)) {
            atSite = true; break;
          }
        }
      }
      if (!atSite) return res.status(400).json({ error: `Einstempeln verweigert: ca. ${Math.round(distFirm)} m von der Firma entfernt.` });
    }

    let assignedProjectId  = project_id ? parseInt(project_id, 10) : null;
    let assignedCustomerId = null;
    if (assignedProjectId) {
      const pRes = await dbQuery('SELECT customer_id FROM projects WHERE id=?', [assignedProjectId]);
      assignedCustomerId = pRes.rows[0]?.customer_id || null;
    }

    const tsE = isPg ? 'NOW()' : 'CURRENT_TIMESTAMP';
    await dbQuery(
      `INSERT INTO time_logs (user_id,type,note,project_id,customer_id,latitude,longitude,timestamp) VALUES (?,?,?,?,?,?,?,${tsE})`,
      [userId, type, note||null, assignedProjectId, assignedCustomerId, latitude||null, longitude||null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Stempeln: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// KALENDER / TERMINE
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v2/appointments
router.get('/appointments', apiAuth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const isAdmin = req.user.role === 'ADMIN';
    const rows = (await dbQuery(`
      SELECT a.id, a.title, a.start_date, a.end_date, a.description,
             c.company_name, c.contact_person
      FROM appointments a
      LEFT JOIN customers c ON a.customer_id = c.id
      ORDER BY a.start_date ASC
    `)).rows || [];

    if (isAdmin) return res.json(rows);

    // Mitarbeiter sieht nur eigene oder nicht zugewiesene Termine
    const assignedRes = await dbQuery(
      `SELECT appointment_id FROM appointment_users WHERE user_id = ?`, [userId]
    );
    const mine = new Set((assignedRes.rows || []).map(r => r.appointment_id));
    const allAssignedIds = new Set(
      (await dbQuery(`SELECT DISTINCT appointment_id FROM appointment_users`)).rows.map(r => r.appointment_id)
    );
    res.json(rows.filter(a => mine.has(a.id) || !allAssignedIds.has(a.id)));
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// URLAUB / ABWESENHEIT
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v2/vacations
router.get('/vacations', apiAuth, async (req, res) => {
  const userId  = req.user.id;
  const isAdmin = req.user.role === 'ADMIN';
  try {
    const sql = isAdmin
      ? `SELECT v.*, u.username FROM vacations v LEFT JOIN users u ON v.user_id=u.id ORDER BY v.start_date DESC`
      : `SELECT * FROM vacations WHERE user_id=? ORDER BY start_date DESC`;
    const params = isAdmin ? [] : [userId];
    const rows   = (await dbQuery(sql, params)).rows || [];

    // Resturlaub (eigener)
    const allowRes = await dbQuery('SELECT vacation_allowance FROM users WHERE id=?', [userId]);
    const allowance = allowRes.rows[0]?.vacation_allowance ?? 30;
    const taken = rows.filter(v =>
      v.user_id === userId && v.type === 'Urlaub' && v.status === 'Genehmigt'
    ).reduce((acc, v) => {
      const s = new Date(v.start_date), e = new Date(v.end_date);
      let days = 0;
      for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) days++;
      }
      return acc + days;
    }, 0);

    res.json({ vacations: rows, remaining: allowance - taken, allowance });
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// POST /api/v2/vacations
router.post('/vacations', apiAuth, async (req, res) => {
  const { start_date, end_date, reason, type } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'Start- und Enddatum erforderlich' });
  try {
    const r = await dbQuery(
      `INSERT INTO vacations (user_id,start_date,end_date,reason,type,status) VALUES (?,?,?,?,?,?)`,
      [req.user.id, start_date, end_date, reason||null, type||'Urlaub', 'Beantragt']
    );
    res.status(201).json({ id: r.lastID, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Beantragen' });
  }
});

// PATCH /api/v2/vacations/:id/status  (nur ADMIN)
router.patch('/vacations/:id/status', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Zugriff verweigert' });
  const { status } = req.body;
  if (!['Genehmigt', 'Abgelehnt'].includes(status)) return res.status(400).json({ error: 'Ungültiger Status' });
  try {
    await dbQuery('UPDATE vacations SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// FOTO-UPLOAD (Cloudinary) für Projekt-Fotos
// ═══════════════════════════════════════════════════════════════════════
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const photoUpload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'metallbau-management', allowed_formats: ['jpg', 'jpeg', 'png', 'webp'] }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// POST /api/v2/projects/:id/photos
router.post('/projects/:id/photos', apiAuth, photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Foto übermittelt.' });
  try {
    const r = await dbQuery(
      `INSERT INTO project_photos (project_id, file_url, original_name) VALUES (?,?,?)`,
      [req.params.id, req.file.path, req.file.originalname || 'foto.jpg']
    );
    res.status(201).json({ id: r.lastID, url: req.file.path, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Speichern des Fotos' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// KI-ASSISTENT (Text + Bildanalyse) – leitet an bestehende /api/ai/* weiter
// ═══════════════════════════════════════════════════════════════════════

// POST /api/v2/ai/chat  → Text-KI
router.post('/ai/chat', apiAuth, async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'Keine Nachricht.' });
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'KI nicht konfiguriert.' });

  const { getFirma } = require('../utils/companySettings');
  const firma = await getFirma();
  const systemPrompt = `Du bist ein KI-Assistent für den Metallbaubetrieb "${firma.name}". Antworte immer auf Deutsch und sei hilfreich bei allen Metallbau-Themen: Aufmaß, Angebote, Materialien, Technik, Planung.`;

  try {
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.APP_URL || 'https://metallbau-gehrmann.onrender.com',
        'X-Title': 'Metallbau App'
      },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages: [
          { role: 'system', content: systemPrompt },
          ...(context || []),
          { role: 'user', content: message }
        ],
        temperature: 0.7
      })
    });
    const data = await aiRes.json();
    if (!aiRes.ok) throw new Error(JSON.stringify(data));
    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: 'KI-Anfrage fehlgeschlagen: ' + (err.message || '') });
  }
});

// POST /api/v2/ai/image  → Bildanalyse (Base64)
const imageUploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

router.post('/ai/image', apiAuth, imageUploadMemory.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Bild übermittelt.' });
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'KI nicht konfiguriert.' });

  const b64      = req.file.buffer.toString('base64');
  const mimeType = req.file.mimetype;
  const { getFirma } = require('../utils/companySettings');
  const firma = await getFirma();

  const systemPrompt = `Du bist ein KI-Assistent für den Metallbaubetrieb "${firma.name}". Analysiere das Bild und erkenne alle sichtbaren Metallbau-Leistungen, Materialien, Maße oder Bauteile. Antworte auf Deutsch.`;
  const VISION_MODELS = [
    'google/gemma-4-26b-a4b-it:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-nano-12b-v2-vl:free'
  ];

  let lastError;
  for (const model of VISION_MODELS) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': process.env.APP_URL || 'https://metallbau-gehrmann.onrender.com',
          'X-Title': 'Metallbau App'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: systemPrompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
          ]}],
          temperature: 0.7
        })
      });
      const data = await r.json();
      if (!r.ok) { lastError = data; continue; }
      return res.json({ reply: data.choices[0].message.content });
    } catch (err) { lastError = err; }
  }
  res.status(500).json({ error: 'KI-Bildanalyse fehlgeschlagen.' });
});

// ═══════════════════════════════════════════════════════════════════════
// DOKUMENTE (Angebote & Rechnungen) – Liste für App
// ═══════════════════════════════════════════════════════════════════════

// GET /api/v2/documents?type=OFFER|INVOICE
router.get('/documents', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Nur für Admins.' });
  const type = req.query.type; // OFFER oder INVOICE
  const sql  = type
    ? `SELECT d.*,c.company_name,c.contact_person FROM documents d LEFT JOIN customers c ON d.customer_id=c.id WHERE d.doc_type=? ORDER BY d.id DESC LIMIT 50`
    : `SELECT d.*,c.company_name,c.contact_person FROM documents d LEFT JOIN customers c ON d.customer_id=c.id ORDER BY d.id DESC LIMIT 50`;
  try {
    const result = await dbQuery(sql, type ? [type] : []);
    res.json(result.rows || []);
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// GET /api/v2/documents/:id  – Detail mit Positionen
router.get('/documents/:id', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Nur für Admins.' });
  try {
    const docRes   = await dbQuery(`SELECT d.*,c.company_name,c.contact_person,c.street,c.zip,c.city,c.email,c.phone FROM documents d LEFT JOIN customers c ON d.customer_id=c.id WHERE d.id=?`, [req.params.id]);
    const doc      = docRes.rows[0];
    if (!doc) return res.status(404).json({ error: 'Dokument nicht gefunden' });
    const itemsRes = await dbQuery(`SELECT * FROM document_items WHERE document_id=? ORDER BY id ASC`, [req.params.id]);
    res.json({ ...doc, items: itemsRes.rows || [] });
  } catch (err) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// PATCH /api/v2/documents/:id/status  (nur ADMIN)
router.patch('/documents/:id/status', apiAuth, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Zugriff verweigert' });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status fehlt' });
  try {
    await dbQuery('UPDATE documents SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
