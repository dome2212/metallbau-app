/**
 * Kleine Hilfe zum Verschlüsseln von Zugangsdaten (AES-256-GCM, Schlüssel aus JWT_SECRET).
 * Format: "enc:v1:<iv>.<tag>.<daten>" (Base64). Unverschlüsselte Altwerte bleiben lesbar.
 */
const crypto = require('crypto');

function secret() {
  const { JWT_SECRET } = require('../middleware/auth');
  return crypto.createHash('sha256').update(String(JWT_SECRET)).digest();
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc:v1:' + [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function decrypt(stored) {
  if (!stored || !String(stored).startsWith('enc:v1:')) return '';
  try {
    const [iv, tag, data] = String(stored).slice(7).split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', secret(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch (_) { return ''; }
}
/** Liefert Klartext: verschlüsselte Werte werden entschlüsselt, alte Klartext-Werte unverändert zurückgegeben. */
function reveal(stored) {
  if (!stored) return '';
  return String(stored).startsWith('enc:v1:') ? decrypt(stored) : String(stored);
}
module.exports = { encrypt, decrypt, reveal };
