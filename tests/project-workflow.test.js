const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  express = require("express"),
  sqlite = require("sqlite3"),
  path = require("path");
process.env.JWT_SECRET = "workflow-synthetic";
delete process.env.DATABASE_URL;
const db = new sqlite.Database(":memory:");
const query = (sql, params = []) =>
  new Promise((resolve, reject) =>
    /^\s*(SELECT|WITH)/i.test(sql)
      ? db.all(sql, params, (e, rows) => (e ? reject(e) : resolve({ rows })))
      : db.run(sql, params, function (e) {
          e ? reject(e) : resolve({ rows: [], lastID: this.lastID });
        }),
  );
let lock = Promise.resolve();
const withTransaction = (fn) => {
  const result = lock.then(async () => {
    await query("BEGIN");
    try {
      const v = await fn({ query });
      await query("COMMIT");
      return v;
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }
  });
  lock = result.catch(() => {});
  return result;
};
let firma = { name: "Testwerkstatt", hourly_rate: "55" };
require.cache[require.resolve("../utils/db")] = {
  exports: { dbQuery: query, withTransaction },
};
require.cache[require.resolve("../utils/companySettings")] = {
  exports: { getFirma: async () => firma, setFirmaValue: async () => {} },
};
require.cache[require.resolve("../config/database")] = { exports: db };
const flow = require("../utils/projectWorkflow"),
  parts = require("../Public/js/cad-parts");
const drawing = (objects, id = "d") => ({
  id,
  name: "Testzeichnung",
  revision: 1,
  document: JSON.stringify({ version: 1, name: "Testzeichnung", objects }),
});
test("material planning respects cut lengths, kerf, inventory units and shared stock pools", () => {
  const a = parts.create("rhs");
  a.part.quantity = 2;
  const b = {
    ...parts.create("rhs"),
    part: { ...parts.create("rhs").part, name: "anderes Teil", quantity: 2 },
  };
  const rows = flow.requirements([drawing([a, b])]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].needed, 2);
  const links = Object.fromEntries(
    rows.map((r) => [r.key, { stockId: "1", offcutId: "7" }]),
  );
  const plan = flow.materialPlan(
    rows,
    links,
    [{ id: 1, menge: 1, einheit: "m" }],
    [{ id: 7, menge: 1, laenge: "2003", einheit: "Stk" }],
  );
  assert.equal(
    plan.reduce((s, r) => s + r.restCount, 0),
    2,
  );
  assert.equal(
    plan.reduce((s, r) => s + r.stockCount, 0),
    1,
  );
  assert.equal(
    plan.reduce((s, r) => s + r.missingCount, 0),
    1,
  );
  assert.equal(
    flow
      .materialPlan(rows, links, [{ id: 1, menge: 100, einheit: "kg" }], [])
      .reduce((s, r) => s + r.stockCount, 0),
    0,
  );
  assert.equal(
    flow
      .materialPlan(
        rows,
        links,
        [],
        [{ id: 7, menge: 1, laenge: "999", einheit: "Stk" }],
      )
      .reduce((s, r) => s + r.restCount, 0),
    0,
  );
  assert.equal(
    flow
      .materialPlan(
        rows,
        links,
        [],
        [{ id: 7, menge: 1, laenge: "2002", einheit: "Stk" }],
      )
      .reduce((s, r) => s + r.restCount, 0),
    1,
  );
  const miter = parts.create("rhs");
  miter.part = { ...miter.part, cutStart: 45, miterStart: 45 };
  assert.equal(flow.requirements([drawing([miter])])[0].length, 1030);
  const changed = parts.create("rhs");
  changed.depth = 1500;
  assert.notEqual(flow.requirements([drawing([changed])])[0].key, rows[0].key);
  const plate = parts.create("plate");
  const pr = flow.requirements([drawing([plate])])[0];
  assert.equal(pr.unit, "Stk");
  assert.equal(pr.needed, 1);
});
test("costing pairs concurrent workers independently and subtracts offer discounts", () => {
  const logs = [
    { id: 1, user_id: 1, type: "IN", timestamp: "2026-11-01T08:00Z" },
    { id: 2, user_id: 2, type: "IN", timestamp: "2026-11-01T09:00Z" },
    { id: 3, user_id: 1, type: "OUT", timestamp: "2026-11-01T10:00Z" },
    { id: 4, user_id: 2, type: "OUT", timestamp: "2026-11-01T12:00Z" },
    { id: 5, user_id: 1, type: "IN", timestamp: "2026-11-01T13:00Z" },
  ];
  const cost = flow.costing(
    {},
    { plan: { hours: 4, material: 100, hourlyRate: 60 } },
    { subtotal: 1000, discount_amount: 100 },
    logs,
    [{ gesamtpreis: 150 }],
    {},
  );
  assert.equal(cost.hours, 5);
  assert.equal(cost.actual, 450);
  assert.equal(cost.planned, 340);
  assert.equal(cost.profit, 450);
  assert.equal(cost.hoursDelta, 1);
  assert.equal(cost.materialDelta, 50);
  for (const v of ["abc", Infinity, -1])
    assert.throws(() => flow.optionalNumber(v), /Zahlen|Planwerte/);
  assert.equal(flow.optionalNumber("1.234,50"), 1234.5);
  assert.equal(flow.optionalNumber(""), null);
});
test('next action prioritizes billing for completed jobs and handles canceled invoices',()=>{
 const pr={id:1,status:'Abgeschlossen'};
 assert.equal(flow.nextAction(pr,{}).label,'Rechnung vorbereiten');
 assert.equal(flow.nextAction(pr,{invoices:[{id:2,status:'Storniert'}]}).label,'Rechnung vorbereiten');
 assert.equal(flow.nextAction(pr,{invoices:[{id:2,status:'ENTWURF'}]}).label,'Rechnungsentwurf prüfen und ausstellen');
 assert.equal(flow.nextAction(pr,{invoices:[{id:2,status:'Teilbezahlt',total_amount:100,paid_amount:50}]}).label,'Zahlungseingang prüfen');
 assert.equal(flow.nextAction(pr,{invoices:[{id:2,status:'Bezahlt',total_amount:100,paid_amount:100}]}).label,'Auftrag abgeschlossen');
});
test("workflow HTTP persists plans and montage, rejects stale writes, enforces permissions and excludes other CAD owners", async () => {
  for (const sql of [
    "CREATE TABLE customers(id INTEGER PRIMARY KEY,company_name TEXT,contact_person TEXT,street TEXT,zip TEXT,city TEXT,phone TEXT,email TEXT)",
    "INSERT INTO customers(id,company_name,street,city) VALUES(1,'Montagekunde','Teststraße 1','Teststadt')",
    "CREATE TABLE projects(id INTEGER PRIMARY KEY,customer_id INTEGER,title TEXT,description TEXT,status TEXT,deleted_at TEXT,created_at TEXT,offer_id INTEGER,planned_hours REAL,site_lat REAL,site_lng REAL,site_note TEXT,acceptance_name TEXT,acceptance_signature TEXT,acceptance_at TEXT)",
    "INSERT INTO projects(id,customer_id,title,status) VALUES(1,1,'Testauftrag','In Planung'),(2,1,'Gelöscht','In Planung')",
    "UPDATE projects SET deleted_at='2026-01-01' WHERE id=2",
    "CREATE TABLE documents(id INTEGER PRIMARY KEY,doc_type TEXT,doc_number TEXT,customer_id INTEGER,status TEXT,subtotal REAL,discount_amount REAL,total_amount REAL,paid_amount REAL,project_id INTEGER)",
    "INSERT INTO documents VALUES(1,'OFFER','ANG-1',1,'ANGENOMMEN',1000,100,1071,0,NULL)",
    "CREATE TABLE project_status_log(id INTEGER PRIMARY KEY,project_id INTEGER,old_status TEXT,new_status TEXT,changed_by TEXT)",
    "CREATE TABLE time_logs(id INTEGER PRIMARY KEY,project_id INTEGER,user_id INTEGER,type TEXT,timestamp TEXT)",
    "CREATE TABLE lager_entnahmen(id INTEGER PRIMARY KEY,project_id INTEGER,gesamtpreis REAL)",
    "CREATE TABLE lager_items(id INTEGER PRIMARY KEY,bezeichnung TEXT,profil TEXT,material_type TEXT,menge REAL,einheit TEXT)",
    "INSERT INTO lager_items VALUES(1,'Rechteckrohr','60x40x3','baustahl',1,'m')",
    "CREATE TABLE lager_reststuecke(id INTEGER PRIMARY KEY,bezeichnung TEXT,profil TEXT,material_type TEXT,menge REAL,laenge TEXT,einheit TEXT)",
    "CREATE TABLE project_photos(id INTEGER PRIMARY KEY,project_id INTEGER,file_url TEXT,original_name TEXT,caption TEXT,created_at TEXT)",
    "CREATE TABLE project_files(id INTEGER PRIMARY KEY,project_id INTEGER,file_url TEXT,original_name TEXT,created_at TEXT)",
  ])
    await query(sql);
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "../views"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.user = {
      id: 1,
      username: "Test",
      role: req.headers["x-role"] || "CHEF",
    };
    Object.assign(res.locals, { currentUser: req.user, firma, req });
    next();
  });
  require.cache[require.resolve("../utils/cloudinaryStorage")] = {
    exports: {
      CloudinaryStorage: class {
        _handleFile(req, file, cb) {
          file.stream.resume();
          file.stream.on("end", () =>
            cb(null, { path: "https://example.invalid/montage.jpg" }),
          );
        }
        _removeFile(req, file, cb) {
          cb(null);
        }
      },
    },
  };
  app.use("/projects", require("../routes/projectRoutes"));
  app.use("/auftragszentrale", require("../routes/workflowRoutes"));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base =
    "http://127.0.0.1:" + server.address().port + "/auftragszentrale";
  const call = (url, body, role = "CHEF") =>
    fetch(base + url, {
      redirect: "manual",
      headers: { "Content-Type": "application/json", "x-role": role },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await call("/1")).status, 200);
    assert.equal((await call("/2")).status, 404);
    const object = parts.create("rhs");
    object.part.quantity = 2;
    const d = drawing([object]);
    await query("INSERT INTO cad_documents VALUES(?,?,?,?,?,?,?)", [
      "d",
      "1",
      "Testzeichnung",
      "1",
      d.document,
      1,
      new Date().toISOString(),
    ]);
    await query("INSERT INTO cad_documents VALUES(?,?,?,?,?,?,?)", [
      "private",
      "2",
      "Geheime Zeichnung",
      "1",
      d.document,
      1,
      new Date().toISOString(),
    ]);
    const html = await (await call("/1")).text();
    assert.match(html, /Testzeichnung/);
    assert.ok(!html.includes("Geheime Zeichnung"));
    assert.equal(
      (
        await call("/1/plan", {
          revision: 0,
          hours: "4",
          material: "100",
          hourlyRate: "60",
          offer_id: 1,
        })
      ).status,
      303,
    );
    assert.equal(
      (await call("/1/plan", { revision: 0, hours: "9" })).status,
      409,
    );
    assert.equal(
      (await call("/1/plan", { revision: 1, hours: "invalid" })).status,
      400,
    );
    assert.equal((await flow.load(1)).revision, 1);
    assert.equal(
      (await query("SELECT offer_id,planned_hours FROM projects WHERE id=1"))
        .rows[0].planned_hours,
      4,
    );
    assert.equal(
      (await call("/1/plan", { revision: 1, hours: 1 }, "EMPLOYEE")).status,
      403,
    );
    firma.perm_admin_money = "false";
    assert.equal(
      (await call("/1/plan", { revision: 1, hours: 1 }, "ADMIN")).status,
      403,
    );
    delete firma.perm_admin_money;
    const row = flow.requirements([d])[0];
    assert.equal(
      (await call("/1/material", { revision: 1, ["stock_" + row.key]: "1" }))
        .status,
      303,
    );
    const csv = await (await call("/1/einkauf.csv")).text();
    assert.match(csv, /"1";"1";"m"/);
    assert.equal(
      (await query("SELECT menge FROM lager_items")).rows[0].menge,
      1,
    );
    assert.equal((await call("/1/zeichnungen/private.pdf")).status, 404);
    assert.equal(
      (await call("/1/zeichnungen/d.pdf")).headers.get("content-type"),
      "application/pdf",
    );
    assert.equal(
      (await call("/1/status", { revision: 2, status: "Montagebereit" }))
        .status,
      303,
    );
    assert.equal(
      (await query("SELECT * FROM project_status_log")).rows.length,
      1,
    );
    assert.equal((await call("/1/montage")).status, 200);
    const upload = new FormData();
    upload.append(
      "photo",
      new Blob(["synthetic image"], { type: "image/jpeg" }),
      "montage.jpg",
    );
    upload.append("caption", "Anschluss geprüft");
    upload.append("return_to", "montage");
    const uploaded = await fetch(
      base.replace("/auftragszentrale", "") + "/projects/1/photos/upload",
      { method: "POST", redirect: "manual", body: upload },
    );
    assert.equal(uploaded.status, 303);
    assert.equal(
      uploaded.headers.get("location"),
      "/auftragszentrale/1/montage?saved=1#fotos",
    );
    assert.equal(
      (await query("SELECT caption FROM project_photos")).rows[0].caption,
      "Anschluss geprüft",
    );

    assert.equal(
      (
        await call(
          "/1/montage",
          {
            revision: 3,
            note: "Anschluss geprüft",
            ...Object.fromEntries(
              flow.defaultChecklist.map((_, i) => ["check_" + i, "on"]),
            ),
          },
          "EMPLOYEE",
        )
      ).status,
      303,
    );
    const signature =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    assert.equal(
      (
        await call(
          "/1/abnahme",
          { revision: 4, name: "Kunde", signature, consent: "on" },
          "EMPLOYEE",
        )
      ).status,
      303,
    );
    assert.equal(
      (await query("SELECT acceptance_name FROM projects WHERE id=1")).rows[0]
        .acceptance_name,
      "Kunde",
    );
    assert.equal(
      (
        await call(
          "/1/montage",
          { revision: 5, note: "nachträglich" },
          "EMPLOYEE",
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call("/1/abnahme", {
          revision: 5,
          name: "Änderung",
          signature,
          consent: "on",
        })
      ).status,
      409,
    );
    assert.equal((await call("/")).status, 200);
    firma.perm_employee_projects = "false";
    assert.equal((await call("/1", null, "EMPLOYEE")).status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => db.close(r));
  }
});
