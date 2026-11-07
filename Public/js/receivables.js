"use strict";
const search = document.getElementById("receivables-search"),
  state = document.getElementById("receivables-status");
function filter() {
  let count = 0;
  for (const row of document.querySelectorAll("[data-receivable]")) {
    row.hidden = !(
      row.dataset.search.includes(search.value.toLowerCase().trim()) &&
      (!state.value || row.dataset.overdue === state.value)
    );
    if (!row.hidden) count++;
  }
  document.getElementById("receivables-empty").hidden = !!count;
}
search.addEventListener("input", filter);
state.addEventListener("change", filter);
for (const b of document.querySelectorAll("[data-copy-reminder]"))
  b.addEventListener("click", async () => {
    const field = document.getElementById(b.dataset.copyReminder),
      message = document.getElementById("receivables-message");
    try {
      await navigator.clipboard.writeText(field.value);
      message.textContent = "Erinnerungstext kopiert.";
    } catch (_) {
      field.focus();
      field.select();
      message.textContent = "Bitte den markierten Text kopieren.";
    }
  });
