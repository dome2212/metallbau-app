/**
 * Öffentlicher Kunden-Info-Link für Aufträge (optional mit Passwort).
 * GET  /auftrag-info/:token
 * POST /auftrag-info/:token/unlock
 */
const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const { dbQuery } = require('../utils/db');
const { getFirma } = require('../utils/companySettings');

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}
function authCookieName(token) {
  return 'ps_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}
function authCookieValue(tokenHash) {
  return crypto.createHash('sha256').update(String(tokenHash) + '|' + (process.env.JWT_SECRET || 'x')).digest('hex');
}
function isUnlocked(req, token, tokenHash) {
  const v = req.cookies && req.cookies[authCookieName(token)];
  return v && v === authCookieValue(tokenHash);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtDate(d) {
  if (!d) return '–';
  try { return new Date(d).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch (_) { return String(d); }
}
function fmtDay(d) {
  if (!d) return '–';
  try { return new Date(d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }); }
  catch (_) { return String(d); }
}

async function loadShare(token) {
  if (!token || token.length < 16) return null;
  const h = hashToken(token);
  const row = (await dbQuery(
    `SELECT t.*, p.title, p.status, p.description, p.site_lat, p.site_lng, p.site_note,
            p.customer_id, c.company_name, c.contact_person, c.street, c.zip, c.city, c.phone, c.email
     FROM project_share_tokens t
     JOIN projects p ON p.id = t.project_id
     LEFT JOIN customers c ON c.id = p.customer_id
     WHERE t.token_hash = ?`,
    [h]
  )).rows?.[0];
  return row || null;
}

function parseSections(raw) {
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : ['overview'];
  } catch (_) { return ['overview']; }
}

function passwordForm(token, firma, error) {
  const primary = (firma && firma.color_primary) || '#4f46e5';
  return `<!DOCTYPE html><html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Passwort – Auftragsinfo</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f1f5f9;color:#0f172a;padding:1rem}
.card{width:100%;max-width:360px;background:#fff;border-radius:1rem;padding:1.35rem;border:1px solid #e2e8f0;box-shadow:0 8px 24px rgb(15 23 42/.08)}
h1{margin:0 0 .35rem;font-size:1.15rem}p{color:#64748b;font-size:.875rem;margin:0 0 1rem}
label{display:block;font-size:.75rem;font-weight:600;margin-bottom:.35rem}
input{width:100%;box-sizing:border-box;padding:.75rem .85rem;border:1px solid #cbd5e1;border-radius:.65rem;font-size:1rem}
button{margin-top:.85rem;width:100%;padding:.8rem;border:0;border-radius:.65rem;background:${esc(primary)};color:#fff;font-weight:700;font-size:.95rem}
.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;padding:.55rem .7rem;border-radius:.5rem;font-size:.8rem;margin-bottom:.75rem}
</style></head><body>
<div class="card">
  <h1>🔒 Geschützte Auftragsinfo</h1>
  <p>Bitte geben Sie das Passwort ein, das Sie vom Betrieb erhalten haben.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <form method="POST" action="/auftrag-info/${esc(token)}/unlock">
    <label for="pw">Passwort</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Anzeigen</button>
  </form>
</div></body></html>`;
}

router.post('/:token/unlock', async (req, res) => {
  try {
    const token = req.params.token;
    const share = await loadShare(token);
    if (!share || share.revoked_at) return res.status(404).send('Link ungültig');
    if (share.expires_at && new Date(share.expires_at) < new Date()) return res.status(410).send('Link abgelaufen');
    if (!share.password_hash) return res.redirect('/auftrag-info/' + encodeURIComponent(token));

    const pw = (req.body.password || '').toString();
    const ok = await bcrypt.compare(pw, share.password_hash);
    if (!ok) {
      const firma = await getFirma().catch(() => ({}));
      return res.status(401).send(passwordForm(token, firma, 'Passwort ist falsch.'));
    }
    res.cookie(authCookieName(token), authCookieValue(share.token_hash), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000
    });
    return res.redirect('/auftrag-info/' + encodeURIComponent(token));
  } catch (err) {
    console.error('unlock:', err.message);
    res.status(500).send('Fehler');
  }
});

router.get('/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const share = await loadShare(token);
    if (!share || share.revoked_at) {
      return res.status(404).send(pageShell('Link ungültig', '<p class="muted">Dieser Link ist ungültig oder wurde widerrufen.</p>'));
    }
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).send(pageShell('Abgelaufen', '<p class="muted">Dieser Link ist abgelaufen.</p>'));
    }

    const firma = await getFirma().catch(() => ({}));
    if (share.password_hash && !isUnlocked(req, token, share.token_hash)) {
      return res.send(passwordForm(token, firma));
    }

    const sections = parseSections(share.sections);
    const has = (s) => sections.includes(s);
    const projectId = share.project_id;

    let appointments = [], photos = [], measurements = [], files = [], statusLog = [];

    if (has('appointments')) {
      try {
        appointments = (await dbQuery(
          `SELECT title, start_date, end_date, description FROM appointments WHERE project_id = ? ORDER BY start_date ASC LIMIT 30`,
          [projectId]
        )).rows || [];
      } catch (e) { console.error('share appointments:', e.message); }
    }
    if (has('photos')) {
      try {
        photos = (await dbQuery(
          `SELECT file_url, caption, original_name, created_at FROM project_photos WHERE project_id = ? ORDER BY created_at DESC LIMIT 40`,
          [projectId]
        )).rows || [];
      } catch (e) { console.error('share photos:', e.message); }
    }
    if (has('measurements')) {
      try {
        measurements = (await dbQuery(
          `SELECT component_name, width, height, angle, quantity, note FROM project_measurements WHERE project_id = ? ORDER BY id DESC LIMIT 50`,
          [projectId]
        )).rows || [];
      } catch (e) { console.error('share measurements:', e.message); }
    }
    if (has('files')) {
      try {
        files = (await dbQuery(
          `SELECT filename, original_name, file_url, created_at FROM project_files WHERE project_id = ? ORDER BY created_at DESC LIMIT 30`,
          [projectId]
        )).rows || [];
      } catch (e) { console.error('share files:', e.message); }
    }
    if (has('status')) {
      try {
        statusLog = (await dbQuery(
          `SELECT old_status, new_status, changed_by, created_at FROM project_status_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`,
          [projectId]
        )).rows || [];
      } catch (e) { console.error('share status:', e.message); }
    }

    const addr = [share.street, [share.zip, share.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    let body = '';
    body += `<header class="hero">
      <p class="eyebrow">${esc(firma.nameKurz || firma.name || 'Metallbau')}</p>
      <h1>${esc(share.title || 'Auftrag')}</h1>
      <p class="status-pill">${esc(share.status || '')}</p>
      <p class="muted">${esc(share.company_name || share.contact_person || '')}</p>
    </header>`;

    if (has('overview')) {
      body += `<section class="card"><h2>Auftrag</h2>
        <dl class="grid">
          <div><dt>Status</dt><dd>${esc(share.status || '–')}</dd></div>
          ${addr ? `<div><dt>Adresse</dt><dd>${esc(addr)}</dd></div>` : ''}
          ${share.phone ? `<div><dt>Telefon</dt><dd>${esc(share.phone)}</dd></div>` : ''}
          ${share.site_note ? `<div class="wide"><dt>Hinweis Baustelle</dt><dd>${esc(share.site_note)}</dd></div>` : ''}
        </dl>
        ${share.description ? `<p class="desc">${esc(share.description)}</p>` : ''}
      </section>`;
    }
    if (has('appointments')) {
      body += `<section class="card"><h2>Termine</h2>`;
      body += !appointments.length ? `<p class="muted">Keine Termine hinterlegt.</p>` :
        `<ul class="list">` + appointments.map(a =>
          `<li><strong>${esc(fmtDay(a.start_date))}</strong><span>${esc(a.title || 'Termin')}</span>${a.description ? `<small>${esc(a.description)}</small>` : ''}</li>`
        ).join('') + `</ul>`;
      body += `</section>`;
    }
    if (has('measurements')) {
      body += `<section class="card"><h2>Aufmaß</h2>`;
      if (!measurements.length) body += `<p class="muted">Noch kein Aufmaß.</p>`;
      else {
        body += `<table><thead><tr><th>Bezeichnung</th><th>Maße</th><th>Anz.</th></tr></thead><tbody>`;
        body += measurements.map(m => {
          const dims = [m.width, m.height, m.angle].filter(Boolean).join(' × ');
          return `<tr><td>${esc(m.component_name || m.note || '–')}</td><td>${esc(dims || m.note || '–')}</td><td>${esc(m.quantity || 1)}</td></tr>`;
        }).join('') + `</tbody></table>`;
      }
      body += `</section>`;
    }
    if (has('photos')) {
      body += `<section class="card"><h2>Fotos</h2>`;
      body += !photos.length ? `<p class="muted">Noch keine Fotos.</p>` :
        `<div class="photos">` + photos.map(ph => {
          const src = ph.file_url || ph.url || '';
          return `<figure><a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt=""></a>${ph.caption ? `<figcaption>${esc(ph.caption)}</figcaption>` : ''}</figure>`;
        }).join('') + `</div>`;
      body += `</section>`;
    }
    if (has('files')) {
      body += `<section class="card"><h2>Dateien</h2>`;
      body += !files.length ? `<p class="muted">Keine Dateien.</p>` :
        `<ul class="list">` + files.map(f => {
          const href = f.file_url || f.url || '#';
          const name = f.original_name || f.filename || 'Datei';
          return `<li><a href="${esc(href)}" target="_blank" rel="noopener">${esc(name)}</a><small>${esc(fmtDate(f.created_at))}</small></li>`;
        }).join('') + `</ul>`;
      body += `</section>`;
    }
    if (has('status')) {
      body += `<section class="card"><h2>Status-Verlauf</h2>`;
      body += !statusLog.length ? `<p class="muted">Kein Verlauf.</p>` :
        `<ul class="list">` + statusLog.map(s =>
          `<li><strong>${esc(s.new_status || s.status || '')}</strong><small>${esc(fmtDate(s.created_at))}${s.changed_by ? ' · ' + esc(s.changed_by) : ''}</small>${s.old_status ? `<span class="muted">von ${esc(s.old_status)}</span>` : ''}</li>`
        ).join('') + `</ul>`;
      body += `</section>`;
    }
    body += `<footer class="foot muted">${esc(firma.name || '')}${firma.tel ? ' · ' + esc(firma.tel) : ''}${firma.email ? ' · ' + esc(firma.email) : ''}<br>Link gültig bis ${esc(fmtDate(share.expires_at))}</footer>`;

        res.send(pageShell(share.title || 'Auftrag', body, firma));
  } catch (err) {
    console.error('auftrag-info:', err.message);
    res.status(500).send(pageShell('Fehler', '<p class="muted">Seite konnte nicht geladen werden.</p><p class="muted" style="font-size:12px;margin-top:8px">' + esc(err.message || '') + '</p>'));
  }
});

function pageShell(title, body, firma = {}) {
  const primary = (firma.color_primary || '#4f46e5');
  return `<!DOCTYPE html><html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – Auftragsinfo</title>
<style>
:root{--p:${esc(primary)}}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;line-height:1.45}
.wrap{max-width:720px;margin:0 auto;padding:1.25rem 1rem 3rem}
.hero{margin-bottom:1rem}.eyebrow{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin:0 0 .35rem}
h1{margin:0 0 .4rem;font-size:1.45rem;letter-spacing:-.02em}h2{margin:0 0 .75rem;font-size:1rem}
.status-pill{display:inline-block;font-size:.75rem;font-weight:700;padding:.25rem .65rem;border-radius:999px;background:color-mix(in srgb,var(--p) 15%,#fff);color:var(--p);margin:.25rem 0 .5rem}
.muted{color:#64748b;font-size:.875rem}
.card{background:#fff;border-radius:1rem;padding:1rem 1.1rem;margin-bottom:.85rem;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgb(15 23 42/.04)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:.65rem .85rem;margin:0}.grid .wide{grid-column:1/-1}
dt{font-size:.65rem;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8;margin:0}dd{margin:.1rem 0 0;font-weight:600;font-size:.9rem}
.desc{margin:.85rem 0 0;font-size:.9rem;color:#334155;white-space:pre-wrap}
.list{list-style:none;margin:0;padding:0}.list li{padding:.55rem 0;border-bottom:1px solid #f1f5f9;display:flex;flex-direction:column;gap:.15rem}
.list li:last-child{border-bottom:0}.list small{color:#94a3b8;font-size:.75rem}
table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{text-align:left;padding:.45rem .3rem;border-bottom:1px solid #f1f5f9}
th{font-size:.65rem;text-transform:uppercase;color:#94a3b8}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.5rem}
.photos img{width:100%;height:120px;object-fit:cover;border-radius:.6rem;background:#e2e8f0}
.photos figcaption{font-size:.7rem;color:#64748b;margin-top:.25rem}
.foot{text-align:center;margin-top:1.5rem;font-size:.75rem}a{color:var(--p)}
@media(max-width:520px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

module.exports = { router, hashToken };
