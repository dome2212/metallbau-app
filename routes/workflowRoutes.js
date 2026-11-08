const router = require("express").Router();
const { dbQuery } = require("../utils/db");
const { getFirma } = require("../utils/companySettings");
const { requirePerm, hasPerm, canSeeMoney } = require("../middleware/auth");
const flow = require("../utils/projectWorkflow");
const billing = require("../utils/billingService");
const approval = require("../utils/cadApproval");
const { isOffice } = require('../middleware/auth');
const money = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const num = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("de-DE", { maximumFractionDigits: 3 });
router.use(requirePerm("projects", true, true));
router.use(async (req, res, next) => {
  try {
    await flow.init();
    await require("./cadRoutes").initialize();
    next();
  } catch (e) {
    next(e);
  }
});
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e.status)
        return res
          .status(e.status)
          .send(e.message + " Zurückgehen und die Seite neu laden.");
      next(e);
    }
  };
}
async function permissions(req) {
  const firma = await getFirma();
  return {
    firma,
    amounts: canSeeMoney(req.user, firma),
    documents:
      isOffice(req.user) &&
      hasPerm(req.user, "documents", firma, true, false),
    cad: hasPerm(req.user, "cad", firma, true, false),
    stock: hasPerm(req.user, "lager", firma, true, false),
    admin: isOffice(req.user),
  };
}
function requireAccess(p, area) {
  if (!p[area])
    throw flow.problem(403, "Keine Berechtigung für diesen Bereich.");
}
async function project(id) {
  const row = (
    await dbQuery(
      `SELECT p.*,c.company_name,c.contact_person,c.street,c.zip,c.city,c.phone,c.email FROM projects p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.id=? AND p.deleted_at IS NULL`,
      [id],
    )
  ).rows[0];
  if (!row) throw flow.problem(404, "Auftrag nicht gefunden.");
  return row;
}
async function drawings(req, id, p) {
  if (!p.cad) return [];
  return (
    await dbQuery(
      `SELECT d.* FROM cad_documents d WHERE d.project_id=? AND (d.owner_id=? OR EXISTS (SELECT 1 FROM cad_document_access a WHERE a.document_id=d.id AND a.user_id=?)) ORDER BY d.name`,
      [String(id), String(req.user.id), String(req.user.id)],
    )
  ).rows;
}
async function materialData(req, pr, p, current) {
  const ds = await drawings(req, pr.id, p);
  if (!p.stock) return { drawings: ds, stock: [], offcuts: [], materials: [] };
  const [stock, offcuts] = await Promise.all([
    dbQuery("SELECT * FROM lager_items ORDER BY bezeichnung,profil"),
    dbQuery("SELECT * FROM lager_reststuecke ORDER BY bezeichnung,profil"),
  ]);
  return {
    drawings: ds,
    stock: stock.rows,
    offcuts: offcuts.rows,
    materials: flow.materialPlan(
      flow.requirements(ds),
      current.data.links,
      stock.rows,
      offcuts.rows,
    ),
  };
}
router.get(
  "/",
  handle(async (req, res) => {
    const p = await permissions(req);
    const projects = (
      await dbQuery(
        `SELECT p.*,c.company_name,c.contact_person FROM projects p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC,p.id DESC`,
      )
    ).rows;
    const [states, allDrawings, stock, offcuts, offers, invoices] =
      await Promise.all([
        dbQuery("SELECT * FROM project_workflow"),
        p.cad
          ? dbQuery(
              "SELECT d.* FROM cad_documents d WHERE d.project_id IS NOT NULL AND (d.owner_id=? OR EXISTS (SELECT 1 FROM cad_document_access a WHERE a.document_id=d.id AND a.user_id=?))",
              [String(req.user.id), String(req.user.id)],
            )
          : { rows: [] },
        p.stock ? dbQuery("SELECT * FROM lager_items") : { rows: [] },
        p.stock ? dbQuery("SELECT * FROM lager_reststuecke") : { rows: [] },
        p.documents
          ? dbQuery("SELECT * FROM documents WHERE doc_type='OFFER'")
          : { rows: [] },
        p.documents
          ? dbQuery(
              "SELECT * FROM documents WHERE doc_type='INVOICE' AND project_id IS NOT NULL",
            )
          : { rows: [] },
      ]);
    const stateMap = new Map(
        states.rows.map((s) => [s.project_id, JSON.parse(s.data)]),
      ),
      offerMap = new Map(offers.rows.map((o) => [Number(o.id), o]));
    const byProject = (rows) => {
      const map = new Map();
      for (const row of rows) {
        const key = String(row.project_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
      }
      return map;
    };
    const drawingMap = byProject(allDrawings.rows),
      invoiceMap = byProject(invoices.rows);
    const rows = projects.map((pr) => {
      const ds = drawingMap.get(String(pr.id)) || [],
        materials = p.stock
          ? flow.materialPlan(
              flow.requirements(ds),
              stateMap.get(pr.id)?.links,
              stock.rows,
              offcuts.rows,
            )
          : [];
      const next = flow.nextAction(pr, {
        offer: offerMap.get(Number(pr.offer_id)),
        drawings: ds,
        materials,
        invoices: invoiceMap.get(String(pr.id)) || [],
      });
      if (!p.documents) {
        delete next.href;
        next.label =
          pr.status === "Abgeschlossen"
            ? "Auftrag abgeschlossen"
            : "Auftragsdetails / Montage öffnen";
        next.anchor = "ablauf";
      }
      return {
        project: pr,
        next,
        missing: materials.filter((r) => r.missingCount).length,
      };
    });
    res.render("workflow/list", { rows, p, stages: flow.stages });
  }),
);
router.get(
  "/:id(\\d+)",
  handle(async (req, res) => {
    const p = await permissions(req),
      pr = await project(req.params.id),
      current = await flow.load(pr.id),
      md = await materialData(req, pr, p, current);
    const offers = p.documents
      ? (
          await dbQuery(
            "SELECT * FROM documents WHERE customer_id=? AND doc_type='OFFER' ORDER BY id DESC",
            [pr.customer_id],
          )
        ).rows
      : [];
    const offer = offers.find((d) => Number(d.id) === Number(pr.offer_id));
    const invoices = p.documents
      ? (
          await dbQuery(
            "SELECT * FROM documents WHERE project_id=? AND doc_type='INVOICE' ORDER BY id DESC",
            [pr.id],
          )
        ).rows
      : [];
    const [logs, withdrawals] = p.amounts
      ? await Promise.all([
          dbQuery(
            "SELECT id,user_id,type,timestamp FROM time_logs WHERE project_id=? ORDER BY timestamp,id",
            [pr.id],
          ),
          dbQuery(
            "SELECT gesamtpreis FROM lager_entnahmen WHERE project_id=?",
            [pr.id],
          ),
        ])
      : [{ rows: [] }, { rows: [] }];
    const cost = p.amounts
      ? flow.costing(
          pr,
          current.data,
          offer,
          logs.rows,
          withdrawals.rows,
          p.firma,
        )
      : null;
    res.render("workflow/detail", {
      project: pr,
      p,
      current,
      ...md,
      offers,
      offer,
      invoices,
      cost,
      money,
      num,
      stages: flow.stages,
      next: p.documents
        ? flow.nextAction(pr, { offer, ...md, invoices })
        : {
            label:
              pr.status === "Abgeschlossen"
                ? "Auftrag abgeschlossen"
                : "Arbeitsstand und Montage prüfen",
            anchor: "ablauf",
          },
      saved: req.query.saved === "1",
    });
  }),
);
router.post(
  "/:id(\\d+)/plan",
  handle(async (req, res) => {
    const p = await permissions(req);
    requireAccess(p, "admin");
    requireAccess(p, "amounts");
    requireAccess(p, "documents");
    await flow.update(
      req.params.id,
      req.body.revision,
      async (data, tx, pr) => {
        const offerId = req.body.offer_id ? Number(req.body.offer_id) : null;
        if (
          offerId !== null &&
          (!Number.isSafeInteger(offerId) || offerId <= 0)
        )
          throw flow.problem(400, "Ungültiges Angebot.");
        if (
          offerId &&
          !(
            await tx.query(
              "SELECT id FROM documents WHERE id=? AND customer_id=? AND doc_type='OFFER'",
              [offerId, pr.customer_id],
            )
          ).rows.length
        )
          throw flow.problem(400, "Angebot gehört nicht zu diesem Kunden.");
        const plan = {
          hours: flow.optionalNumber(req.body.hours, 100000),
          material: flow.optionalNumber(req.body.material),
          hourlyRate: flow.optionalNumber(req.body.hourlyRate, 100000),
        };
        await tx.query(
          "UPDATE projects SET offer_id=?,planned_hours=? WHERE id=?",
          [offerId, plan.hours, pr.id],
        );
        return { ...data, plan };
      },
    );
    res.redirect(
      303,
      "/auftragszentrale/" + req.params.id + "?saved=1#kalkulation",
    );
  }),
);
router.post(
  "/:id(\\d+)/status",
  handle(async (req, res) => {
    const p = await permissions(req);
    requireAccess(p, "admin");
    if (!flow.stages.includes(req.body.status))
      throw flow.problem(400, "Ungültiger Arbeitsschritt.");
    await flow.update(
      req.params.id,
      req.body.revision,
      async (data, tx, pr) => {
        if (pr.status !== req.body.status) {
          await tx.query("UPDATE projects SET status=? WHERE id=?", [
            req.body.status,
            pr.id,
          ]);
          await tx.query(
            "INSERT INTO project_status_log(project_id,old_status,new_status,changed_by) VALUES(?,?,?,?)",
            [
              pr.id,
              pr.status,
              req.body.status,
              req.user.username || String(req.user.id),
            ],
          );
        }
        return data;
      },
    );
    res.redirect(303, "/auftragszentrale/" + req.params.id + "?saved=1#ablauf");
  }),
);
router.post(
  "/:id(\\d+)/material",
  handle(async (req, res) => {
    const p = await permissions(req);
    requireAccess(p, "stock");
    requireAccess(p, "cad");
    const pr = await project(req.params.id),
      ds = await drawings(req, pr.id, p),
      rows = flow.requirements(ds);
    const stock = (await dbQuery("SELECT id FROM lager_items")).rows,
      rest = (await dbQuery("SELECT id FROM lager_reststuecke")).rows;
    const links = {};
    for (const row of rows) {
      const s = String(req.body["stock_" + row.key] || ""),
        r = String(req.body["rest_" + row.key] || "");
      if (
        (s && !stock.some((v) => String(v.id) === s)) ||
        (r && !rest.some((v) => String(v.id) === r))
      )
        throw flow.problem(400, "Lagerposition wurde inzwischen entfernt.");
      if (s || r) links[row.key] = { stockId: s, offcutId: r };
    }
    await flow.update(pr.id, req.body.revision, (data) => {
      const merged = { ...data.links };
      for (const row of rows) {
        delete merged[row.key];
        if (links[row.key]) merged[row.key] = links[row.key];
      }
      return { ...data, links: merged };
    });
    res.redirect(303, "/auftragszentrale/" + pr.id + "?saved=1#material");
  }),
);
router.get(
  "/:id(\\d+)/einkauf.csv",
  handle(async (req, res) => {
    const p = await permissions(req);
    requireAccess(p, "stock");
    requireAccess(p, "cad");
    const pr = await project(req.params.id),
      current = await flow.load(pr.id),
      md = await materialData(req, pr, p, current);
    const cell = (value) =>
      '"' +
      String(value ?? "")
        .replace(/^[\s]*[=+\-@]/, "'$&")
        .replace(/"/g, '""') +
      '"';
    const rows = [
      [
        "Auftrag",
        "Zeichnung",
        "Revision",
        "Material",
        "Bauteil",
        "Maße mm",
        "Fehlende Teile",
        "Bedarf",
        "Einheit",
      ],
      ...md.materials
        .filter((r) => r.missingCount)
        .map((r) => [
          pr.title,
          r.drawingName,
          r.revision,
          r.material,
          r.name,
          r.dimensions,
          r.missingCount,
          r.missing,
          r.unit,
        ]),
    ];
    res
      .type("text/csv")
      .set(
        "Content-Disposition",
        'attachment; filename="Einkauf-Auftrag-' + pr.id + '.csv"',
      )
      .set("Cache-Control", "no-store")
      .send("\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n"));
  }),
);
router.get(
  "/:id(\\d+)/zeichnungen/:drawingId.pdf",
  handle(async (req, res) => {
    const p = await permissions(req);
    requireAccess(p, "cad");
    const pr = await project(req.params.id),
      ds = await drawings(req, pr.id, p),
      d = ds.find((v) => v.id === req.params.drawingId);
    if (!d) throw flow.problem(404, "Zeichnung nicht gefunden.");
    const buffer = await approval.createPdf(JSON.parse(d.document));
    res.type("application/pdf").set("Cache-Control", "no-store").send(buffer);
  }),
);
router.get(
  "/:id(\\d+)/montage",
  handle(async (req, res) => {
    const p = await permissions(req),
      pr = await project(req.params.id),
      current = await flow.load(pr.id),
      md = await materialData(req, pr, p, current);
    const photos = (
      await dbQuery(
        "SELECT * FROM project_photos WHERE project_id=? ORDER BY created_at DESC",
        [pr.id],
      )
    ).rows;
    const files = (
      await dbQuery(
        "SELECT * FROM project_files WHERE project_id=? ORDER BY created_at DESC",
        [pr.id],
      )
    ).rows;
    let notes = [], measurements = [];
    try {
      notes = (await dbQuery(
        "SELECT * FROM project_notes WHERE project_id=? ORDER BY created_at DESC",
        [pr.id],
      )).rows || [];
    } catch (_) {}
    try {
      measurements = (await dbQuery(
        "SELECT * FROM project_measurements WHERE project_id=? ORDER BY created_at DESC",
        [pr.id],
      )).rows || [];
    } catch (_) {}
    const checklist =
      current.data.checklist ||
      flow.defaultChecklist.map((text) => ({ text, done: false }));
    res.render("workflow/montage", {
      project: pr,
      p,
      current,
      ...md,
      photos,
      files,
      notes,
      measurements,
      checklist,
      num,
      saved: req.query.saved === "1",
    });
  }),
);
router.post(
  "/:id(\\d+)/montage",
  handle(async (req, res) => {
    const note = String(req.body.note || "").trim();
    if (note.length > 4000)
      throw flow.problem(400, "Montagenotiz ist zu lang.");
    await flow.update(req.params.id, req.body.revision, (data, tx, pr) => {
      const checklist = (
        data.checklist ||
        flow.defaultChecklist.map((text) => ({ text, done: false }))
      ).map((c, i) => ({ ...c, done: req.body["check_" + i] === "on" }));
      // Updating a completed installation checklist requires a new acceptance.
      if (pr.acceptance_at)
        throw flow.problem(
          409,
          "Diese Montage ist bereits abgenommen. Eine Änderung ist nur nach Aufheben der Abnahme in der Auftragsakte möglich.",
        );
      return { ...data, checklist, installationNote: note };
    });
    res.redirect(
      303,
      "/auftragszentrale/" + req.params.id + "/montage?saved=1",
    );
  }),
);
router.post(
  "/:id(\\d+)/abnahme",
  handle(async (req, res) => {
    const name = String(req.body.name || "").trim(),
      sig = req.body.signature;
    if (
      !name ||
      name.length > 120 ||
      req.body.consent !== "on" ||
      !require("../utils/signature").valid(sig)
    )
      throw flow.problem(
        400,
        "Name, Zustimmung und eine gültige Unterschrift sind erforderlich.",
      );
    await flow.update(
      req.params.id,
      req.body.revision,
      async (data, tx, pr) => {
        if (pr.acceptance_at)
          throw flow.problem(409, "Eine Abnahme ist bereits gespeichert.");
        const checklist =
          data.checklist ||
          flow.defaultChecklist.map((text) => ({ text, done: false }));
        if (checklist.some((c) => !c.done))
          throw flow.problem(
            400,
            "Bitte zuerst alle Prüfpunkte abschließen und speichern.",
          );
        await tx.query(
          "UPDATE projects SET acceptance_name=?,acceptance_signature=?,acceptance_at=? WHERE id=?",
          [name, sig, new Date().toISOString(), pr.id],
        );
        return data;
      },
    );
    res.redirect(
      303,
      "/auftragszentrale/" + req.params.id + "/montage?saved=1",
    );
  }),
);
module.exports = router;
