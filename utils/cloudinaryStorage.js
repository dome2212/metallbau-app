/**
 * utils/cloudinaryStorage.js
 * --------------------------
 * Drop-in-Ersatz für multer-storage-cloudinary@4 mit cloudinary v2.
 *
 * Setzt auf req.file dieselben Felder wie das Original:
 *   req.file.path        → secure_url  (Cloudinary HTTPS-URL)
 *   req.file.filename    → public_id
 *   req.file.originalname → original Dateiname
 *   req.file.mimetype    → MIME-Typ
 *   req.file.size        → Dateigröße in Bytes
 */
const { Readable } = require('stream');

class CloudinaryStorage {
  /**
   * @param {{ cloudinary: object, params: { folder: string, allowed_formats?: string[] } }} opts
   */
  constructor({ cloudinary, params = {} }) {
    this.cloudinary = cloudinary;
    this.folder          = params.folder          || 'uploads';
    this.allowed_formats = params.allowed_formats || ['jpg', 'jpeg', 'png', 'webp'];
  }

  _handleFile(req, file, cb) {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    const mimeSub = (file.mimetype || '').split('/')[1] || '';
    if (!this.allowed_formats.includes(ext) && !this.allowed_formats.includes(mimeSub)) {
      return cb(new Error(`Ungültiges Dateiformat „${ext || mimeSub}“. Erlaubt: ${this.allowed_formats.join(', ')}`));
    }

    // ZIP/Archive und Office/CAD als raw, Bilder/PDF als auto
    const rawExts = ['zip', 'rar', '7z', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'dwg', 'dxf'];
    const resourceType = rawExts.includes(ext) ? 'raw' : 'auto';

    const uploadStream = this.cloudinary.uploader.upload_stream(
      { folder: this.folder, resource_type: resourceType },
      (err, result) => {
        if (err) return cb(err);
        cb(null, {
          path:         result.secure_url,
          filename:     result.public_id,
          originalname: file.originalname,
          mimetype:     file.mimetype,
          size:         result.bytes,
        });
      }
    );

    const readable = new Readable();
    readable._read = () => {};

    const chunks = [];
    file.stream.on('data', chunk => chunks.push(chunk));
    file.stream.on('end',  () => {
      readable.push(Buffer.concat(chunks));
      readable.push(null);
      readable.pipe(uploadStream);
    });
    file.stream.on('error', cb);
  }

  _removeFile(req, file, cb) {
    if (!file.filename) return cb(null);
    this.cloudinary.uploader.destroy(file.filename, cb);
  }
}

module.exports = { CloudinaryStorage };
