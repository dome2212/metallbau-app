const express = require('express');
const router  = express.Router();
const https   = require('https');
const { dbQuery }        = require('../utils/db');
const { sendWhatsApp }   = require('../utils/notifier');
const { sendPush }       = require('../utils/webpush');
const { getNRWHolidays, isNRWHoliday } = require('../utils/holidays');
const { hasPerm, requireAdmin } = require('../middleware/auth');
const { getFirma }       = require('../utils/companySettings');

const isPg = !!process.env.DATABASE_URL;

// ── Urlaubskalender-Daten für Monatsansicht ───────────────────────────────────
function buildCalendar(yearMonth, vacations, users) {
  const [yyyy, mm] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(yyyy, mm, 0).getDate();
  const today       = new Date().toISOString().slice(0, 10);
  const WEEKDAYS    = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

  const calDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date    = new Date(yyyy, mm - 1, d);
    const dateStr = `${yyyy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    calDays.push({
      d,
      dateStr,
      weekday:   WEEKDAYS[date.getDay()],
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
      isHoliday: isNRWHoliday(date),
      isToday:   dateStr === today,
    });
  }

  const calCells = {};
  for (const v of vacations) {
    const start = new Date(v.start_date);
    const end   = new Date(v.end_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      if (ds.slice(0, 7) !== yearMonth) continue;
      calCells[`${v.user_id}_${ds}`] = { type: v.type, status: v.status };
    }
  }

  const todayAbsent = [];
  for (const v of vacations) {
    if (v.start_date <= today && v.end_date >= today &&
        (v.status === 'Genehmigt' || v.status === 'Beantragt')) {
      const user = users.find(u => u.id === v.user_id);
      if (user) todayAbsent.push({ username: user.username, type: v.type });
    }
  }

  const prevDate     = new Date(yyyy, mm - 2, 1);
  const nextDate     = new Date(yyyy, mm, 1);
  const pad          = n => String(n).padStart(2, '0');
  const calPrevMonth = `${prevDate.getFullYear()}-${pad(prevDate.getMonth() + 1)}`;
  const calNextMonth = `${nextDate.getFullYear()}-${pad(nextDate.getMonth() + 1)}`;
  const calMonthLabel = new Date(yyyy, mm - 1, 1)
    .toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  return { calDays, calCells, calPrevMonth, calNextMonth, calMonthLabel, todayAbsent, calUsers: users };
}

const FIRM_LAT = parseFloat(process.env.FIRM_LAT || '51.3069467');
const FIRM_LNG = parseFloat(process.env.FIRM_LNG || '6.9483845');

function wmoCodeToText(code) {
  if (code === 0)  return 'Klar';
  if (code <= 3)   return 'Bewölkt';
  if (code <= 9)   return 'Nebelfelder';
  if (code <= 19)  return 'Niederschlag';
  if (code <= 29)  return 'Gewitter (Nähe)';
  if (code <= 39)  return 'Staubnebel';
  if (code <= 49)  return 'Nebel';
  if (code <= 59)  return 'Nieselregen';
  if (code <= 69)  return 'Regen';
  if (code <= 79)  return 'Schnee / Graupel';
  if (code <= 84)  return 'Schauer';
  if (code <= 94)  return 'Gewitter';
  return 'Heftiger Sturm';
}

function fetchWeather(lat, lng, dateStr) {
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
          resolve({
            windspeed: Math.round(d.windspeed_10m_max[0] || 0),
            windgusts: Math.round(windgusts),
            precipitation: Math.round(precip * 10) / 10,
            weathercode: wcode,
            weatherText: wmoCodeToText(wcode),
            warningLevel
          });
        } catch (_) { resolve(null); }
      });
      resp.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

// ==========================================
// KALENDER-ANSICHT
// Admin sieht alle Mitarbeiter für Zuweisung
// ==========================================
router.get('/calendar', async (req, res) => {
  const firma = await getFirma();
  if (!hasPerm(req.user, 'calendar', firma, true, true)) {
    return res.status(403).send('<h1>403 – Zugriff verweigert</h1><a href="/">← Zurück</a>');
  }
  try {
    const [customersRes, usersRes, allVacRes, projectsRes] = await Promise.all([
      dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC'),
      dbQuery('SELECT id, username FROM users ORDER BY username ASC'),
      dbQuery('SELECT id, user_id, type, status, start_date, end_date FROM vacations ORDER BY start_date ASC'),
      dbQuery(`SELECT id, title, customer_id FROM projects WHERE status NOT IN ('Abgeschlossen') ORDER BY title ASC`)
    ]);
    const calMonth = req.query.cal_month || new Date().toISOString().slice(0, 7);
    const cal = buildCalendar(calMonth, allVacRes.rows || [], usersRes.rows || []);

    res.render('calendar', {
      customers:   customersRes.rows || [],
      users:       usersRes.rows     || [],
      projects:    projectsRes.rows  || [],
      currentUser: req.user,
      ...cal,
    });
  } catch (err) {
    res.status(500).send('Datenbankfehler');
  }
});

// ==========================================
// WETTER-API
// ==========================================
router.get('/api/weather', async (req, res) => {
  const { lat, lng, date } = req.query;
  if (!lat || !lng || !date) return res.status(400).json({ error: 'lat, lng und date erforderlich' });
  try {
    const weather = await fetchWeather(parseFloat(lat), parseFloat(lng), date);
    if (!weather) return res.json({ available: false });
    res.json({ available: true, ...weather });
  } catch (_) {
    res.status(500).json({ error: 'Wetterdaten nicht abrufbar' });
  }
});

// ==========================================
// FEIERTAGE NRW (Hintergrund-Events für Kalender)
// ==========================================
router.get('/api/holidays', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const holidays = [
    ...getNRWHolidays(year - 1).slice(-1),   // 31.12. Vorjahr, falls Ansicht drüber ragt
    ...getNRWHolidays(year),
    ...getNRWHolidays(year + 1).slice(0, 1)  // 1.1. Folgejahr
  ];
  res.json(holidays.map(h => ({
    title: h.name,
    start: h.date,
    display: 'background',
    color: '#fde68a'
  })));
});

// ==========================================
// TERMINE JSON (für FullCalendar)
// Admin: alle Termine
// Mitarbeiter: nur Termine ohne Zuweisung ODER mit eigener Zuweisung
// ==========================================
router.get('/api/appointments', async (req, res) => {
  try {
    const userId  = req.user.id;
    const isAdmin = req.user.role === 'ADMIN';

    // Alle Termine laden (mit Kunden- und Geo-Daten)
    const baseQuery = `
      SELECT appointments.id, appointments.title, appointments.start_date as start,
             appointments.end_date as end, appointments.description,
             appointments.project_id,
             customers.company_name, customers.contact_person,
             p2.title as project_title,
             COALESCE(p2.site_lat, p_by_customer.site_lat) as site_lat,
             COALESCE(p2.site_lng, p_by_customer.site_lng) as site_lng
      FROM appointments
      LEFT JOIN customers ON appointments.customer_id = customers.id
      LEFT JOIN projects  p2 ON p2.id = appointments.project_id
      LEFT JOIN projects  p_by_customer ON p_by_customer.customer_id = appointments.customer_id
        AND p_by_customer.site_lat IS NOT NULL AND p_by_customer.site_lng IS NOT NULL
    `;
    const allAppts = (await dbQuery(baseQuery)).rows || [];

    // Zugewiesene Mitarbeiter pro Termin laden
    const assignRes = await dbQuery(
      `SELECT appointment_id, user_id FROM appointment_users`
    );
    const assignMap = {};
    for (const row of (assignRes.rows || [])) {
      if (!assignMap[row.appointment_id]) assignMap[row.appointment_id] = [];
      assignMap[row.appointment_id].push(Number(row.user_id));
    }

    // Mitarbeiternamen für die extendedProps laden
    const namesRes = await dbQuery('SELECT id, username FROM users ORDER BY username ASC');
    const namesMap = {};
    for (const u of (namesRes.rows || [])) namesMap[u.id] = u.username;

    // Filter: Mitarbeiter sehen nur Termine ohne Zuweisung ODER mit ihnen
    const filtered = allAppts.filter(app => {
      if (isAdmin) return true;
      const assigned = assignMap[app.id] || [];
      return assigned.length === 0 || assigned.includes(Number(userId));
    });

    // Wetter parallel abrufen
    const weatherResults = await Promise.all(
      filtered.map(app => {
        if (!app.start) return Promise.resolve(null);
        return fetchWeather(app.site_lat || FIRM_LAT, app.site_lng || FIRM_LNG, app.start.split('T')[0]);
      })
    );

    const events = filtered.map((app, i) => {
      const w        = weatherResults[i];
      const assigned = (assignMap[app.id] || []).map(uid => namesMap[uid] || `#${uid}`);

      let backgroundColor, borderColor, textColor;
      if (w && w.warningLevel === 'danger') {
        backgroundColor = '#fee2e2'; borderColor = '#dc2626'; textColor = '#7f1d1d';
      } else if (w && w.warningLevel === 'warn') {
        backgroundColor = '#fef9c3'; borderColor = '#ca8a04'; textColor = '#713f12';
      } else if (app.project_id) {
        backgroundColor = '#dcfce7'; borderColor = '#16a34a'; textColor = '#14532d';
      } else {
        backgroundColor = '#dbeafe'; borderColor = '#2563eb'; textColor = '#1e3a5f';
      }

      const displayTitle = app.project_id ? `🏗️ ${app.title}` : app.title;

      return {
        id:    app.id,
        title: displayTitle,
        start: app.start,
        end:   app.end,
        description:     app.description,
        customerName:    app.company_name || app.contact_person || 'Privat',
        assignedUsers:   assigned,
        backgroundColor, borderColor, textColor,
        extendedProps: {
          weather:      w || null,
          description:  app.description,
          customerName: app.company_name || app.contact_person || 'Privat',
          assignedUsers: assigned,
          projectId:    app.project_id || null,
          projectTitle: app.project_title || null
        }
      };
    });

    res.json(events);
  } catch (err) {
    console.error('Fehler bei /api/appointments:', err.message);
    res.status(500).json([]);
  }
});

// ==========================================
// TERMIN ANLEGEN (mit optionaler Mitarbeiter-Zuweisung)
// ==========================================
router.post('/api/appointments/add', requireAdmin, async (req, res) => {
  const { title, customer_id, project_id, start_date, end_date, description } = req.body;
  // user_ids kommt als Array oder einzelner Wert (Checkboxen)
  let userIds = req.body.user_ids;
  if (!userIds) userIds = [];
  else if (!Array.isArray(userIds)) userIds = [userIds];

  try {
    const result = await dbQuery(
      `INSERT INTO appointments (title, customer_id, project_id, start_date, end_date, description) VALUES (?, ?, ?, ?, ?, ?)`,
      [title, customer_id || null, project_id || null, start_date, end_date || null, description || null]
    );
    const appointmentId = result.lastID;

    if (appointmentId && userIds.length > 0) {
      for (const uid of userIds) {
        await dbQuery(
          `INSERT INTO appointment_users (appointment_id, user_id) VALUES (?, ?)`,
          [appointmentId, parseInt(uid, 10)]
        ).catch(() => {}); // ignoriere doppelte Einträge
      }

      // WhatsApp-Benachrichtigung an zugewiesene Mitarbeiter
      const placeholders = userIds.map(() => '?').join(',');
      const assignedRes = await dbQuery(
        `SELECT u.whatsapp_phone, u.whatsapp_api_key FROM users u
         WHERE u.id IN (${placeholders})
           AND u.whatsapp_notify = true AND u.whatsapp_phone IS NOT NULL AND u.whatsapp_api_key IS NOT NULL`,
        userIds.map(id => parseInt(id, 10))
      ).catch(() => ({ rows: [] }));

      const dateStr = start_date ? new Date(start_date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : start_date;
      const msg = `📅 Neuer Termin: "${title}" am ${dateStr}${description ? ' – ' + description : ''}`;
      for (const u of (assignedRes.rows || [])) {
        sendWhatsApp(u.whatsapp_phone, msg, u.whatsapp_api_key).catch(() => {});
      }

      // Push-Benachrichtigung an die zugewiesenen Mitarbeiter
      const pushBody = `${title} am ${dateStr}${description ? ' – ' + description : ''}`;
      for (const uid of userIds) {
        sendPush({ title: '📅 Neuer Termin', body: pushBody, url: '/calendar' }, parseInt(uid, 10)).catch(() => {});
      }
    }

    res.redirect('/calendar');
  } catch (err) {
    console.error('Fehler beim Anlegen des Termins:', err.message);
    res.status(500).send('Fehler beim Speichern');
  }
});

// ==========================================
// TERMIN LÖSCHEN (bereinigt Join-Tabelle)
// ==========================================
router.post('/api/appointments/delete/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await dbQuery('DELETE FROM appointment_users WHERE appointment_id = ?', [id]);
    await dbQuery('DELETE FROM appointments WHERE id = ?', [id]);
    res.redirect('/calendar');
  } catch (err) {
    console.error('Fehler beim Löschen des Termins:', err.message);
    res.status(500).send('Fehler beim Löschen');
  }
});


// ==========================================
// WOCHEN- / MONTAGEPLAN
// ==========================================

router.get('/montageplan', async (req, res) => {
  try {
    let start = req.query.week ? new Date(req.query.week + 'T12:00:00') : new Date();
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    const [appsRes, usersRes, vacRes, staffRes, projRes] = await Promise.all([
      dbQuery(`
        SELECT a.*,
               c.company_name, c.contact_person,
               p.title AS project_name, p.id AS pid
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN projects p ON a.project_id = p.id
        WHERE a.start_date >= ? AND a.start_date <= ?
        ORDER BY a.start_date ASC
      `, [startStr + 'T00:00:00', endStr + 'T23:59:59']),
      dbQuery(`SELECT id, username, role FROM users WHERE role IN ('EMPLOYEE','CHEF','ADMIN') ORDER BY username ASC`),
      dbQuery(`
        SELECT v.*, u.username
        FROM vacations v
        LEFT JOIN users u ON v.user_id = u.id
        WHERE v.status = 'Genehmigt'
          AND v.start_date <= ?
          AND v.end_date >= ?
      `, [endStr, startStr]).catch(() => ({ rows: [] })),
      dbQuery(`
        SELECT sa.*, u.username, p.title AS project_title
        FROM staff_assignments sa
        LEFT JOIN users u ON sa.user_id = u.id
        LEFT JOIN projects p ON sa.project_id = p.id
        WHERE sa.assignment_date >= ? AND sa.assignment_date <= ?
      `, [startStr, endStr]).catch(() => ({ rows: [] })),
      dbQuery(`SELECT id, title, status FROM projects WHERE status IS NULL OR status NOT IN ('Abgeschlossen','Archiviert') ORDER BY title ASC`).catch(() => ({ rows: [] }))
    ]);

    const apps = appsRes.rows || [];
    const users = usersRes.rows || [];
    const vacations = vacRes.rows || [];
    const staffRows = staffRes.rows || [];
    const projects = projRes.rows || [];

    // appointment → assigned users
    const ids = apps.map(a => a.id);
    let assignMap = {};
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const au = await dbQuery(
        `SELECT au.appointment_id, u.username, u.id as user_id
         FROM appointment_users au JOIN users u ON au.user_id = u.id
         WHERE au.appointment_id IN (${placeholders})`,
        ids
      );
      for (const row of (au.rows || [])) {
        if (!assignMap[row.appointment_id]) assignMap[row.appointment_id] = [];
        assignMap[row.appointment_id].push({ id: row.user_id, username: row.username });
      }
    }

    // staff_assignments by user+date
    const staffMap = {}; // userId -> { date -> assignment }
    for (const sa of staffRows) {
      if (!staffMap[sa.user_id]) staffMap[sa.user_id] = {};
      staffMap[sa.user_id][sa.assignment_date] = sa;
    }

    // vacation check helper
    function isOnVacation(userId, dateStr) {
      for (const v of vacations) {
        if (Number(v.user_id) !== Number(userId)) continue;
        if (v.start_date <= dateStr && v.end_date >= dateStr) return v;
      }
      return null;
    }

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const dayApps = apps.filter(a => String(a.start_date).slice(0, 10) === ds).map(a => ({
        ...a,
        assignees: assignMap[a.id] || []
      }));

      // personal summary for this day
      const personal = users.map(u => {
        const vac = isOnVacation(u.id, ds);
        const staff = (staffMap[u.id] && staffMap[u.id][ds]) || null;
        const onApps = dayApps.filter(a => (a.assignees || []).some(x => Number(x.id) === Number(u.id)));
        let status = 'frei';
        let label = 'Frei / Werkstatt';
        if (vac) {
          status = 'urlaub';
          label = vac.type || 'Abwesend';
        } else if (onApps.length) {
          status = 'termin';
          label = onApps.map(a => a.title || a.project_name || 'Termin').join(', ');
        } else if (staff && staff.project_id) {
          status = 'baustelle';
          label = staff.project_title || staff.note || 'Baustelle';
        } else if (staff && staff.note) {
          status = 'notiz';
          label = staff.note;
        }
        return { user: u, status, label, vac, staff, onApps };
      });

      days.push({
        date: ds,
        label: d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' }),
        isToday: ds === new Date().toISOString().slice(0, 10),
        apps: dayApps,
        personal
      });
    }

    const prev = new Date(start); prev.setDate(prev.getDate() - 7);
    const next = new Date(start); next.setDate(next.getDate() + 7);

    // week overview matrix: users x days (for personalplanung table)
    const matrix = users.map(u => {
      const cells = days.map(day => {
        const p = day.personal.find(x => Number(x.user.id) === Number(u.id));
        return p || { status: 'frei', label: '—' };
      });
      return { user: u, cells };
    });

    res.render('montageplan', {
      days,
      matrix,
      users,
      projects,
      weekStart: startStr,
      weekLabel: start.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
        + ' – ' + end.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }),
      prevWeek: prev.toISOString().slice(0, 10),
      nextWeek: next.toISOString().slice(0, 10),
      user: req.user,
      currentUser: req.user
    });
  } catch (err) {
    console.error('Montageplan:', err.message);
    res.status(500).send('Fehler beim Laden des Montageplans: ' + err.message);
  }
});


module.exports = router;
