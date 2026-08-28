/**
 * NRW-Feiertage (Nordrhein-Westfalen)
 * Berechnet alle gesetzlichen Feiertage für ein gegebenes Jahr,
 * inklusive der beweglichen Feiertage (abhängig vom Osterdatum).
 */

// Berechnet das Osterdatum (Gaußsche Osterformel)
function getEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = März, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Gibt alle NRW-Feiertage für ein Jahr zurück.
 * @param {number} year
 * @returns {Array<{date: string, name: string}>} sortiert nach Datum
 */
function getNRWHolidays(year) {
  const easter = getEasterSunday(year);

  const holidays = [
    { date: new Date(year, 0, 1),        name: 'Neujahr' },
    { date: addDays(easter, -2),         name: 'Karfreitag' },
    { date: addDays(easter, 1),          name: 'Ostermontag' },
    { date: new Date(year, 4, 1),        name: 'Tag der Arbeit' },
    { date: addDays(easter, 39),         name: 'Christi Himmelfahrt' },
    { date: addDays(easter, 50),         name: 'Pfingstmontag' },
    { date: addDays(easter, 60),         name: 'Fronleichnam' },      // NRW-spezifisch
    { date: new Date(year, 9, 3),        name: 'Tag der Deutschen Einheit' },
    { date: new Date(year, 10, 1),       name: 'Allerheiligen' },     // NRW-spezifisch
    { date: new Date(year, 11, 25),      name: '1. Weihnachtstag' },
    { date: new Date(year, 11, 26),      name: '2. Weihnachtstag' },
  ];

  return holidays
    .map(h => ({ date: toISODate(h.date), name: h.name }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Gibt eine Map { 'YYYY-MM-DD': 'Name' } zurück – praktisch für schnelle Lookups
 * (z.B. beim Prüfen, ob ein bestimmtes Datum ein Feiertag ist).
 */
function getNRWHolidayMap(year) {
  const map = {};
  for (const h of getNRWHolidays(year)) {
    map[h.date] = h.name;
  }
  return map;
}

/**
 * Prüft, ob ein gegebenes Datum (Date-Objekt oder 'YYYY-MM-DD') ein NRW-Feiertag ist.
 * @returns {string|null} Name des Feiertags oder null
 */
function isNRWHoliday(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const map = getNRWHolidayMap(d.getFullYear());
  return map[toISODate(d)] || null;
}

module.exports = { getNRWHolidays, getNRWHolidayMap, isNRWHoliday };

