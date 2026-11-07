const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  express = require("express"),
  sqlite = require("sqlite3"),
  path = require("path"),
  crypto = require("crypto");
process.env.JWT_SECRET = "synthetic-offer-approval";
delete process.env.DATABASE_URL;
test("customer approval freezes drawing plus matching offer and reports outdated offer versions", async () => {
  const db = new sqlite.Database(":memory:");
  const query = (sql, params = []) =>
    new Promise((resolve, reject) =>
      /^\s*SELECT/i.test(sql)
        ? db.all(sql, params, (e, rows) => (e ? reject(e) : resolve({ rows })))
        : db.run(sql, params, function (e) {
            e ? reject(e) : resolve({ rows: [], lastID: this.lastID });
          }),
    );
  let lock = Promise.resolve();
  const withTransaction = (fn) => {
    const job = lock.then(async () => {
      await query("BEGIN");
      try {
        const r = await fn({ query });
        await query("COMMIT");
        return r;
      } catch (e) {
        await query("ROLLBACK");
        throw e;
      }
    });
    lock = job.catch(() => {});
    return job;
  };
  let firma = { name: "Freigabetest" };
  require.cache[require.resolve("../utils/db")] = {
    exports: { dbQuery: query, withTransaction },
  };
  require.cache[require.resolve("../utils/companySettings")] = {
    exports: { getFirma: async () => firma },
  };
  for (const sql of [
    "CREATE TABLE projects(id INTEGER PRIMARY KEY,title TEXT,customer_id INTEGER,deleted_at TEXT)",
    "INSERT INTO projects VALUES(1,'Auftrag',1,NULL)",
    "CREATE TABLE customers(id INTEGER PRIMARY KEY,company_name TEXT,contact_person TEXT,street TEXT,zip TEXT,city TEXT,email TEXT,phone TEXT)",
    "INSERT INTO customers(id,company_name) VALUES(1,'Kunde')",
    "CREATE TABLE documents(id INTEGER PRIMARY KEY,doc_type TEXT,doc_number TEXT,customer_id INTEGER,status TEXT,tax_rate REAL,subtotal REAL,tax_amount REAL,total_amount REAL,discount_amount REAL,discount_percent REAL)",
    "INSERT INTO documents VALUES(1,'OFFER','ANG-1',1,'OFFEN',19,100,19,119,0,0),(2,'OFFER','ANG-2',2,'OFFEN',19,100,19,119,0,0)",
    "CREATE TABLE document_items(id INTEGER PRIMARY KEY,document_id INTEGER,description TEXT,quantity REAL,unit TEXT,price REAL,discount_percent REAL)",
    "INSERT INTO document_items VALUES(1,1,'Handlauf',1,'Stk',100,0)",
  ])
    await query(sql);
  const app = express();
  app.set("views", path.join(__dirname, "../views"));
  app.set("view engine", "ejs");
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(require("cookie-parser")());
  app.use("/cad-approval", require("../routes/cadApprovalRoutes"));
  app.use((req, res, next) => {
    req.user = { id: "owner", role: req.headers["x-role"] || "CHEF" };
    next();
  });
  app.use("/cad/api", require("../routes/cadRoutes"));
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  let cookie = "";
  const call = (url, body, role = "CHEF") =>
    fetch(base + url, {
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "x-role": role,
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
  try {
    const saved = await (
      await call("/cad/api/documents", {
        projectId: 1,
        document: {
          version: 1,
          name: "Zeichnung",
          objects: [{ type: "rect", x: 0, y: 0, w: 40, h: 40, depth: 1000 }],
        },
      })
    ).json();
    const opened = await (await call("/cad/api/documents/" + saved.id)).json(),
      endpoint = "/cad/api/documents/" + saved.id + "/customer-approvals";
    const request = {
      revision: 1,
      document: opened.document,
      password: "Test Freigabe 2026",
      offerId: 1,
    };
    assert.equal(
      (await call(endpoint, { ...request, offerId: 2 })).status,
      400,
    );
    assert.equal((await call(endpoint, request, "ADMIN")).status, 403);
    const result = await (await call(endpoint, request)).json();
    assert.ok(result.path);
    const snapshot = (
      await query("SELECT * FROM cad_customer_approvals WHERE id=?", [
        result.id,
      ])
    ).rows[0];
    assert.equal(snapshot.offer_number, "ANG-1");
    assert.equal(snapshot.offer_revision.length, 64);
    assert.equal((await call(result.path + "/offer.pdf")).status, 401);
    const unlock = await fetch(base + result.path + "/unlock", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: request.password }),
    });
    cookie = unlock.headers.get("set-cookie").split(";")[0];
    const pdf = Buffer.from(
      await (await call(result.path + "/offer.pdf")).arrayBuffer(),
    );
    assert.equal(
      crypto.createHash("sha256").update(pdf).digest("hex"),
      snapshot.offer_hash,
    );
    assert.match(await (await call(result.path)).text(), /Angebot ANG-1/);
    await query(
      "UPDATE documents SET total_amount=238,subtotal=200,tax_amount=38 WHERE id=1",
    );
    await query("UPDATE document_items SET price=200 WHERE document_id=1");
    assert.deepEqual(
      Buffer.from(await (await call(result.path + "/offer.pdf")).arrayBuffer()),
      pdf,
    );
    const listed = await (await call(endpoint)).json();
    assert.equal(listed[0].offer_outdated, true);
    assert.equal(
      (await call(result.path, { name: "Kunde", consent: true })).status,
      200,
    );
    assert.equal(
      (
        await query(
          "SELECT approved_at FROM cad_customer_approvals WHERE id=?",
          [result.id],
        )
      ).rows[0].approved_at != null,
      true,
    );
    const pdfModule = require("../utils/pdfGenerator"),
      original = pdfModule.generateDocumentPDFBuffer;
    pdfModule.generateDocumentPDFBuffer = async (...args) => {
      const v = await original(...args);
      await query("UPDATE documents SET total_amount=999 WHERE id=1");
      return v;
    };
    assert.equal((await call(endpoint, request)).status, 409);
    assert.equal(
      (await query("SELECT id FROM cad_customer_approvals")).rows.length,
      1,
    );
    pdfModule.generateDocumentPDFBuffer = original;
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => db.close(r));
  }
});
