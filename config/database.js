const express = require('express');
const router  = express.Router();
const { dbQuery } = require('../utils/db');

const isPg = !!process.env.DATABASE_URL;

function parseBerlinDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  if (/[zZ]$/.test(normalized) || /[+-]\d{2}:?\d{2}$/.test(normalized)) {
    return new Date(normalized);
  }
  return new Date(normalized + '+01:00');
}

// ==========================================
// DASHBOARD (rollenabhängig: Chef vs. Mitarbeiter)
// ==========================================
router.get('/', async (req, res) => {
  const userId   = req.user.id;
  const userRole = req.user.role;

  try {
    if (userRole === 'EMPLOYEE') {
      // ── Mitarbeiter-Dashboard ──────────────────────────────────────────────
      const now = new Date();
      const curYear  = now.getFullYear();
      const curMonth = now.getMonth();

      const monthStr    = `${curYear}-${String(curMonth + 1).padStart(2, '0')}`;
      const monthStartStr = `${monthStr}-01`;
      const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
      const monthEndStr = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;

      const sqlMonthLogs = isPg
        ? `SELECT time_logs.*, TO_CHAR(time_logs.timestamp, 'YYYY-MM-DD HH24:MI:SS') as local_timestamp
           FROM time_logs WHERE user_id = ?
           AND DATE(time_logs.timestamp) BETWEEN ? AND ?
           ORDER BY timestamp ASC`
        : `SELECT time_logs.*, strftime('%Y-%m-%d %H:%M:%S', timestamp) as local_timestamp
           FROM time_logs WHERE user_id = ?
           AND date(timestamp) BETWEEN ? AND ?
           ORDER BY timestamp ASC`;

      const result = await dbQuery(sqlMonthLogs, [userId, monthStartStr, monthEndStr]);
      const logs   = result.rows;

      let totalMilliseconds = 0;
      let isStampedIn       = false;

      if (logs && logs.length > 0) {
        for (let i = 0; i < logs.length; i++) {
          const currentLogTime = parseBerlinDate(logs[i].local_timestamp || logs[i].timestamp);
          if (logs[i].type === 'IN') {
            isStampedIn = true;
            const startTime = currentLogTime.getTime();
            const nextLog   = logs[i + 1];
            let endTime;
            if (nextLog && nextLog.type === 'OUT') {
              isStampedIn = false;
              endTime = parseBerlinDate(nextLog.local_timestamp || nextLog.timestamp).getTime();
            } else if (i === logs.length - 1) {
              endTime = now.getTime();
            } else {
              endTime = startTime;
            }
            if (endTime > startTime) totalMilliseconds += (endTime - startTime);
          } else if (logs[i].type === 'OUT') {
            isStampedIn = false;
          }
        }
      }

      const monthTotalHours = (totalMilliseconds / 3600000).toFixed(2);

      // Soll-Stunden aus Firmen-Einstellungen
      const { getFirma: _getDashFirma } = require('../utils/companySettings');
      const _dashFirma = await _getDashFirma();
      const dailyHours = parseFloat(_dashFirma.work_hours_per_day || 8);
      let workdaysSoFar = 0;
      for (let d = 1; d <= now.getDate(); d++) {
        const dow = new Date(curYear, curMonth, d).getDay();
        if (dow !== 0 && dow !== 6) workdaysSoFar++;
      }
      const targetHours   = workdaysSoFar * dailyHours;
      const overtimeHours = parseFloat(monthTotalHours) - targetHours;
      const overtimeAbs   = Math.abs(overtimeHours);
      const overtimeH     = Math.floor(overtimeAbs);
      const overtimeM     = Math.round((overtimeAbs - overtimeH) * 60);

      let trafficLight, trafficColor, trafficBorder, trafficBg, trafficText;
      if (overtimeHours >= -2) {
        trafficLight  = '🟢'; trafficColor  = 'text-emerald-700';
        trafficBorder = 'border-emerald-500'; trafficBg = 'bg-emerald-50';
        trafficText   = overtimeHours >= 0
          ? `+${overtimeH} Std. ${overtimeM} Min. Überstunden`
          : `${overtimeH} Std. ${overtimeM} Min. unter Soll (OK)`;
      } else if (overtimeHours >= -6) {
        trafficLight  = '🟡'; trafficColor  = 'text-amber-700';
        trafficBorder = 'border-amber-500'; trafficBg = 'bg-amber-50';
        trafficText   = `${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      } else {
        trafficLight  = '🔴'; trafficColor  = 'text-red-700';
        trafficBorder = 'border-red-500'; trafficBg = 'bg-red-50';
        trafficText   = `${overtimeH} Std. ${overtimeM} Min. unter Soll`;
      }

      res.render('dashboard-employee', {
        currentUser: req.user,
        stats: {
          isStampedIn,
          monthTotalHours: parseFloat(monthTotalHours),
          targetHours,
          overtimeHours: parseFloat(overtimeHours.toFixed(2)),
          trafficText,
          trafficColor,
          trafficBorder,
          trafficBg,
          progressPct: Math.min(100, (parseFloat(monthTotalHours) / targetHours) * 100 || 0),
          progressColor: '#10b981'
        }
      });
      return;
    }

    // Chef-Dashboard (nicht relevant für den Zeitfehler; einheitlich bleiben)
    res.render('dashboard-chef', {
      currentUser: req.user,
      userRole,
      monthTotalHours: 0,
      targetHours: 0,
      overtimeHours: 0,
      stats: {}
    });
  } catch (err) {
    console.error('Fehler beim Dashboard:', err.message);
    res.status(500).send('Interner Serverfehler');
  }
});

module.exports = router;
