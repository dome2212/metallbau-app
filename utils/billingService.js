const crypto = require("crypto");
const { withTransaction } = require("./db");
const { nextDocumentNumber } = require("./documentNumbers");
const { calculate, number } = require("../Public/js/billing-math");
const isPg = !!process.env.DATABASE_URL;
const problem = (status, message) =>
  Object.assign(new Error(message), { status });
const detailUrl = (doc) =>
  doc.doc_type === "OFFER"
    ? `/documents/offers/${doc.id}/detail`
    : `/documents/invoices/${doc.id}`;
function date(value) {
  if (value === "" || value == null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw problem(400, "Bitte ein gültiges Datum eingeben.");
  return value;
}
function revision(doc, items) {
  const fields = [
    "doc_type",
    "doc_number",
    "customer_id",
    "status",
    "tax_rate",
    "subtotal",
    "tax_amount",
    "total_amount",
    "due_date",
    "discount_percent",
    "discount_amount",
    "status_note",
    "invoice_subtype",
  ];
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        fields.map((k) => String(doc[k] ?? "")),
        items.map((it) =>
          [
            "id",
            "description",
            "quantity",
            "unit",
            "price",
            "discount_percent",
          ].map((k) => String(it[k] ?? "")),
        ),
      ]),
    )
    .digest("hex");
}
async function save(input, firma, id) {
  if (!["angebot", "rechnung"].includes(input.type))
    throw problem(400, "Bitte eine gültige Belegart auswählen.");
  const docType = input.type === "angebot" ? "OFFER" : "INVOICE";
  if (input.project_id && docType !== "INVOICE")
    throw problem(400, "Aufträge werden als Rechnung abgerechnet.");
  return withTransaction(async (tx) => {
    let original;
    if (id) {
      original = (
        await tx.query(
          "SELECT * FROM documents WHERE id = ? AND doc_type = ?" +
            (isPg ? " FOR UPDATE" : ""),
          [id, docType],
        )
      ).rows[0];
      if (!original) throw problem(404, "Beleg nicht gefunden.");
      if (input.revision) {
        const oldItems = (
          await tx.query(
            "SELECT * FROM document_items WHERE document_id = ? ORDER BY id",
            [original.id],
          )
        ).rows;
        if (input.revision !== revision(original, oldItems))
          throw problem(
            409,
            "Der Beleg wurde inzwischen geändert. Bitte die Seite neu laden und die Änderungen vergleichen.",
          );
      }
      if (docType === "OFFER" && original.status === "ANGENOMMEN")
        throw problem(
          409,
          "Angenommene Angebote können nicht geändert werden.",
        );
      if (
        docType === "INVOICE" &&
        !["ENTWURF", "Entwurf"].includes(original.status)
      )
        throw problem(
          409,
          "Nur Rechnungsentwürfe können bearbeitet werden. Nutzen Sie bei ausgestellten Rechnungen Storno oder Gutschrift.",
        );
    }
    let project;
    if (!original && input.project_id) {
      project = (
        await tx.query(
          "SELECT * FROM projects WHERE id = ?" + (isPg ? " FOR UPDATE" : ""),
          [input.project_id],
        )
      ).rows[0];
      if (!project || project.deleted_at)
        throw problem(404, "Auftrag nicht gefunden.");
    }
    const customerId = Number(
      project?.customer_id ?? input.customer_id ?? original?.customer_id,
    );
    if (
      !Number.isSafeInteger(customerId) ||
      customerId <= 0 ||
      !(await tx.query("SELECT id FROM customers WHERE id = ?", [customerId]))
        .rows.length
    )
      throw problem(400, "Bitte einen vorhandenen Kunden auswählen.");
    const klein = String(firma.kleinunternehmer).toLowerCase() === "true";
    // Preserve existing offer tax settings. Historical PDFs apply the company exemption separately.
    const taxRate =
      docType === "OFFER" && original
        ? (original.tax_rate ?? 19)
        : docType === "INVOICE" && klein
          ? 0
          : (input.tax_rate ??
            original?.tax_rate ??
            firma.default_tax_rate ??
            19);
    const totals = calculate(
      input.items,
      taxRate,
      input.discount_percent_doc ?? original?.discount_percent ?? 0,
      input.discount_amount_doc ?? original?.discount_amount ?? 0,
    );
    let due =
      input.due_date === undefined ? original?.due_date : date(input.due_date);
    if (!original && docType === "INVOICE" && input.due_date === undefined) {
      const d = new Date();
      d.setDate(d.getDate() + (parseInt(firma.zahlungsfrist, 10) || 14));
      due = d.toISOString().slice(0, 10);
    }
    const note = String(
      input.status_note ?? original?.status_note ?? "",
    ).trim();
    if (note.length > 4000) throw problem(400, "Die Notiz ist zu lang.");
    const subtype = String(
      input.invoice_subtype ?? original?.invoice_subtype ?? "",
    ).toUpperCase();
    if (
      !["", "STANDARD", "PARTIAL", "FINAL", "TEIL", "SCHLUSS"].includes(subtype)
    )
      throw problem(400, "Ungültige Rechnungsart.");
    let docId = original?.id;
    if (!original) {
      const prefix = String(
        (docType === "OFFER" ? firma.offer_prefix : firma.invoice_prefix) ||
          (docType === "OFFER" ? "ANG" : "RECH"),
      ).toUpperCase();
      const nr = await nextDocumentNumber(
        tx,
        docType,
        prefix,
        new Date().getFullYear(),
      );
      const r = await tx.query(
        `INSERT INTO documents (doc_type,doc_number,customer_id,status,tax_rate,subtotal,tax_amount,total_amount,due_date,discount_percent,discount_amount,status_note,invoice_subtype${project ? ",project_id" : ""}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?${project ? ",?" : ""})${isPg ? " RETURNING id" : ""}`,
        [
          docType,
          nr,
          customerId,
          docType === "OFFER" ? "OFFEN" : "ENTWURF",
          totals.tax_rate,
          totals.subtotal,
          totals.tax_amount,
          totals.total_amount,
          due || null,
          totals.discount_percent,
          totals.discount_amount,
          note || null,
          subtype || null,
          ...(project ? [project.id] : []),
        ],
      );
      docId = r.lastID || r.rows?.[0]?.id;
      if (!docId)
        throw problem(500, "Belegkennung konnte nicht ermittelt werden.");
    } else {
      await tx.query(
        "UPDATE documents SET customer_id = ?, tax_rate = ?, subtotal = ?, tax_amount = ?, total_amount = ?, due_date = ?, discount_percent = ?, discount_amount = ?, status_note = ?, invoice_subtype = ? WHERE id = ?",
        [
          customerId,
          totals.tax_rate,
          totals.subtotal,
          totals.tax_amount,
          totals.total_amount,
          due || null,
          totals.discount_percent,
          totals.discount_amount,
          note || null,
          subtype || null,
          docId,
        ],
      );
      await tx.query("DELETE FROM document_items WHERE document_id = ?", [
        docId,
      ]);
    }
    for (const it of totals.items)
      await tx.query(
        "INSERT INTO document_items (document_id,description,quantity,unit,price,discount_percent) VALUES (?,?,?,?,?,?)",
        [
          docId,
          it.description,
          it.quantity,
          it.unit,
          it.price,
          it.discount_percent,
        ],
      );
    if (project)
      await tx.query(
        "UPDATE projects SET status = 'Abgeschlossen' WHERE id = ?",
        [project.id],
      );
    return { id: docId, doc_type: docType, ...totals };
  });
}
async function issue(id, expectedRevision) {
  return withTransaction(async (tx) => {
    const doc = (
      await tx.query(
        "SELECT * FROM documents WHERE id = ? AND doc_type = 'INVOICE'" +
          (isPg ? " FOR UPDATE" : ""),
        [id],
      )
    ).rows[0];
    if (!doc) throw problem(404, "Rechnung nicht gefunden.");
    if (["ENTWURF", "Entwurf"].includes(doc.status)) {
      if (expectedRevision) {
        const items = (await tx.query("SELECT * FROM document_items WHERE document_id = ? ORDER BY id", [id])).rows;
        if (revision(doc, items) !== expectedRevision) throw problem(409, "Die Rechnung wurde inzwischen geändert. Bitte das PDF erneut öffnen.");
      }
      await tx.query("UPDATE documents SET status = 'Offen' WHERE id = ?", [
        id,
      ]);
    }
    return doc;
  });
}
async function remove(id, docType) {
  return withTransaction(async (tx) => {
    const doc = (
      await tx.query(
        "SELECT * FROM documents WHERE id = ? AND doc_type = ?" +
          (isPg ? " FOR UPDATE" : ""),
        [id, docType],
      )
    ).rows[0];
    if (!doc) throw problem(404, "Beleg nicht gefunden.");
    if (
      (docType === "INVOICE" && !["ENTWURF", "Entwurf"].includes(doc.status)) ||
      (docType === "OFFER" && doc.status === "ANGENOMMEN")
    )
      throw problem(409, "Dieser Beleg kann nicht gelöscht werden.");
    const linked = await tx.query(
      "SELECT id FROM documents WHERE related_document_id = ? OR parent_document_id = ?",
      [id, id],
    );
    if (linked.rows.length)
      throw problem(409, "Der Beleg wird von anderen Belegen verwendet.");
    if (docType === "INVOICE") {
      const payments = await tx.query(
        "SELECT id FROM invoice_payments WHERE document_id = ?",
        [id],
      );
      if (payments.rows.length)
        throw problem(
          409,
          "Belege mit Zahlungen können nicht gelöscht werden.",
        );
      await tx.query("DELETE FROM dunning_history WHERE document_id = ?", [id]);
    } else {
      const additions = (
        await tx.query(
          "SELECT id FROM offer_nachtraege WHERE document_id = ?",
          [id],
        )
      ).rows;
      for (const n of additions)
        await tx.query(
          "DELETE FROM offer_nachtrag_items WHERE nachtrag_id = ?",
          [n.id],
        );
      await tx.query("DELETE FROM offer_nachtraege WHERE document_id = ?", [
        id,
      ]);
    }
    await tx.query("DELETE FROM document_items WHERE document_id = ?", [id]);
    await tx.query("DELETE FROM documents WHERE id = ?", [id]);
  });
}
async function payment(id, input, userId, removeId) {
  return withTransaction(async (tx) => {
    const doc = (
      await tx.query(
        "SELECT * FROM documents WHERE id = ? AND doc_type = 'INVOICE'" +
          (isPg ? " FOR UPDATE" : ""),
        [id],
      )
    ).rows[0];
    if (!doc) throw problem(404, "Rechnung nicht gefunden.");
    if (doc.status === "Storniert")
      throw problem(409, "Stornierte Rechnungen können nicht bebucht werden.");
    if (removeId)
      await tx.query(
        "DELETE FROM invoice_payments WHERE id = ? AND document_id = ?",
        [removeId, id],
      );
    else {
      const amount = number(input.amount),
        paymentDate = date(
          input.payment_date || new Date().toISOString().slice(0, 10),
        );
      const method = String(input.method || "Überweisung").trim(),
        note = String(input.note || "").trim();
      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > 1000000000 ||
        !method ||
        method.length > 80 ||
        note.length > 4000
      )
        throw problem(400, "Bitte Betrag, Zahlungsart und Notiz prüfen.");
      await tx.query(
        "INSERT INTO invoice_payments (document_id,amount,payment_date,method,note,created_by) VALUES (?,?,?,?,?,?)",
        [id, amount, paymentDate, method, note, userId],
      );
    }
    const result = (
      await tx.query(
        "SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_payments WHERE document_id = ?",
        [id],
      )
    ).rows[0];
    const paid = Number(result.paid),
      total = Number(doc.total_amount);
    const status =
      paid <= 0.001
        ? ["Bezahlt", "Teilbezahlt"].includes(doc.status)
          ? "Offen"
          : doc.status
        : paid + 0.01 >= total
          ? "Bezahlt"
          : "Teilbezahlt";
    await tx.query(
      "UPDATE documents SET paid_amount = ?, status = ? WHERE id = ?",
      [paid, status, id],
    );
    return doc;
  });
}
module.exports = {
  save,
  detailUrl,
  date,
  problem,
  revision,
  issue,
  remove,
  payment,
};
