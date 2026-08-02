const express = require('express');
const router = express.Router();
const dbQuery = require('../utils/dbQuery');

// Wird in server.js unter '/api/appointments' eingebunden.
router.get('/', async (req, res) => {
  const result = await dbQuery(`
    SELECT appointments.id, appointments.title, appointments.start_date as start,
           appointments.end_date as end, appointments.description,
           customers.company_name, customers.contact_person
    FROM appointments
    LEFT JOIN customers ON appointments.customer_id = customers.id
  `);
  res.json((result.rows || []).map(app => ({
    id: app.id,
    title: `${app.title} (${app.company_name || app.contact_person || 'Privat'})`,
    start: app.start,
    end: app.end,
    description: app.description
  })));
});

router.post('/add', async (req, res) => {
  const { title, customer_id, start_date, end_date, description } = req.body;
  await dbQuery(
    'INSERT INTO appointments (title, customer_id, start_date, end_date, description) VALUES (?, ?, ?, ?, ?)',
    [title, customer_id || null, start_date, end_date || null, description]
  );
  res.redirect('/calendar');
});

router.post('/delete/:id', async (req, res) => {
  await dbQuery('DELETE FROM appointments WHERE id = ?', [req.params.id]);
  res.redirect('/calendar');
});

module.exports = router;
