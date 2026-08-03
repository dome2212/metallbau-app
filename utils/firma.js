/**
 * Firmendaten – Kompatibilitäts-Wrapper.
 *
 * Früher: statisches FIRMA-Objekt direkt in dieser Datei.
 * Jetzt:  Daten liegen in der Datenbank (Tabelle company_settings).
 *         Über getFirma() werden sie geladen und gecacht.
 *
 * Alle bestehenden Importe (`const { FIRMA } = require('../utils/firma')`)
 * funktionieren weiterhin, liefern aber jetzt ein veraltetes Snapshot-Objekt.
 * Neue Routen sollen stattdessen direkt `getFirma()` aus companySettings.js
 * verwenden, damit immer die aktuellen DB-Daten genutzt werden.
 */
const { DEFAULTS } = require('./companySettings');

// Statisches Objekt für Abwärtskompatibilität (wird beim App-Start einmalig befüllt)
const FIRMA = { ...DEFAULTS };

module.exports = { FIRMA };
