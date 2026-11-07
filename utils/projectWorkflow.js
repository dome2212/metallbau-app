const crypto = require("crypto");
const { dbQuery, withTransaction } = require("./db");
const parts = require("../Public/js/cad-parts");
const { validate } = require("../Public/js/cad-document");
const { number, round } = require("../Public/js/billing-math");
const problem = (status, message) =>
  Object.assign(new Error(message), { status });
const stages = [
  "In Planung",
  "Avor / Vorbereitung",
  "In Produktion",
  "Oberfläche",
  "Montagebereit",
  "Montage läuft",
  "Abgeschlossen",
];
const defaultChecklist = [
  "Zeichnung und Freigabe geprüft",
  "Material und Befestigung vollständig",
  "Untergrund und Anschlussmaße geprüft",
  "Bauteile montiert und ausgerichtet",
  "Befestigungen und Oberfläche geprüft",
  "Baustelle gereinigt und Kunde eingewiesen",
];
let ready;
async function init() {
  if (!ready)
    ready = dbQuery(
      `CREATE TABLE IF NOT EXISTS project_workflow (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)`,
    ).catch((e) => {
      ready = null;
      throw e;
    });
  await ready;
}
function state(row) {
  return row
    ? { data: JSON.parse(row.data), revision: row.revision }
    : { data: {}, revision: 0 };
}
async function load(id, query = dbQuery) {
  return state(
    (await query("SELECT * FROM project_workflow WHERE project_id=?", [id]))
      .rows[0],
  );
}
async function update(id, revision, modify) {
  return withTransaction(async (tx) => {
    const project = (
      await tx.query(
        "SELECT * FROM projects WHERE id=?" +
          (process.env.DATABASE_URL ? " FOR UPDATE" : ""),
        [id],
      )
    ).rows[0];
    if (!project || project.deleted_at)
      throw problem(404, "Auftrag nicht gefunden.");
    const current = await load(id, tx.query);
    if (
      !Number.isInteger(Number(revision)) ||
      Number(revision) !== current.revision
    )
      throw problem(
        409,
        "Der Auftrag wurde inzwischen geändert. Bitte neu laden und erneut speichern.",
      );
    const data = await modify(current.data, tx, project);
    if (current.revision)
      await tx.query(
        "UPDATE project_workflow SET data=?, revision=? WHERE project_id=?",
        [JSON.stringify(data), current.revision + 1, id],
      );
    else
      await tx.query(
        "INSERT INTO project_workflow(project_id,data,revision) VALUES(?,?,?)",
        [id, JSON.stringify(data), 1],
      );
    return current.revision + 1;
  });
}
function optionalNumber(value, max = 1e8) {
  if (value === "" || value == null) return null;
  let n;
  try {
    n = number(value);
  } catch (_) {
    throw problem(400, "Bitte gültige Zahlen eingeben.");
  }
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw problem(400, "Planwerte müssen zwischen 0 und " + max + " liegen.");
  return round(n);
}
function workedHours(logs) {
  const open = new Map();
  let hours = 0;
  // Timestamp order and a separate clock for each user avoid losing concurrent shifts.
  for (const log of [...logs].sort(
    (a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp) ||
      Number(a.id) - Number(b.id),
  )) {
    const t = new Date(log.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    if (log.type === "IN") open.set(log.user_id, t);
    else if (log.type === "OUT" && open.has(log.user_id)) {
      hours += Math.max(0, t - open.get(log.user_id)) / 3600000;
      open.delete(log.user_id);
    }
  }
  return round(hours);
}
function costing(project, data, offer, logs, withdrawals, firma) {
  const plan = data.plan || {},
    hours = workedHours(logs),
    rate = plan.hourlyRate ?? Number(firma.hourly_rate || 55);
  const material = round(
    withdrawals.reduce((s, r) => s + Number(r.gesamtpreis || 0), 0),
  );
  const actual = round(hours * rate + material),
    plannedHours =
      plan.hours ??
      (project.planned_hours == null ? null : Number(project.planned_hours));
  const plannedMaterial = plan.material ?? null,
    revenue = offer
      ? round(Number(offer.subtotal || 0) - Number(offer.discount_amount || 0))
      : null;
  const planned =
    plannedHours != null && plannedMaterial != null
      ? round(plannedHours * rate + plannedMaterial)
      : null;
  return {
    hours,
    rate,
    material,
    actual,
    plannedHours,
    plannedMaterial,
    planned,
    revenue,
    hoursDelta: plannedHours == null ? null : round(hours - plannedHours),
    materialDelta:
      plannedMaterial == null ? null : round(material - plannedMaterial),
    profit: revenue == null ? null : round(revenue - actual),
    plannedProfit:
      planned == null || revenue == null ? null : round(revenue - planned),
  };
}
const meter = (n) => Math.ceil((n - 1e-9) * 1000) / 1000;
const digest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requirements(drawings) {
  const result = [];
  for (const drawing of drawings) {
    const doc = validate(JSON.parse(drawing.document));
    for (const row of parts.rows(doc.objects)) {
      const object = doc.objects[row.indices[0]],
        linear = row.length != null;
      // Include geometry and quantity in the key: an edited drawing cannot silently reuse an old mapping.
      const key = digest([
        drawing.id,
        row.part,
        row.dimensions,
        row.quantity,
        row.pitch,
      ]);
      const slope = (end) =>
        Math.abs(
          parts.miterOffset(
            object,
            end,
            linear && row.part.lengthAxis === "x"
              ? object.h / 2
              : object.type === "circle"
                ? object.w
                : object.w / 2,
            row.part.lengthAxis === "x" ? object.depth / 2 : object.h / 2,
          ),
        );
      const cutLength = linear
        ? row.length + slope("start") + slope("end")
        : null;
      result.push({
        key,
        drawingId: drawing.id,
        drawingName: drawing.name,
        revision: drawing.revision,
        name: row.part.name,
        material: row.part.material,
        dimensions: row.dimensions,
        finish: row.part.finish,
        quantity: row.quantity,
        length: cutLength,
        unit: linear ? "m" : "Stk",
        needed: linear
          ? meter((cutLength * row.quantity) / 1000)
          : row.quantity,
      });
    }
  }
  return result;
}
// Stock is deliberately assigned by a person: similar profile names are not proof of matching grades.
// Consume each selected stock/offcut pool only once within this plan. No inventory mutations.
function materialPlan(rows, links, stock, offcuts) {
  const stockLeft = new Map(
    stock.map((s) => [String(s.id), Math.max(0, Number(s.menge) || 0)]),
  );
  const remaining = new Map(
    offcuts.map((s) => [
      String(s.id),
      Array.from(
        {
          length: Math.min(
            10000,
            Math.max(0, Math.floor(Number(s.menge) || 0)),
          ),
        },
        () =>
          ["stk", "stück", "stueck"].includes(
            String(s.einheit || "Stk").toLowerCase(),
          )
            ? Number(String(s.laenge).replace(",", "."))
            : 0,
      ),
    ]),
  );
  return [...rows]
    .sort(
      (a, b) => (b.length || 0) - (a.length || 0) || a.key.localeCompare(b.key),
    )
    .map((row) => {
      const link = links?.[row.key] || {},
        item = stock.find((s) => String(s.id) === String(link.stockId)),
        rest = offcuts.find((s) => String(s.id) === String(link.offcutId));
      let restCount = 0,
        stockCount = 0;
      const lengths = remaining.get(String(link.offcutId)) || [];
      if (row.length)
        for (let n = 0; n < row.quantity; n++) {
          const options = lengths
            .map((length, index) => ({ length, index }))
            .filter((s) => s.length >= row.length)
            .sort((a, b) => a.length - b.length);
          if (!options.length) break;
          lengths[options[0].index] -= row.length + 3;
          restCount++;
        }
      let left = row.quantity - restCount;
      const compatible =
        item &&
        (row.unit === "m"
          ? String(item.einheit).toLowerCase() === "m"
          : ["stk", "stück", "stueck"].includes(
              String(item.einheit).toLowerCase(),
            ));
      if (compatible) {
        const each = row.length ? row.length / 1000 : 1,
          available = stockLeft.get(String(item.id));
        stockCount = Math.min(left, Math.floor((available + 1e-9) / each));
        stockLeft.set(
          String(item.id),
          Math.max(0, available - stockCount * each),
        );
        left -= stockCount;
      }
      return {
        ...row,
        link,
        stock: item,
        offcut: rest,
        restCount,
        stockCount,
        missingCount: left,
        missing: row.length ? meter((left * row.length) / 1000) : left,
      };
    });
}
function nextAction(
  project,
  { offer, drawings = [], materials = [], invoices = [] },
) {
  if (project.status === "Abgeschlossen") {
    const active = invoices.filter((i) => i.status !== "Storniert");
    if (!active.length)
      return {
        label: "Rechnung vorbereiten",
        href: "/documents/neu/rechnung?project_id=" + project.id,
      };
    const draft = active.find((i) => ["ENTWURF", "Entwurf"].includes(i.status));
    if (draft)
      return {
        label: "Rechnungsentwurf prüfen und ausstellen",
        href: "/documents/invoices/" + draft.id,
      };
    if (
      active.some(
        (i) =>
          i.status !== "Bezahlt" &&
          Number(i.total_amount) - Number(i.paid_amount || 0) > 0.01,
      )
    )
      return {
        label: "Zahlungseingang prüfen",
        href: "/documents/forderungen",
      };
    return { label: "Auftrag abgeschlossen", anchor: "ablauf" };
  }
  if (!offer) return { label: "Angebot zuordnen", anchor: "kalkulation" };
  if (offer.status !== "ANGENOMMEN")
    return {
      label: "Angebotsfreigabe klären",
      href: "/documents/offers/" + offer.id + "/detail",
    };
  if (!drawings.length)
    return { label: "Zeichnung erstellen / Auftrag zuordnen", href: "/cad" };
  if (materials.some((r) => r.missingCount > 0))
    return { label: "Fehlendes Material beschaffen", anchor: "material" };
  return {
    label: ["Montage läuft", "Montagebereit"].includes(project.status)
      ? "Montage durchführen"
      : "Fertigung weiterführen",
    anchor: "ablauf",
  };
}
module.exports = {
  init,
  load,
  update,
  optionalNumber,
  workedHours,
  costing,
  requirements,
  materialPlan,
  nextAction,
  stages,
  defaultChecklist,
  problem,
};
