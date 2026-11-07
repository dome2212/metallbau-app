const router = require("express").Router();
const { dbQuery } = require("../utils/db");
const { requireAdmin, hasPerm, canSeeMoney } = require("../middleware/auth");
const { getFirma } = require("../utils/companySettings");
const billing = require("../utils/billingService");
const money = (n) =>
  Number(n || 0).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });
const day = (value) =>
  value ? new Date(value).toLocaleDateString("de-DE") : "—";
const endpoint = (d) =>
  `/documents/${d.doc_type === "OFFER" ? "offers" : "invoices"}/${d.id}`;
const editable = (d) =>
  d.doc_type === "OFFER"
    ? d.status !== "ANGENOMMEN"
    : d.doc_type === "INVOICE" && ["ENTWURF", "Entwurf"].includes(d.status);
function guarded(handler, amounts = false) {
  return [
    requireAdmin,
    async (req, res, next) => {
      try {
        const firma = await getFirma();
        if (
          !hasPerm(req.user, "documents", firma, true, false) ||
          (amounts && !canSeeMoney(req.user, firma))
        )
          return res
            .status(403)
            .send("Keine Berechtigung für diesen Belegbereich.");
        await handler(req, res, {
          firma,
          canSeeMoney: canSeeMoney(req.user, firma),
          money,
          day,
          endpoint,
          detailUrl: billing.detailUrl,
          editable,
          forceDelete: process.env.BELEGE_LOESCHEN !== "false" && req.user.role === "ADMIN",
        });
      } catch (error) {
        console.error("Belegbereich:", error.message);
        const status = error.status || 500,
          message = error.status
            ? error.message
            : "Der Belegbereich konnte nicht geladen werden. Bitte erneut versuchen.";
        if (req.is("application/json"))
          return res.status(status).json({ ok: false, error: message });
        res.status(status).send(message);
      }
    },
  ];
}
const list = (viewScope) =>
  guarded(async (req, res, locals) => {
    const docs = (
      await dbQuery(
        `SELECT d.*, c.company_name,c.contact_person FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.doc_type IN ('OFFER','INVOICE','CREDIT') ORDER BY d.created_at DESC,d.id DESC`,
      )
    ).rows;
    res.render("billing/list", { ...locals, docs, viewScope, query: req.query });
  });
router.get(
  "/forderungen",
  ...guarded(async (req, res, locals) => {
    const docs = (
      await dbQuery(
        "SELECT d.*,c.company_name,c.contact_person,c.email FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.doc_type='INVOICE'",
      )
    ).rows;
    const invoices = require("../utils/receivables").prepare(docs);
    res.render("billing/receivables", { ...locals, invoices });
  }, true),
);
router.get("/buero", ...list("all"));
router.get("/offers", ...list("OFFER"));
router.get("/invoices", ...list("INVOICE"));
async function load(id) {
  const doc = (
    await dbQuery(
      `SELECT d.*,c.company_name,c.contact_person,c.street,c.zip,c.city,c.email FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=? AND d.doc_type IN ('OFFER','INVOICE','CREDIT')`,
      [id],
    )
  ).rows[0];
  if (!doc) throw billing.problem(404, "Beleg nicht gefunden.");
  const items = (
    await dbQuery(
      "SELECT * FROM document_items WHERE document_id=? ORDER BY id",
      [id],
    )
  ).rows;
  return { doc, items };
}
async function editor(req, res, locals) {
  const existing = req.params.id
    ? await load(req.params.id)
    : { doc: null, items: [] };
  let project = null;
  if (!existing.doc && req.query.project_id) {
    project = (
      await dbQuery("SELECT * FROM projects WHERE id = ?", [
        req.query.project_id,
      ])
    ).rows[0];
    if (!project || project.deleted_at)
      throw billing.problem(404, "Auftrag nicht gefunden.");
    existing.items = await require("../utils/billingProject").projectItems(
      project.id,
    );
  }
  if (existing.doc && !editable(existing.doc))
    throw billing.problem(
      409,
      "Dieser Beleg kann nicht mehr bearbeitet werden.",
    );
  const type = existing.doc
    ? existing.doc.doc_type === "OFFER"
      ? "angebot"
      : "rechnung"
    : req.params.type;
  if (!["angebot", "rechnung"].includes(type))
    throw billing.problem(404, "Belegart nicht gefunden.");
  const [customers, articles] = await Promise.all([
    dbQuery(
      "SELECT id,company_name,contact_person,street,zip,city,email FROM customers ORDER BY company_name",
    ),
    dbQuery("SELECT id,title,unit,unit_price FROM articles ORDER BY title"),
  ]);
  let snippets = [];
  try {
    snippets = JSON.parse(locals.firma.text_snippets || "[]");
  } catch (_) {}
  const klein = String(locals.firma.kleinunternehmer).toLowerCase() === "true";
  const taxRate =
    type === "rechnung" && klein
      ? 0
      : (existing.doc?.tax_rate ??
        (klein ? 0 : Number(locals.firma.default_tax_rate ?? 19)));
  res.render("billing/editor", {
    ...locals,
    ...existing,
    project,
    type,
    customers: customers.rows,
    articles: articles.rows,
    snippets: Array.isArray(snippets) ? snippets : [],
    taxRate,
    preCustomer: project?.customer_id || req.query.customer_id || "",
    draftOwner: String(req.user.id),
    revision: existing.doc
      ? billing.revision(existing.doc, existing.items)
      : null,
  });
}
router.get("/neu/:type", ...guarded(editor, true));
router.get("/belege/:id/bearbeiten", ...guarded(editor, true));
async function detail(req, res, locals) {
  const data = await load(req.params.id);
  if (
    (req.path.startsWith("/offers/") && data.doc.doc_type !== "OFFER") ||
    (req.path.startsWith("/invoices/") &&
      !["INVOICE", "CREDIT"].includes(data.doc.doc_type))
  )
    throw billing.problem(404, "Beleg nicht gefunden.");
  let payments = [],
    history = [],
    additions = [];
  if (data.doc.doc_type === "INVOICE") {
    payments = (
      await dbQuery(
        "SELECT * FROM invoice_payments WHERE document_id=? ORDER BY payment_date DESC,id DESC",
        [data.doc.id],
      )
    ).rows;
    history = (
      await dbQuery(
        "SELECT * FROM dunning_history WHERE document_id=? ORDER BY id DESC",
        [data.doc.id],
      )
    ).rows;
  } else if (data.doc.doc_type === "OFFER") {
    additions = (
      await dbQuery(
        "SELECT * FROM offer_nachtraege WHERE document_id=? ORDER BY id",
        [data.doc.id],
      )
    ).rows;
    for (const n of additions)
      n.items = (
        await dbQuery(
          "SELECT * FROM offer_nachtrag_items WHERE nachtrag_id=? ORDER BY id",
          [n.id],
        )
      ).rows;
  }
  const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
  res.render("billing/detail", {
    ...locals,
    ...data,
    payments,
    history,
    additions,
    paid,
    open: Math.max(0, Number(data.doc.total_amount) - paid),
    saved: !!req.query.saved,
    sent: !!req.query.sent,
    mailError: String(req.query.mailerr || ""),
  });
}
router.get("/offers/:id/detail", ...guarded(detail));
router.get("/invoices/:id(\\d+)", ...guarded(detail));
router.get(
  "/fertig/:id",
  ...guarded(async (req, res) => {
    const { doc } = await load(req.params.id),
      q = new URLSearchParams();
    for (const k of ["sent", "mailerr"])
      if (req.query[k]) q.set(k, String(req.query[k]));
    q.set("saved", "1");
    res.redirect(billing.detailUrl(doc) + "?" + q);
  }),
);
const asArray = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
function formInput(body, type) {
  const descriptions = asArray(body.description ?? body.title),
    quantities = asArray(body.quantity),
    units = asArray(body.unit),
    prices = asArray(body.price),
    discounts = asArray(body.discount_percent);
  return {
    ...body,
    type,
    items: descriptions.map((description, i) => ({
      description,
      quantity: quantities[i],
      unit: units[i] || "Stk",
      price: prices[i],
      discount_percent: discounts[i] ?? 0,
    })),
  };
}
router.post(
  ["/belege/kunden", "/wizard/customer"],
  ...guarded(async (req, res) => {
    const fields = [
      "company_name",
      "contact_person",
      "email",
      "phone",
      "street",
      "zip",
      "city",
    ];
    const values = fields.map((key) => String(req.body[key] || "").trim());
    if (!values[0] && !values[1])
      throw billing.problem(400, "Bitte Firma oder Namen eingeben.");
    if (
      values.some((value) => value.length > 254) ||
      (values[2] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values[2]))
    )
      throw billing.problem(
        400,
        "Bitte Kundendaten und E-Mail-Adresse prüfen.",
      );
    values[0] ||= values[1];
    const result = await dbQuery(
      "INSERT INTO customers (company_name,contact_person,email,phone,street,zip,city) VALUES (?,?,?,?,?,?,?)",
      values.map((v) => v || null),
    );
    const id = result.lastID || result.rows?.[0]?.id;
    if (!id)
      throw billing.problem(
        500,
        "Kundenkennung konnte nicht ermittelt werden.",
      );
    res.json({ ok: true, id, label: values[0] });
  }),
);
const save = (type, legacy = false) =>
  guarded(async (req, res, locals) => {
    const input = legacy ? formInput(req.body, type) : req.body;
    const doc = await billing.save(input, locals.firma, req.params.id);
    const url = billing.detailUrl(doc) + "?saved=1";
    if (req.is("application/json")) res.json({ ok: true, id: doc.id, url });
    else res.redirect(url);
  }, true);
router.post(
  "/belege/:id/ausstellen",
  ...guarded(async (req, res) => {
    const doc = await billing.issue(req.params.id);
    res.redirect(billing.detailUrl(doc) + "?saved=1");
  }, true),
);
for (const [route, type, field] of [
  ["offers", "OFFER", "offer_id"],
  ["invoices", "INVOICE", "invoice_id"],
])
  router.post(
    "/" + route + "/delete",
    ...guarded(async (req, res) => {
      await billing.remove(req.body[field], type);
      res.redirect("/documents/" + route);
    }, true),
  );
// Testphase: beliebige Belege (auch versandte/bezahlte Rechnungen) endgültig löschen.
// Zum Sperren (Produktivbetrieb) in der .env  BELEGE_LOESCHEN=false  setzen.
const forceDeleteAllowed = () => process.env.BELEGE_LOESCHEN !== "false";
router.post(
  "/belege/loeschen",
  ...guarded(async (req, res) => {
    if (!forceDeleteAllowed())
      throw billing.problem(403, "Löschen von Belegen ist deaktiviert (BELEGE_LOESCHEN=false).");
    const raw = [].concat(req.body.ids || req.body.id || []);
    const ids = [...new Set(raw.map((v) => String(v)).filter((v) => /^\d+$/.test(v)))].slice(0, 500);
    let n = 0;
    for (const id of ids) if (await billing.forceRemove(id)) n++;
    res.redirect("/documents/buero?geloescht=" + n);
  }, true),
);
router.post(
  "/invoices/:id/payments",
  ...guarded(async (req, res) => {
    const doc = await billing.payment(req.params.id, req.body, req.user.id);
    res.redirect(billing.detailUrl(doc) + "?saved=1#zahlungen");
  }, true),
);
router.post(
  "/invoices/:id/payments/:payId/delete",
  ...guarded(async (req, res) => {
    const doc = await billing.payment(
      req.params.id,
      {},
      req.user.id,
      req.params.payId,
    );
    res.redirect(billing.detailUrl(doc) + "?saved=1#zahlungen");
  }, true),
);
router.post("/belege", ...save());
router.post("/belege/:id", ...save());
// Existing integrations enter the same validation and transaction code.
router.post("/wizard/save", ...save());
router.post("/create-offer", ...save("angebot", true));
router.post("/create-invoice", ...save("rechnung", true));
router.post("/offers/:id/update", ...save("angebot", true));
router.post("/invoices/:id/update", ...save("rechnung", true));
module.exports = router;
