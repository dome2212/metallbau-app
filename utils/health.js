const { dbQuery } = require('./db');
const { getFirma } = require('./companySettings');

async function runHealthCheck() {
  const checks = [];
  const t0 = Date.now();

  // DB
  try {
    await dbQuery('SELECT 1 AS ok');
    checks.push({ id: 'db', ok: true, label: 'Datenbank', detail: `${Date.now() - t0} ms` });
  } catch (e) {
    checks.push({ id: 'db', ok: false, label: 'Datenbank', detail: e.message });
  }

  // Migrations
  try {
    const r = await dbQuery('SELECT COUNT(*) AS c FROM schema_migrations');
    const c = r.rows?.[0]?.c ?? r.rows?.[0]?.count ?? '?';
    checks.push({ id: 'migrations', ok: true, label: 'Migrationen', detail: `${c} angewendet` });
  } catch (e) {
    checks.push({ id: 'migrations', ok: false, label: 'Migrationen', detail: e.message });
  }

  const firma = await getFirma().catch(() => ({}));

  checks.push({
    id: 'smtp',
    ok: !!(process.env.SMTP_USER || firma.smtp_user),
    label: 'SMTP',
    detail: (process.env.SMTP_USER || firma.smtp_user || 'nicht gesetzt')
  });

  checks.push({
    id: 'cloudinary',
    ok: !!(process.env.CLOUDINARY_CLOUD_NAME || firma.cloudinary_cloud_name),
    label: 'Cloudinary',
    detail: process.env.CLOUDINARY_CLOUD_NAME || firma.cloudinary_cloud_name || 'nicht gesetzt'
  });

  checks.push({
    id: 'maintenance',
    ok: firma.maintenance_mode !== 'true',
    label: 'Wartungsmodus',
    detail: firma.maintenance_mode === 'true' ? 'AKTIV' : 'aus'
  });

  const allOk = checks.every(c => c.ok || c.id === 'maintenance');
  return { ok: allOk, at: new Date().toISOString(), checks };
}

module.exports = { runHealthCheck };
