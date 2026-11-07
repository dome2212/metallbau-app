(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BillingMath = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function fail(message) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
  function number(value) {
    if (typeof value === "number") return value;
    const s = String(value ?? "").trim();
    if (!/^-?(?:\d+(?:[.,]\d+)?|\d{1,3}(?:\.\d{3})+,\d+)$/.test(s)) return NaN;
    return Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  }
  function bounded(value, min, max, label) {
    const n = number(value);
    if (!Number.isFinite(n) || n < min || n > max)
      fail(label + " ist ungültig.");
    return n;
  }
  const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  function calculate(input, taxRate, percent = 0, absolute = 0) {
    if (!Array.isArray(input) || !input.length || input.length > 200)
      fail("Bitte 1 bis 200 Positionen eintragen.");
    const items = input.map((item, index) => {
      if (
        !item ||
        typeof item.description !== "string" ||
        typeof item.unit !== "string"
      )
        fail("Position " + (index + 1) + ": Angaben fehlen.");
      const description = item.description.trim(),
        unit = item.unit.trim();
      if (
        !description ||
        description.length > 2000 ||
        !unit ||
        unit.length > 40
      )
        fail("Position " + (index + 1) + ": Beschreibung oder Einheit prüfen.");
      return {
        description,
        unit,
        quantity: bounded(item.quantity, Number.MIN_VALUE, 1000000, "Menge"),
        price: bounded(item.price, 0, 10000000, "Einzelpreis"),
        discount_percent: bounded(
          item.discount_percent ?? 0,
          0,
          100,
          "Positionsrabatt",
        ),
      };
    });
    const rate = bounded(taxRate, 0, 100, "Steuersatz");
    const pct = bounded(percent, 0, 100, "Belegrabatt");
    const amt = bounded(
      absolute,
      0,
      Number.MAX_SAFE_INTEGER / 100,
      "Belegrabatt",
    );
    const subtotal = round(
      items.reduce(
        (sum, it) =>
          sum + it.quantity * it.price * (1 - it.discount_percent / 100),
        0,
      ),
    );
    if (!Number.isSafeInteger(Math.round(subtotal * 100)))
      fail("Der Gesamtbetrag ist zu groß.");
    const discount_amount = round(pct > 0 ? (subtotal * pct) / 100 : amt);
    if (discount_amount > subtotal)
      fail("Der Belegrabatt darf den Nettobetrag nicht überschreiten.");
    const net = round(subtotal - discount_amount),
      tax_amount = round((net * rate) / 100),
      total_amount = round(net + tax_amount);
    if (!Number.isSafeInteger(Math.round(total_amount * 100)))
      fail("Der Gesamtbetrag ist zu groß.");
    return {
      items,
      subtotal,
      tax_rate: rate,
      discount_percent: pct,
      discount_amount,
      net,
      tax_amount,
      total_amount,
    };
  }
  return { number, round, calculate };
});
