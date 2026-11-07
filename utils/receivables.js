const dateKey = (value) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value || "").slice(0, 10);
function prepare(docs, today = new Date().toISOString().slice(0, 10)) {
  return docs
    .filter(
      (d) =>
        d.doc_type === "INVOICE" &&
        !["ENTWURF", "Entwurf", "Bezahlt", "Storniert", "Gutschrift"].includes(
          d.status,
        ),
    )
    .map((d) => {
      const open = Math.max(
          0,
          Math.round(
            (Number(d.total_amount) - Number(d.paid_amount || 0)) * 100,
          ) / 100,
        ),
        due = dateKey(d.due_date);
      const overdue = /^\d{4}-\d{2}-\d{2}$/.test(due)
        ? Math.max(
            0,
            Math.floor((Date.parse(today) - Date.parse(due)) / 86400000),
          )
        : 0;
      const amount = open.toLocaleString("de-DE", {
        style: "currency",
        currency: "EUR",
      });
      const reminder = `Guten Tag,\n\nzu unserer Rechnung ${d.doc_number} ist noch ein Betrag von ${amount} offen.${overdue ? " Das Zahlungsziel war der " + due.split("-").reverse().join(".") + "." : ""}\n\nBitte prüfen Sie den Zahlungseingang und überweisen Sie den offenen Betrag unter Angabe der Rechnungsnummer. Falls Sie bereits bezahlt haben, teilen Sie uns bitte das Zahlungsdatum mit.\n\nVielen Dank.`;
      return { ...d, open, due, overdue, reminder };
    })
    .filter((d) => d.open > 0.01)
    .sort(
      (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.id - b.id,
    );
}
module.exports = { prepare, dateKey };
