const { withTransaction } = require("./db");
const isPg = !!process.env.DATABASE_URL;
// Number reservations and writes share the same transaction lock.
async function nextDocumentNumber(tx, docType, prefix, year) {
  if (isPg) await tx.query("SELECT pg_advisory_xact_lock(1900587937)");
  await tx.query(
    "CREATE TABLE IF NOT EXISTS document_number_sequences (doc_type TEXT NOT NULL, prefix TEXT NOT NULL, year INTEGER NOT NULL, last_number INTEGER NOT NULL, PRIMARY KEY (doc_type,prefix,year))",
  );
  const result = await tx.query(
    "SELECT doc_number FROM documents WHERE doc_type = ?",
    [docType],
  );
  const sequence = await tx.query(
    "SELECT last_number FROM document_number_sequences WHERE doc_type = ? AND prefix = ? AND year = ?",
    [docType, prefix, year],
  );
  const base = `${prefix}-${year}-`;
  let max = Number(sequence.rows[0]?.last_number || 0);
  for (const row of result.rows) {
    const number = String(row.doc_number || "");
    const suffix = number.startsWith(base) ? number.slice(base.length) : "";
    if (/^\d+$/.test(suffix)) max = Math.max(max, Number(suffix));
  }
  if (!Number.isSafeInteger(max) || max >= 999999999)
    throw Error("Keine freie Belegnummer verfügbar.");
  const next = max + 1;
  await tx.query(
    "INSERT INTO document_number_sequences (doc_type,prefix,year,last_number) VALUES (?,?,?,?) ON CONFLICT (doc_type,prefix,year) DO UPDATE SET last_number = excluded.last_number",
    [docType, prefix, year, next],
  );
  return base + String(next).padStart(4, "0");
}
const reserveDocumentNumber = (type, prefix, year) =>
  withTransaction((tx) => nextDocumentNumber(tx, type, prefix, year));

module.exports = { nextDocumentNumber, reserveDocumentNumber };
