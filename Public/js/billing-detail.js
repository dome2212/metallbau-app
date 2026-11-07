"use strict";
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (form.dataset.confirm && !confirm(form.dataset.confirm)) {
    event.preventDefault();
    return;
  }
  const button = form.querySelector('button[type="submit"],button:not([type])');
  if (button) {
    button.disabled = true;
    button.textContent = "Wird verarbeitet …";
  }
});
const additionButton = document.getElementById("bill-addition-add");
if (additionButton)
  additionButton.addEventListener("click", () => {
    const container = document.getElementById("bill-addition-items");
    if (container.children.length >= 200) return;
    const copy = container.firstElementChild.cloneNode(true);
    copy.querySelectorAll("input").forEach((input) => {
      input.value =
        input.name === "item_menge"
          ? "1"
          : input.name === "item_einheit"
            ? "Stk"
            : "";
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "bill-btn bill-small bill-danger";
    remove.textContent = "Position entfernen";
    remove.addEventListener("click", () => copy.remove());
    copy.append(remove);
    copy.style.marginTop = "16px";
    container.append(copy);
    copy.querySelector("input").focus();
  });

// Printing the HTML detail page is also an explicit issuance action.
let printIssuance;
window.addEventListener("beforeprint", () => {
  const form = document.querySelector('form[action$="/ausstellen"]');
  if (!form) return;
  printIssuance = fetch(form.action, { method: "POST", credentials: "same-origin", keepalive: true }).then(response => {
    if (!response.ok || response.redirected && new URL(response.url).pathname === "/login") throw new Error("Die Rechnung konnte nicht als offen gespeichert werden. Bitte erneut als ausgestellt markieren.");
    return response.text().then(html => new DOMParser().parseFromString(html, "text/html").querySelector(".bill-heading .bill-badge")?.textContent);
  });
  // Observe immediately, even while the browser print dialog is open.
  printIssuance.catch(() => {});
});
window.addEventListener("afterprint", () => {
  if (printIssuance) printIssuance.then(status => {
    if (!status) return;
    document.querySelector(".bill-heading .bill-badge").textContent = status;
    document.querySelector('a[href$="/bearbeiten"]')?.remove();
    document.querySelector('form[action$="/ausstellen"]')?.remove();
    document.querySelector('form[action="/documents/invoices/delete"]')?.remove();
  }).catch(error => alert(error.message));
});
