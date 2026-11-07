const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  express = require("express"),
  sqlite = require("sqlite3");
process.env.JWT_SECRET = "billing-workspace-test";
delete process.env.DATABASE_URL;
const db = new sqlite.Database(":memory:");
const query = (sql, params = []) =>
  new Promise((resolve, reject) =>
    /^\s*SELECT/i.test(sql)
      ? db.all(sql, params, (e, rows) => (e ? reject(e) : resolve({ rows })))
      : db.run(sql, params, function (e) {
          e ? reject(e) : resolve({ rows: [], lastID: this.lastID });
        }),
  );
let queue = Promise.resolve();
const withTransaction = (fn) => {
  const task = queue.then(async () => {
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
  queue = task.catch(() => {});
  return task;
};
const mails = [];
let firma = {
  default_tax_rate: "19",
  invoice_prefix: "RECH",
  offer_prefix: "ANG",
  zahlungsfrist: "14",
};
require.cache[require.resolve("../utils/db")] = {
  exports: { dbQuery: query, withTransaction },
};
require.cache[require.resolve("../utils/companySettings")] = {
  exports: { getFirma: async () => firma, setFirmaValue: async () => {} },
};
require.cache[require.resolve("../utils/notifier")] = {
  exports: {
    sendEmail: async (...args) => {
      mails.push(args);
      return { ok: true };
    },
  },
};
let failPDF = false;
const pdfModule = require("../utils/pdfGenerator");
const renderPDF = pdfModule.generateDocumentPDFBuffer;
pdfModule.generateDocumentPDFBuffer = (...args) => failPDF ? Promise.reject(new Error("Synthetic PDF failure")) : renderPDF(...args);
const router = require("../routes/documentRoutes"),
  { revision } = require("../utils/billingService");
test("new workspace preserves data, validates and locks financial changes across legacy and new endpoints", async () => {
  await query(
    "CREATE TABLE customers(id INTEGER PRIMARY KEY,company_name TEXT,contact_person TEXT,street TEXT,zip TEXT,city TEXT,email TEXT,phone TEXT,customer_number TEXT)",
  );
  await query("INSERT INTO customers(id,company_name) VALUES(1,'Belegtest')");
  await query(
    "CREATE TABLE documents(id INTEGER PRIMARY KEY AUTOINCREMENT,doc_type TEXT,doc_number TEXT,customer_id INTEGER,status TEXT,tax_rate REAL,subtotal REAL,tax_amount REAL,total_amount REAL,due_date TEXT,discount_percent REAL DEFAULT 0,discount_amount REAL DEFAULT 0,status_note TEXT,invoice_subtype TEXT,related_document_id INTEGER,parent_document_id INTEGER,project_id INTEGER,paid_amount REAL DEFAULT 0,sent_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
  );
  await query(
    "CREATE TABLE document_items(id INTEGER PRIMARY KEY,document_id INTEGER,description TEXT,quantity REAL,unit TEXT,price REAL,discount_percent REAL DEFAULT 0)",
  );
  await query(
    "CREATE TABLE invoice_payments(id INTEGER PRIMARY KEY,document_id INTEGER,amount REAL,payment_date TEXT,method TEXT,note TEXT,created_by INTEGER)",
  );
  await query(
    "CREATE TABLE dunning_history(id INTEGER PRIMARY KEY,document_id INTEGER)",
  );
  await query(
    "CREATE TABLE offer_nachtraege(id INTEGER PRIMARY KEY,document_id INTEGER)",
  );
  await query(
    "CREATE TABLE offer_nachtrag_items(id INTEGER PRIMARY KEY,nachtrag_id INTEGER)",
  );
  await query(
    "CREATE TABLE projects(id INTEGER PRIMARY KEY,customer_id INTEGER,title TEXT,status TEXT,deleted_at TEXT)",
  );
  await query(
    "INSERT INTO projects VALUES(1,1,'Testauftrag','In Planung',NULL)",
  );
  await query(
    "CREATE TABLE articles(id INTEGER PRIMARY KEY,title TEXT,unit TEXT,unit_price REAL)",
  );
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", require("path").join(__dirname, "../views"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.user = {
      id: 1,
      username: "Test",
      role: req.headers["x-role"] || "CHEF",
    };
    res.locals.currentUser = req.user;
    res.locals.firma = firma;
    res.locals.req = req;
    next();
  });
  app.use("/documents", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://localhost:" + server.address().port + "/documents";
  const post = (path, body, role = "CHEF") =>
    fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "x-role": role },
      body: JSON.stringify(body),
    });
  const item = {
      description: "Profil",
      quantity: "2,5",
      unit: "m",
      price: "120",
      discount_percent: 10,
    },
    input = {
      type: "rechnung",
      customer_id: 1,
      items: [item],
      discount_percent_doc: 5,
      due_date: "2026-12-01",
    };
  try {
    assert.equal(
      (await post("/belege/kunden", { company_name: "" })).status,
      400,
    );
    assert.equal(
      (await post("/belege/kunden", { company_name: "Neu", email: "invalid" }))
        .status,
      400,
    );
    const customerResult = await post("/belege/kunden", {
      company_name: "Neuer Kunde",
      email: "neu@example.invalid",
    });
    assert.equal(customerResult.status, 200);
    assert.ok((await customerResult.json()).id);
    let r = await post("/belege", input);
    assert.equal(r.status, 200);
    const result = await r.json(),
      id = result.id;
    assert.equal(result.url, `/documents/invoices/${id}?saved=1`);
    const doc = (await query("SELECT * FROM documents WHERE id=?", [id]))
      .rows[0];
    assert.equal(doc.total_amount, 305.24);
    assert.equal(doc.discount_amount, 13.5);
    for (const path of [
      "/buero",
      "/offers",
      "/invoices",
      "/neu/angebot",
      "/neu/rechnung",
      `/invoices/${id}`,
      `/belege/${id}/bearbeiten`,
    ]) {
      const page = await fetch(base + path);
      assert.equal(page.status, 200, path);
      assert.ok((await page.text()).includes("billing.css"));
    }
    const oldDone = await fetch(base + "/fertig/" + id, { redirect: "manual" });
    assert.equal(oldDone.status, 302);
    assert.ok(
      oldDone.headers.get("location").startsWith("/documents/invoices/" + id),
    );
    const exportCheck = await fetch(base + "/invoices/datev-export");
    assert.equal(
      exportCheck.status,
      200,
      "static export route must not be intercepted by detail route",
    );
    for (const bad of [
      { ...input, due_date: "2026-02-31" },
      { ...input, items: [{ ...item, price: "NaN" }] },
      { ...input, invoice_subtype: "UNKNOWN" },
      { ...input, discount_amount_doc: 999, discount_percent_doc: 0 },
    ])
      assert.equal((await post("/belege", bad)).status, 400);
    assert.equal((await query("SELECT * FROM documents")).rows.length, 1);
    const items = (
      await query("SELECT * FROM document_items WHERE document_id=?", [id])
    ).rows;
    const token = revision(doc, items);
    assert.equal(
      (
        await post("/belege/" + id, {
          ...input,
          revision: token,
          status_note: "bearbeitet",
        })
      ).status,
      200,
    );
    assert.equal(
      (await post("/belege/" + id, { ...input, revision: token })).status,
      409,
      "stale edits rejected",
    );
    assert.equal(
      (await query("SELECT status_note FROM documents WHERE id=?", [id]))
        .rows[0].status_note,
      "bearbeitet",
    );
    await query(
      "CREATE TRIGGER fail_item BEFORE INSERT ON document_items WHEN NEW.description='Fail' BEGIN SELECT RAISE(ABORT,'rollback'); END",
    );
    const before = (
      await query("SELECT * FROM document_items WHERE document_id=?", [id])
    ).rows;
    assert.equal(
      (
        await post("/belege/" + id, {
          ...input,
          items: [{ ...item, description: "Fail" }],
        })
      ).status,
      500,
    );
    assert.deepEqual(
      (await query("SELECT * FROM document_items WHERE document_id=?", [id]))
        .rows,
      before,
    );
    assert.equal((await post("/belege/" + id + "/ausstellen", {})).status, 302);
    assert.equal(
      (await query("SELECT status FROM documents WHERE id=?", [id])).rows[0]
        .status,
      "Offen",
    );
    assert.equal(
      (
        await post("/invoices/" + id + "/send-email", {
          to: "synthetic@example.invalid",
          message: "<b>Text</b>",
        })
      ).status,
      302,
    );
    assert.ok(mails[0][2].includes("&lt;b&gt;Text&lt;/b&gt;"));
    assert.equal(mails[0][3][0].content.subarray(0, 4).toString(), "%PDF");
    assert.equal((await post("/belege/" + id, input)).status, 409);
    assert.equal(
      (
        await post("/invoices/" + id + "/update", {
          title: "Attack",
          quantity: 1,
          unit: "m",
          price: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (await post("/invoices/delete", { invoice_id: id })).status,
      409,
    );
    for (const invalid of [
      { amount: "Infinity" },
      { amount: "10x" },
      { amount: 10, payment_date: "2026-02-31" },
    ])
      assert.equal(
        (await post("/invoices/" + id + "/payments", invalid)).status,
        400,
      );
    assert.equal(
      (await query("SELECT * FROM invoice_payments")).rows.length,
      0,
    );
    assert.equal(
      (
        await post("/invoices/" + id + "/payments", {
          amount: 100,
          payment_date: "2026-11-07",
        })
      ).status,
      302,
    );
    assert.equal(
      (await query("SELECT status FROM documents WHERE id=?", [id])).rows[0]
        .status,
      "Teilbezahlt",
    );
    const paymentId = (
      await query("SELECT id FROM invoice_payments WHERE document_id=?", [id])
    ).rows[0].id;
    assert.equal(
      (await post("/invoices/" + id + "/payments/" + paymentId + "/delete", {}))
        .status,
      302,
    );
    assert.equal(
      (await query("SELECT paid_amount FROM documents WHERE id=?", [id]))
        .rows[0].paid_amount,
      0,
    );
    await query(
      "CREATE TRIGGER fail_payment BEFORE UPDATE OF paid_amount ON documents WHEN NEW.paid_amount>9999 BEGIN SELECT RAISE(ABORT,'payment rollback'); END",
    );
    assert.equal(
      (await post("/invoices/" + id + "/payments", { amount: 10000 })).status,
      500,
    );
    assert.equal(
      (await query("SELECT * FROM invoice_payments")).rows.length,
      0,
    );
    let offer = await post("/belege", { ...input, type: "angebot" });
    const offerId = (await offer.json()).id;
    await query("UPDATE documents SET status='ANGENOMMEN' WHERE id=?", [
      offerId,
    ]);
    assert.equal(
      (await post("/offers/delete", { offer_id: offerId })).status,
      409,
    );
    const fromProject = await post("/belege", { ...input, project_id: 1 });
    assert.equal(fromProject.status, 200);
    const projectInvoice = (await fromProject.json()).id;
    assert.equal(
      (
        await query("SELECT project_id FROM documents WHERE id=?", [
          projectInvoice,
        ])
      ).rows[0].project_id,
      1,
    );
    assert.equal(
      (await query("SELECT status FROM projects WHERE id=1")).rows[0].status,
      "Abgeschlossen",
    );
    await query("UPDATE projects SET status='In Planung' WHERE id=1");
    assert.equal(
      (
        await post("/belege", {
          ...input,
          project_id: 1,
          items: [{ ...item, description: "Fail" }],
        })
      ).status,
      500,
    );
    assert.equal(
      (await query("SELECT status FROM projects WHERE id=1")).rows[0].status,
      "In Planung",
    );
    const disposable = (await (await post("/belege", input)).json()).id;
    assert.equal(
      (await post("/invoices/delete", { invoice_id: disposable })).status,
      302,
    );
    assert.equal(
      (
        await query("SELECT * FROM document_items WHERE document_id=?", [
          disposable,
        ])
      ).rows.length,
      0,
    );
    const previewCreated=await (await post('/belege',{...input,type:'rechnung'})).json();
    const previewResponse=await fetch(base+'/invoices/'+previewCreated.id+'/pdf-preview');
    assert.equal(previewResponse.status,200);assert.equal(Buffer.from(await previewResponse.arrayBuffer()).subarray(0,4).toString(),'%PDF');
    assert.equal((await query('SELECT status FROM documents WHERE id=?',[previewCreated.id])).rows[0].status,'ENTWURF');
    assert.equal((await fetch(base+'/invoices/'+previewCreated.id+'/pdf-preview',{headers:{'x-role':'ADMIN'}})).status,403);
    for (const suffix of ["pdf", "pdf-download"]) {
      const newId = (await (await post("/belege", input)).json()).id;
      const url = base + "/invoices/" + newId + "/" + suffix;
      assert.equal((await fetch(url, {method:"HEAD"})).status,200);
      assert.equal((await query("SELECT status FROM documents WHERE id=?",[newId])).rows[0].status,"ENTWURF");
      failPDF=true;assert.equal((await fetch(url)).status,500);failPDF=false;
      assert.equal((await query("SELECT status FROM documents WHERE id=?",[newId])).rows[0].status,"ENTWURF");
      const pdf=await fetch(url);assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),"%PDF");
      assert.ok(pdf.headers.get("content-disposition").startsWith(suffix==="pdf"?"inline":"attachment"));
      assert.equal((await query("SELECT status FROM documents WHERE id=?",[newId])).rows[0].status,"Offen");
      assert.equal((await post("/belege/"+newId,input)).status,409);
      for(const status of ["Bezahlt","Teilbezahlt","Storniert","Gemahnt"]) {
        await query("UPDATE documents SET status=? WHERE id=?",[status,newId]);assert.equal((await fetch(url)).status,200);
        assert.equal((await query("SELECT status FROM documents WHERE id=?",[newId])).rows[0].status,status);
      }
      await query("UPDATE documents SET doc_type='CREDIT',status='Gutschrift' WHERE id=?",[newId]);assert.equal((await fetch(url)).status,200);
      assert.equal((await query("SELECT status FROM documents WHERE id=?",[newId])).rows[0].status,"Gutschrift");
    }
    assert.equal((await fetch(base+"/offers/"+offerId+"/pdf")).status,200);
    assert.equal((await query("SELECT status FROM documents WHERE id=?",[offerId])).rows[0].status,"ANGENOMMEN");
    firma.perm_admin_money = "false";
    firma.perm_admin_documents = "false";
    assert.equal((await post("/belege", input, "ADMIN")).status, 403);
    delete firma.perm_admin_documents;
    // Existing access rule for financial visibility must protect both UI and direct routes.
    assert.equal((await post("/belege", input, "ADMIN")).status, 403);
    assert.equal(
      (await post("/invoices/" + id + "/storno", {}, "ADMIN")).status,
      403,
    );
    const hiddenPage = await fetch(base + "/invoices/" + id, {
      headers: { "x-role": "ADMIN" },
    });
    assert.equal(hiddenPage.status, 200);
    assert.ok(!(await hiddenPage.text()).includes("305,24"));
    assert.equal(
      (
        await fetch(base + "/invoices/" + id + "/pdf", {
          headers: { "x-role": "ADMIN" },
        })
      ).status,
      403,
    );
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => db.close(r));
  }
});
