/**
 * KI-API-Keys im Admin-Panel (System) verwalten.
 * Die Keys werden verschlüsselt (AES-256-GCM, Schlüssel aus JWT_SECRET) in company_settings
 * gespeichert und beim Start sowie nach dem Speichern in process.env geladen –
 * der restliche Code (process.env.GEMINI_API_KEY usw.) funktioniert dadurch unverändert.
 * Ein im Panel gespeicherter Key hat Vorrang vor der .env; wird er gelöscht, gilt wieder die .env.
 */
const { dbQuery } = require('./db');
const { setFirmaValue } = require('./companySettings');

const KEYS = [
  { env: 'GEMINI_API_KEY',     label: 'Google Gemini',  hint: 'Bilderkennung (Lager, Schnittliste) – kostenlos auf aistudio.google.com/apikey', pattern: /^AIza[\w-]{20,}$/ },
  { env: 'OPENROUTER_API_KEY', label: 'OpenRouter',     hint: 'Ersatz, falls Gemini ausfällt – openrouter.ai/keys', pattern: /^sk-or-[\w-]{10,}$/ },
  { env: 'GROQ_API_KEY',       label: 'Groq',           hint: 'Sprach-/Textfunktionen – console.groq.com/keys', pattern: /^gsk_[\w]{10,}$/ },
];
const ORIGINAL = {};                                   // Werte aus der .env merken
for (const k of KEYS) ORIGINAL[k.env] = process.env[k.env];

const dbKey = (env) => 'ai_key_' + env.toLowerCase();

const { encrypt, decrypt } = require('./secretBox');

/** Gespeicherte Keys aus der DB in process.env übernehmen. */
async function loadAiKeys() {
  try {
    const rows = (await dbQuery("SELECT key, value FROM company_settings WHERE key LIKE 'ai_key_%'")).rows;
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    for (const k of KEYS) {
      const plain = decrypt(byKey[dbKey(k.env)]);
      if (plain) process.env[k.env] = plain;
      else if (ORIGINAL[k.env]) process.env[k.env] = ORIGINAL[k.env];
      else delete process.env[k.env];
    }
  } catch (err) {
    console.error('KI-Keys laden:', err.message);
  }
}

/** Status für die Anzeige (Key selbst wird nie ausgegeben, nur die letzten 4 Zeichen). */
async function status() {
  const rows = (await dbQuery("SELECT key, value FROM company_settings WHERE key LIKE 'ai_key_%'").catch(() => ({ rows: [] }))).rows;
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return KEYS.map(k => {
    const stored = decrypt(byKey[dbKey(k.env)]);
    const active = process.env[k.env] || '';
    return {
      env: k.env, label: k.label, hint: k.hint,
      source: stored ? 'panel' : (ORIGINAL[k.env] ? 'env' : 'none'),
      tail: active ? '…' + active.slice(-4) : '',
    };
  });
}

/** Speichert (oder löscht bei leerem Wert + remove=true) einen Key. */
async function saveKey(env, value, remove) {
  const k = KEYS.find(x => x.env === env);
  if (!k) return;
  if (remove) { await setFirmaValue(dbKey(env), ''); return; }
  value = String(value || '').trim();
  if (!value) return;                                  // leer = unverändert lassen
  if (value.length > 300 || /\s/.test(value)) throw new Error(k.label + ': Der Key sieht ungültig aus (Leerzeichen/zu lang).');
  await setFirmaValue(dbKey(env), encrypt(value));
}

module.exports = { KEYS, loadAiKeys, status, saveKey };
