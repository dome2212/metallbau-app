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
