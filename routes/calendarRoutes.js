const express = require('express');
const router  = express.Router();
const https   = require('https');
const { dbQuery } = require('../utils/db');

const isPg = !!process.env.DATABASE_URL;

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
  try {
    const [customersRes, usersRes] = await Promise.all([
      dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC'),
      dbQuery('SELECT id, username FROM users ORDER BY username ASC')
    ]);
    res.render('calendar', {
      customers: customersRes.rows || [],
      users:     usersRes.rows     || []
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
             customers.company_name, customers.contact_person,
             projects.site_lat, projects.site_lng
      FROM appointments
      LEFT JOIN customers ON appointments.customer_id = customers.id
      LEFT JOIN projects  ON projects.customer_id = appointments.customer_id
        AND projects.site_lat IS NOT NULL AND projects.site_lng IS NOT NULL
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
      } else {
        backgroundColor = '#dbeafe'; borderColor = '#2563eb'; textColor = '#1e3a5f';
      }

      return {
        id:    app.id,
        title: app.title,
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
          assignedUsers: assigned
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
router.post('/api/appointments/add', async (req, res) => {
  const { title, customer_id, start_date, end_date, description } = req.body;
  // user_ids kommt als Array oder einzelner Wert (Checkboxen)
  let userIds = req.body.user_ids;
  if (!userIds) userIds = [];
  else if (!Array.isArray(userIds)) userIds = [userIds];

  try {
    const result = await dbQuery(
      `INSERT INTO appointments (title, customer_id, start_date, end_date, description) VALUES (?, ?, ?, ?, ?)`,
      [title, customer_id || null, start_date, end_date || null, description || null]
    );
    const appointmentId = result.lastID;

    if (appointmentId && userIds.length > 0) {
      for (const uid of userIds) {
        await dbQuery(
          `INSERT INTO appointment_users (appointment_id, user_id) VALUES (?, ?)`,
          [appointmentId, parseInt(uid, 10)]
        ).catch(() => {}); // ignoriere doppelte Einträge
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
router.post('/api/appointments/delete/:id', async (req, res) => {
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

module.exports = router;
