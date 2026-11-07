const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { prepare } = require("../utils/receivables");
test("receivables excludes drafts, closed balances and canceled invoices; reminders use outstanding amount", () => {
  const base = {
    doc_type: "INVOICE",
    doc_number: "R1",
    total_amount: 100,
    paid_amount: 20,
    status: "Offen",
    due_date: "2026-11-01",
  };
  const rows = prepare(
    [
      { ...base, id: 1 },
      { ...base, id: 2, status: "ENTWURF" },
      { ...base, id: 3, status: "Storniert" },
      { ...base, id: 4, status: "Bezahlt" },
      { ...base, id: 5, paid_amount: 100 },
      { ...base, id: 6, doc_type: "CREDIT" },
      { ...base, id: 7, due_date: null },
      { ...base, id: 8, due_date: new Date("2026-11-09") },
    ],
    "2026-11-07",
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 8, 7],
  );
  assert.equal(rows[0].open, 80);
  assert.equal(rows[0].overdue, 6);
  assert.match(rows[0].reminder, /80,00/);
  assert.equal(rows[1].overdue, 0);
  assert.equal(rows[2].due, "");
});
