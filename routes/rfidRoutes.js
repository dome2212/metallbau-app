const express = require('express');
const router = express.Router();
const { dbQuery } = require('../utils/db');
const isPg = !!process.env.DATABASE_URL;

router.post('/stamp', async (req, res) => {
  // API-Key prüfen (Header: X-RFID-Key) – fail-closed
  const apiKey = process.env.RFID_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'RFID-Stempeluhr nicht konfiguriert.' });
  }
  if (req.headers['x-rfid-key'] !== apiKey) {
    return res.status(401).json({ ok: false, error: 'Ungültiger API-Key' });
  }

  const { uid, note } = req.body;
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    return res.status(400).json({ ok: false, error: 'UID fehlt' });
  }

  try {
    // Mitarbeiter anhand UID suchen
    const userRes = await dbQuery(
      `SELECT id, username, role FROM users WHERE rfid_uid = ?`,
      [uid.trim().toUpperCase()]
    );
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Unbekannte RFID-UID' });
    }

    // Letzten Stempel ermitteln → IN oder OUT
    const lastRes = await dbQuery(
      isPg
        ? `SELECT type FROM time_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`
        : `SELECT type FROM time_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [user.id]
    );
    const lastType  = lastRes.rows[0]?.type || 'OUT';
    const stampType = lastType === 'IN' ? 'OUT' : 'IN';

    // Eintrag speichern
    const tsExpr = isPg ? `NOW()` : `CURRENT_TIMESTAMP`;
    await dbQuery(
      `INSERT INTO time_logs (user_id, type, note, timestamp) VALUES (?, ?, ?, ${tsExpr})`,
      [user.id, stampType, note || (stampType === 'IN' ? 'RFID Einstempel' : 'RFID Ausstempel')]
    );

    console.log(`[RFID] ${user.username} → ${stampType} (UID: ${uid})`);
    res.json({ ok: true, username: user.username, type: stampType });
  } catch (err) {
    console.error('[RFID] Fehler:', err.message);
    res.status(500).json({ ok: false, error: 'Datenbankfehler' });
  }
});

module.exports = router;
