
const express = require('express');
const router = express.Router();
const dbQuery = require('../utils/dbQuery');

// WICHTIG: Diese Datei enthält jetzt NUR NOCH die Kalender-Seite selbst.
// Die /api/appointments-Routen wurden nach appointmentRoutes.js ausgelagert,
// weil sie unter einem eigenen Pfad (/api/appointments) laufen müssen und
// nicht unter /calendar/api/appointments gelandet wären.
router.get('/', async (req, res) => {
  const result = await dbQuery('SELECT * FROM customers ORDER BY company_name ASC, contact_person ASC');
  res.render('calendar', { customers: result.rows });
});

module.exports = router;
