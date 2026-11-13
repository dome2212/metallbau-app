/** @deprecated Cloudinary entfernt – Alias auf lokalen Speicher */
const local = require('./localUploadStorage');
module.exports = { ...local, CloudinaryStorage: local.LocalStorage };
