/**
 * Öffentliche Kunden-Freigabe für Angebote (ohne Login).
 * Link: /angebot-freigabe/:token
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { dbQuery } = require('../utils/db');
const { getFirma } = require('../utils/companySettings');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  return Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function loadShare(token) {
  if (!token || token.length < 20) return null;
  const h = hashToken(token);
  const row = (await dbQuery(
    `SELECT t.*, d.doc_number, d.doc_type, d.status AS doc_status, d.subtotal, d.tax_rate, d.tax_amount,
            d.total_amount, d.discount_amount, d.discount_percent, d.customer_id,
            c.company_name, c.contact_person
     FROM document_share_tokens t
     JOIN documents d ON d.id = t.document_id
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE t.token_hash = ?`,
    [h]
  )).rows?.[0];
  return row || null;
}

router.get('/:token', async (req, res) => {
  try {
    const share = await loadShare(req.params.token);
    if (!share || share.revoked_at) {
      return res.status(404).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:3rem">Link ungültig oder widerrufen.</h2>');
    }
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:3rem">Dieser Freigabe-Link ist abgelaufen.</h2>');
    }
    if (share.doc_type !== 'OFFER') {
      return res.status(400).send('Nur Angebote können freigegeben werden.');
    }

    const items = (await dbQuery(
      `SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC`,
      [share.document_id]
    )).rows || [];
    const firma = await getFirma().catch(() => ({}));
    const already = !!(share.approved_at || share.rejected_at);

    const rowsHtml = items.map(i => {
      const line = num(i.quantity) * num(i.unit_price) * (1 - num(i.discount_percent) / 100);
      return `<tr>
        <td>${esc(i.description)}</td>
        <td style="text-align:right">${Number(i.quantity).toLocaleString('de-DE')} ${esc(i.unit || '')}</td>
        <td style="text-align:right">${money(i.unit_price)}</td>
        <td style="text-align:right">${money(line)}</td>
      </tr>`;
    }).join('');

    const statusBanner = share.approved_at
      ? `<div class="ok">✅ Freigegeben am ${new Date(share.approved_at).toLocaleString('de-DE')}${share.signer_name ? ' von ' + esc(share.signer_name) : ''}</div>`
      : share.rejected_at
        ? `<div class="no">❌ Abgelehnt am ${new Date(share.rejected_at).toLocaleString('de-DE')}</div>`
        : `<div class="wait">Ausstehende Freigabe</div>`;

    res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Angebot ${esc(share.doc_number)} – Freigabe</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#0f172a;background:#f8fafc}
  h1{font-size:1.35rem;margin:0 0 .25rem}
  .muted{color:#64748b;font-size:.875rem}
  table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.875rem;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  th{text-align:left;background:#f1f5f9;padding:.65rem .75rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
  td{padding:.65rem .75rem;border-top:1px solid #e2e8f0}
  .total{font-weight:700;text-align:right}
  .card{background:#fff;border-radius:12px;padding:1rem 1.1rem;box-shadow:0 1px 3px rgba(0,0,0,.06);margin:1rem 0}
  .ok{background:#ecfdf5;color:#047857;padding:.75rem 1rem;border-radius:10px;font-weight:600;margin:1rem 0}
  .no{background:#fef2f2;color:#b91c1c;padding:.75rem 1rem;border-radius:10px;font-weight:600;margin:1rem 0}
  .wait{background:#fffbeb;color:#b45309;padding:.55rem .9rem;border-radius:999px;display:inline-block;font-size:.8rem;font-weight:600}
  label{display:block;font-size:.8rem;font-weight:600;color:#475569;margin:.6rem 0 .25rem}
  input,textarea{width:100%;padding:.7rem .8rem;border:1px solid #e2e8f0;border-radius:10px;font-size:.95rem;box-sizing:border-box}
  .btn{display:block;width:100%;padding:.9rem 1rem;border:none;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;margin-top:.5rem}
  .btn-ok{background:#16a34a;color:#fff}
  .btn-no{background:#f1f5f9;color:#334155}
</style>
</head>
<body>
  <p class="muted">${esc(firma.nameKurz || firma.name || 'Metallbau')} · Angebot</p>
  <h1>Angebot ${esc(share.doc_number || share.document_id)}</h1>
  <p class="muted">${esc(share.company_name || share.contact_person || 'Kunde')}</p>
  ${statusBanner}
  <table>
    <thead><tr><th>Position</th><th style="text-align:right">Menge</th><th style="text-align:right">EP €</th><th style="text-align:right">Summe €</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="4">Keine Positionen</td></tr>'}</tbody>
    <tfoot>
      <tr><td colspan="3" class="total">Netto</td><td class="total">${money((share.subtotal || 0) - (share.discount_amount || 0))} €</td></tr>
      <tr><td colspan="3" class="total">MwSt. ${esc(share.tax_rate || 19)} %</td><td class="total">${money(share.tax_amount)} €</td></tr>
      <tr><td colspan="3" class="total">Brutto</td><td class="total">${money(share.total_amount)} €</td></tr>
    </tfoot>
  </table>
  ${already ? '' : `
  <div class="card">
    <form method="POST" action="/angebot-freigabe/${esc(req.params.token)}/decide">
      <label>Ihr Name *</label>
      <input name="signer_name" required maxlength="120" placeholder="Vor- und Nachname">
      <label>Anmerkung (optional)</label>
      <textarea name="signer_note" rows="3" maxlength="1000" placeholder="Optionaler Kommentar"></textarea>
      <button class="btn btn-ok" type="submit" name="decision" value="approve">✅ Angebot freigeben</button>
      <button class="btn btn-no" type="submit" name="decision" value="reject">Ablehnen</button>
    </form>
  </div>`}
  <p class="muted" style="margin-top:2rem;text-align:center">Powered by ${(esc(firma.nameKurz || 'Metallbau-App'))}</p>
</body></html>`);
  } catch (err) {
    console.error('Angebot-Freigabe:', err.message);
    res.status(500).send('Fehler beim Laden.');
  }
});

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

router.post('/:token/decide', async (req, res) => {
  try {
    const share = await loadShare(req.params.token);
    if (!share || share.revoked_at) return res.status(404).send('Link ungültig.');
    if (share.expires_at && new Date(share.expires_at) < new Date()) return res.status(410).send('Link abgelaufen.');
    if (share.approved_at || share.rejected_at) return res.redirect('/angebot-freigabe/' + req.params.token);

    const name = String(req.body.signer_name || '').trim();
    if (!name) return res.status(400).send('Name ist erforderlich.');
    const note = String(req.body.signer_note || '').trim() || null;
    const decision = req.body.decision === 'reject' ? 'reject' : 'approve';
    const now = new Date().toISOString();

    if (decision === 'approve') {
      await dbQuery(
        `UPDATE document_share_tokens SET approved_at=?, rejected_at=NULL, signer_name=?, signer_note=? WHERE id=?`,
        [now, name, note, share.id]
      );
      await dbQuery(`UPDATE documents SET status = 'FREIGEGEBEN' WHERE id = ? AND doc_type = 'OFFER'`, [share.document_id]);
    } else {
      await dbQuery(
        `UPDATE document_share_tokens SET rejected_at=?, approved_at=NULL, signer_name=?, signer_note=? WHERE id=?`,
        [now, name, note, share.id]
      );
      await dbQuery(`UPDATE documents SET status = 'ABGELEHNT' WHERE id = ? AND doc_type = 'OFFER'`, [share.document_id]);
    }
    res.redirect('/angebot-freigabe/' + req.params.token);
  } catch (err) {
    console.error('Angebot decide:', err.message);
    res.status(500).send('Fehler beim Speichern.');
  }
});

module.exports = { router, hashToken };
