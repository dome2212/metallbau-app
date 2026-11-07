const { test } = require("node:test");
const assert = require("node:assert/strict");
const { calculate, number } = require("../Public/js/billing-math");
const item = {
  description: "Geländer",
  quantity: "2,5",
  unit: "m",
  price: "120,00",
  discount_percent: "10",
};
test("German numbers, item discount, document discount and tax agree in shared calculation", () => {
  const t = calculate([item], 19, 5, 0);
  assert.equal(t.subtotal, 270);
  assert.equal(t.discount_amount, 13.5);
  assert.equal(t.net, 256.5);
  assert.equal(t.tax_amount, 48.74);
  assert.equal(t.total_amount, 305.24);
  assert.equal(number("1.234,56"), 1234.56);
  assert.ok(Number.isNaN(number("12abc")));
  assert.ok(Number.isNaN(number("")));
});
test("invalid amounts and excessive discounts fail without silent coercion", () => {
  for (const i of [
    { ...item, quantity: 0 },
    { ...item, quantity: -1 },
    { ...item, price: "" },
    { ...item, price: null },
    { ...item, price: Infinity },
    { ...item, discount_percent: 101 },
    { ...item, unit: "" },
  ])
    assert.throws(() => calculate([i], 19));
  assert.throws(() => calculate([item], 19, 0, 271));
  assert.throws(() => calculate([item], Infinity));
  assert.throws(() => calculate(Array(201).fill(item), 19));
});
test("zero tax and free line items remain supported; percent discount takes precedence", () => {
  const t = calculate([{ ...item, price: 0 }], 0);
  assert.equal(t.total_amount, 0);
  const t2 = calculate([item], 0, 10, 100);
  assert.equal(t2.total_amount, 243);
  assert.equal(t2.discount_amount, 27);
});
