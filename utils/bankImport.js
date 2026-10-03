/**
 * Einfacher Bank-CSV-Import zum Abgleich offener Rechnungen.
 * Unterstützt gängige Formate (Spalten: Datum;Betrag;Verwendungszweck / oder englisch).
 */
const { dbQuery } = require('./db');

function parseGermanAmount(s) {
  if (s == null) return NaN;
  let t = String(s).trim().replace(/\s/g, '').replace(/€/g, '');
  // 1.234,56 → 1234.56
  if (/\d\.\d{3},\d{2}$/.test(t) || (t.includes(',') && t.includes('.'))) {
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (t.includes(',')) {
    t = t.replace(',', '.');
  }
  return parseFloat(t);
}

function detectDelimiter(line) {
  const semi = (line.match(/;/g) || []).length;
  const comma = (line.match(/,/g) || []).length;
  return semi >= comma ? ';' : ',';
}

/**
 * Parst CSV-Text zu Buchungszeilen { date, amount, reference, raw }
 */
function parseBankCsv(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const delim = detectDelimiter(lines[0]);
  const header = lines[0].split(delim).map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());

  const idxDate = header.findIndex((h) =>
    /datum|date|buchung|valuta|wertstellung/.test(h)
  );
  const idxAmount = header.findIndex((h) =>
    /betrag|amount|umsatz|soll|haben/.test(h)
  );
  const idxRef = header.findIndex((h) =>
    /verwendungszweck|zweck|reference|buchungstext|text|beschreibung|empfänger|auftraggeber/.test(h)
  );

  // Fallback: erste Spalten raten
  const dIdx = idxDate >= 0 ? idxDate : 0;
  const aIdx = idxAmount >= 0 ? idxAmount : Math.min(1, header.length - 1);
  const rIdx = idxRef >= 0 ? idxRef : Math.min(2, header.length - 1);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim).map((c) => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 2) continue;
    const amount = parseGermanAmount(cols[aIdx]);
    if (!Number.isFinite(amount) || amount === 0) continue;
    // Nur Gutschriften (positive Beträge) für Zahlungseingänge
    const credit = amount > 0 ? amount : Math.abs(amount);
    rows.push({
      date: cols[dIdx] || '',
      amount: credit,
      reference: cols[rIdx] || cols.join(' '),
      raw: lines[i],
    });
  }
  return rows;
}

/**
 * Versucht offene Rechnungen anhand Betrag und/oder Rechnungsnummer im Verwendungszweck zuzuordnen.
 * Bucht Treffer als invoice_payments und aktualisiert paid_amount/status.
 */
async function matchAndBookPayments(entries, { dryRun = false } = {}) {
  const openRes = await dbQuery(`
    SELECT d.id, d.doc_number, d.total_amount, COALESCE(d.paid_amount, 0) AS paid_amount, d.status
    FROM documents d
    WHERE d.doc_type = 'INVOICE'
      AND d.status NOT IN ('Bezahlt', 'Storniert', 'Gutschrift')
  `);
  const open = (openRes.rows || []).map((r) => ({
    ...r,
    open: Math.max(0, parseFloat(r.total_amount || 0) - parseFloat(r.paid_amount || 0)),
  })).filter((r) => r.open > 0.01);

  const matched = [];
  const unmatched = [];
  const usedInvoiceIds = new Set();

  for (const entry of entries) {
    const ref = String(entry.reference || '');
    let hit = null;

    // 1) Rechnungsnummer im Verwendungszweck
    for (const inv of open) {
      if (usedInvoiceIds.has(inv.id)) continue;
      const nr = String(inv.doc_number || '');
      if (nr && ref.includes(nr)) {
        hit = inv;
        break;
      }
    }

    // 2) Betrag (Toleranz 0.02 €) – nur wenn eindeutig
    if (!hit) {
      const candidates = open.filter(
        (inv) => !usedInvoiceIds.has(inv.id) && Math.abs(inv.open - entry.amount) < 0.02
      );
      if (candidates.length === 1) hit = candidates[0];
    }

    if (!hit) {
      unmatched.push(entry);
      continue;
    }

    usedInvoiceIds.add(hit.id);
    matched.push({ entry, invoice: hit });

    if (!dryRun) {
      const payDate = entry.date || new Date().toISOString().slice(0, 10);
      try {
        await dbQuery(
          `INSERT INTO invoice_payments (document_id, amount, payment_date, method, note) VALUES (?, ?, ?, ?, ?)`,
          [hit.id, entry.amount, payDate, 'Überweisung', `Bank-Import: ${ref.slice(0, 120)}`]
        );
      } catch (_) {
        try {
          await dbQuery(
            `INSERT INTO invoice_payments (document_id, amount, payment_date, note) VALUES (?, ?, ?, ?)`,
            [hit.id, entry.amount, payDate, `Bank-Import: ${ref.slice(0, 120)}`]
          );
        } catch (__) {}
      }

      const newPaid = parseFloat(hit.paid_amount || 0) + entry.amount;
      const total = parseFloat(hit.total_amount || 0);
      const status = newPaid + 0.01 >= total ? 'Bezahlt' : 'Teilbezahlt';
      await dbQuery(`UPDATE documents SET paid_amount = ?, status = ? WHERE id = ?`, [
        newPaid,
        status,
        hit.id,
      ]);
    }
  }

  return { matched, unmatched };
}

module.exports = { parseBankCsv, matchAndBookPayments, parseGermanAmount };
