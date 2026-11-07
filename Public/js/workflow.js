"use strict";
const search = document.getElementById("workflow-search"),
  statusSelect = document.getElementById("workflow-status");
if (search) {
  const filter = () => {
    let count = 0;
    for (const row of document.querySelectorAll("[data-workflow-row]")) {
      row.hidden = !(
        row.dataset.search.includes(search.value.toLowerCase().trim()) &&
        (!statusSelect.value || row.dataset.state === statusSelect.value)
      );
      if (!row.hidden) count++;
    }
    document.getElementById("workflow-empty").hidden = !!count;
  };
  search.addEventListener("input", filter);
  statusSelect.addEventListener("change", filter);
  filter();
}
for (const form of document.querySelectorAll("[data-workflow-json]"))
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit],button:not([type])"),
      msg = form.querySelector("[data-form-status]");
    button.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      if (!response.ok) throw Error(await response.text());
      if (new URL(response.url).pathname === "/login")
        throw Error("Bitte erneut anmelden.");
      const target = new URL(response.url);
      target.hash = "material";
      location.assign(target.href);
    } catch (e) {
      msg.textContent = e.message;
      button.disabled = false;
    }
  });
const signature = document.getElementById("flow-signature");
if (signature) {
  const ctx = signature.getContext("2d"),
    form = signature.closest("form"),
    clear = document.getElementById("flow-signature-clear");
  let drawing = false,
    signed = false;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#172f3d";
  const point = (e) => {
    const r = signature.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * signature.width) / r.width,
      ((e.clientY - r.top) * signature.height) / r.height,
    ];
  };
  signature.addEventListener("pointerdown", (e) => {
    drawing = true;
    signature.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.moveTo(...point(e));
  });
  signature.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    ctx.lineTo(...point(e));
    ctx.stroke();
    signed = true;
  });
  signature.addEventListener("pointerup", () => (drawing = false));
  signature.addEventListener("pointercancel", () => (drawing = false));
  clear.onclick = () => {
    ctx.clearRect(0, 0, signature.width, signature.height);
    signed = false;
  };
  form.addEventListener("submit", (e) => {
    if (!signed) {
      e.preventDefault();
      document.getElementById("flow-sign-status").textContent =
        "Bitte zuerst unterschreiben.";
      return;
    }
    form.elements.signature.value = signature.toDataURL("image/png");
  });
}
