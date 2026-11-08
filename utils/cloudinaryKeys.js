/**
 * Cloudinary-Zugangsdaten im Admin-Panel (System) verwalten.
 * Die Werte werden verschlüsselt (AES-256-GCM, Schlüssel aus JWT_SECRET) in company_settings
 * gespeichert und beim Start sowie nach dem Speichern in process.env geladen –
 * der restliche Code (process.env.CLOUDINARY_*) funktioniert dadurch unverändert.
 * Ein im Panel gespeicherter Wert hat Vorrang vor der .env; wird er gelöscht, gilt wieder die .env.
 * Nach dem Laden wird cloudinary.config() neu gesetzt, damit Uploads sofort greifen.
 */
const { dbQuery } = require('./db');
const { setFirmaValue } = require('./companySettings');
const { encrypt, decrypt } = require('./secretBox');

const KEYS = [
  {
    env: 'CLOUDINARY_CLOUD_NAME',
    label: 'Cloud Name',
    hint: 'z. B. „dxxxxx“ – aus dem Cloudinary-Dashboard (Settings → Product Environment Credentials)',
    pattern: /^[a-z0-9_-]{2,64}$/i,
  },
  {
    env: 'CLOUDINARY_API_KEY',
    label: 'API Key',
    hint: 'Numerischer API-Key aus dem Cloudinary-Dashboard',
    pattern: /^\d{10,}$/,
  },
  {
    env: 'CLOUDINARY_API_SECRET',
    label: 'API Secret',
    hint: 'API Secret – wird verschlüsselt gespeichert und nie wieder angezeigt',
    pattern: /^[\w-]{10,}$/,
  },
];

const ORIGINAL = {};
for (const k of KEYS) ORIGINAL[k.env] = process.env[k.env];

const dbKey = (env) => 'cloudinary_' + env.toLowerCase();

/** Cloudinary-SDK mit aktuellen process.env-Werten neu konfigurieren. */
function applyCloudinaryConfig() {
  try {
    const { v2: cloudinary } = require('cloudinary');
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME || undefined,
      api_key:    process.env.CLOUDINARY_API_KEY || undefined,
      api_secret: process.env.CLOUDINARY_API_SECRET || undefined,
    });
  } catch (err) {
    console.error('Cloudinary-Config aktualisieren:', err.message);
  }
}

/** Gespeicherte Werte aus der DB in process.env übernehmen und SDK neu konfigurieren. */
async function loadCloudinaryKeys() {
  try {
    const rows = (await dbQuery("SELECT key, value FROM company_settings WHERE key LIKE 'cloudinary_%'")).rows;
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    for (const k of KEYS) {
      const plain = decrypt(byKey[dbKey(k.env)]);
      if (plain) process.env[k.env] = plain;
      else if (ORIGINAL[k.env]) process.env[k.env] = ORIGINAL[k.env];
      else delete process.env[k.env];
    }
    applyCloudinaryConfig();
  } catch (err) {
    console.error('Cloudinary-Keys laden:', err.message);
  }
}

/** Status für die Anzeige (Secret/Key selbst wird nie ausgegeben, nur die letzten 4 Zeichen). */
async function status() {
  const rows = (await dbQuery("SELECT key, value FROM company_settings WHERE key LIKE 'cloudinary_%'").catch(() => ({ rows: [] }))).rows;
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return KEYS.map(k => {
    const stored = decrypt(byKey[dbKey(k.env)]);
    const active = process.env[k.env] || '';
    return {
      env: k.env,
      label: k.label,
      hint: k.hint,
      source: stored ? 'panel' : (ORIGINAL[k.env] ? 'env' : 'none'),
      tail: active ? '…' + active.slice(-4) : '',
    };
  });
}

/** Speichert (oder löscht bei remove=true) einen Wert. */
async function saveKey(env, value, remove) {
  const k = KEYS.find(x => x.env === env);
  if (!k) return;
  if (remove) {
    await setFirmaValue(dbKey(env), '');
    return;
  }
  value = String(value || '').trim();
  if (!value) return; // leer = unverändert lassen
  if (value.length > 200 || /\s/.test(value)) {
    throw new Error(k.label + ': Der Wert sieht ungültig aus (Leerzeichen/zu lang).');
  }
  // leichte Formatprüfung (nicht zu streng, falls Cloudinary das Format ändert)
  if (k.pattern && !k.pattern.test(value)) {
    // nur warnen, nicht blockieren – Pattern kann sich ändern
    console.warn('Cloudinary-Key Format ungewöhnlich für', k.env);
  }
  await setFirmaValue(dbKey(env), encrypt(value));
}

module.exports = { KEYS, loadCloudinaryKeys, status, saveKey, applyCloudinaryConfig };
