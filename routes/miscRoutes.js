const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');

// Karte mit offenen Projekten
router.get('/map', async (req, res) => {
  try {
    const projRes = await dbQuery(`
      SELECT projects.*, customers.company_name, customers.contact_person, customers.street, customers.city
      FROM projects
      LEFT JOIN customers ON projects.customer_id = customers.id
      WHERE projects.status != 'Abgeschlossen'
      ORDER BY projects.title ASC
    `);
    res.render('map', { projects: projRes.rows || [] });
  } catch (err) {
    console.error('GET /map Fehler:', err.message);
    res.status(500).render('error', {
      status: 500,
      title: 'Karte nicht geladen',
      message: err.message || 'Die Karte konnte nicht geladen werden.'
    });
  }
});

// Sidebar-Sichtbarkeit (Cookie)
router.post('/sidebar-settings', (req, res) => {
  const hidden = Object.keys(req.body).filter(k => k.startsWith('hide_'));
  res.cookie('sidebar_hidden', JSON.stringify(hidden), {
    maxAge: 30 * 24 * 3600 * 1000,
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
  });
  const redirect = req.body._redirect || req.headers.referer || '/';
  res.redirect(redirect);
});

module.exports = router;
