const { test } = require("node:test"),
  assert = require("node:assert/strict");
let firma = { name: "PDF-Test", kleinunternehmer: "true" },
  texts = [];
const PDF = require("pdfkit");
class ObservedPDF extends PDF {
  text(value, ...args) {
    texts.push(value);
    return super.text(value, ...args);
  }
}
require.cache[require.resolve("pdfkit")].exports = ObservedPDF;
require.cache[require.resolve("../utils/companySettings")] = {
  exports: { getFirma: async () => firma },
};
const { generateDocumentPDFBuffer } = require("../utils/pdfGenerator");
test("PDF retains saved tax and amounts across company setting changes; preview is visibly marked", async () => {
  const items = [
      {
        description: "Profil",
        quantity: 1,
        unit: "Stk",
        price: 100,
        discount_percent: 0,
      },
    ],
    invoice = {
      doc_type: "INVOICE",
      doc_number: "TEST-1",
      status: "Offen",
      tax_rate: 19,
      subtotal: 100,
      tax_amount: 19,
      total_amount: 119,
      discount_amount: 0,
      discount_percent: 0,
    };
  const data = await generateDocumentPDFBuffer(invoice, items);
  assert.equal(data.subarray(0, 4).toString(), "%PDF");
  assert.ok(texts.includes("119,00 €"));
  assert.ok(texts.includes("19,00 €"));
  texts = [];
  firma.kleinunternehmer = "false";
  await generateDocumentPDFBuffer(
    {
      ...invoice,
      tax_rate: 0,
      tax_amount: 0,
      total_amount: 100,
      preview: true,
    },
    items,
  );
  assert.ok(texts.some((t) => String(t).includes("VORSCHAU")));
  assert.ok(texts.includes("100,00 €"));
  assert.ok(!texts.includes("119,00 €"));
  texts = [];
  await generateDocumentPDFBuffer(
    {
      ...invoice,
      doc_type: "OFFER",
      subtotal: 100,
      discount_percent: 10,
      discount_amount: 10,
      tax_amount: 17.1,
      total_amount: 107.1,
    },
    items,
  );
  assert.ok(texts.includes("107,10 €"));
  assert.ok(texts.includes("17,10 €"));
});
