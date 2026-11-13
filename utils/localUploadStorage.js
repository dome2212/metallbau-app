/**
 * Lokaler Dateispeicher (Ersatz für Cloudinary).
 * Multer-kompatibel: setzt req.file.path auf öffentliche URL /uploads/...
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeExt(name, fallback = '.bin') {
  const ext = path.extname(name || '').toLowerCase();
  if (!ext || ext.length > 10) return fallback;
  return ext.replace(/[^a-z0-9.]/g, '') || fallback;
}

function publicUrl(folder, filename) {
  return `/uploads/${folder}/${filename}`;
}

function absPathFromPublic(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('/uploads/')) return null;
  const rel = url.replace(/^\/uploads\//, '').replace(/\.\./g, '');
  return path.join(UPLOAD_ROOT, rel);
}

class LocalStorage {
  /**
   * @param {{ params?: { folder?: string, allowed_formats?: string[] } }} opts
   */
  constructor({ params = {} } = {}) {
    this.folder = (params.folder || 'general').replace(/[^a-zA-Z0-9_-]/g, '_') || 'general';
    this.allowed_formats = params.allowed_formats || null;
  }

  _handleFile(req, file, cb) {
    try {
      if (this.allowed_formats && this.allowed_formats.length) {
        const ext = (file.originalname || '').split('.').pop().toLowerCase();
        const mimeSub = (file.mimetype || '').split('/')[1];
        if (!this.allowed_formats.includes(ext) && !this.allowed_formats.includes(mimeSub)) {
          return cb(new Error(`Ungültiges Dateiformat. Erlaubt: ${this.allowed_formats.join(', ')}`));
        }
      }
      const dir = path.join(UPLOAD_ROOT, this.folder);
      ensureDir(dir);
      const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt(file.originalname)}`;
      const full = path.join(dir, filename);
      const ws = fs.createWriteStream(full);
      let size = 0;
      file.stream.on('data', (c) => { size += c.length; });
      file.stream.pipe(ws);
      ws.on('error', cb);
      ws.on('finish', () => {
        cb(null, {
          path: publicUrl(this.folder, filename),
          filename: `${this.folder}/${filename}`,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size,
        });
      });
    } catch (e) {
      cb(e);
    }
  }

  _removeFile(req, file, cb) {
    try {
      if (!file || !file.filename) return cb(null);
      const full = path.join(UPLOAD_ROOT, file.filename);
      fs.unlink(full, () => cb(null));
    } catch (_) {
      cb(null);
    }
  }
}

/** data:image/...;base64,... → öffentliche URL */
async function saveDataUrl(dataUrl, folder = 'project_photos', originalName = 'upload.jpg') {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Ungültige dataUrl');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  let ext = '.jpg';
  if (mime.includes('png')) ext = '.png';
  else if (mime.includes('webp')) ext = '.webp';
  else if (mime.includes('gif')) ext = '.gif';
  else if (mime.includes('pdf')) ext = '.pdf';
  const f = folder.replace(/[^a-zA-Z0-9_-]/g, '_') || 'general';
  const dir = path.join(UPLOAD_ROOT, f);
  ensureDir(dir);
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  return publicUrl(f, filename);
}

/** Buffer speichern */
async function saveBuffer(buffer, folder = 'general', originalName = 'file.bin') {
  const f = folder.replace(/[^a-zA-Z0-9_-]/g, '_') || 'general';
  const dir = path.join(UPLOAD_ROOT, f);
  ensureDir(dir);
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt(originalName)}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return publicUrl(f, filename);
}

/** Lokale Datei löschen, wenn URL unter /uploads/ liegt */
function deleteLocalUrl(url) {
  const full = absPathFromPublic(url);
  if (!full) return false;
  try {
    if (fs.existsSync(full)) {
      fs.unlinkSync(full);
      return true;
    }
  } catch (e) {
    console.warn('deleteLocalUrl:', e.message);
  }
  return false;
}

ensureDir(UPLOAD_ROOT);

module.exports = {
  LocalStorage,
  saveDataUrl,
  saveBuffer,
  deleteLocalUrl,
  UPLOAD_ROOT,
};
