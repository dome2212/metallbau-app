"use strict";
(() => {
  const data = JSON.parse(
      document.getElementById("bill-bootstrap").textContent,
    ),
    $ = (id) => document.getElementById(id),
    math = window.BillingMath;
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const euro = (n) =>
    Number.isFinite(n)
      ? n.toLocaleString("de-DE", { style: "currency", currency: "EUR" })
      : "—";
  const decimal = (n) => String(n ?? 0).replace(".", ",");
  const key =
      "billing.v2." +
      data.draftOwner +
      "." +
      (data.doc?.id ||
        data.type + (data.project ? ".project." + data.project.id : "")),
    label = data.type === "angebot" ? "Angebot" : "Rechnung";
  let dirty = false,
    busy = false,
    pendingDraft = null,
    draftWriteEnabled = true;
  const list = $("bill-items");
  function row(
    item = {
      description: "",
      quantity: 1,
      unit: "Stk",
      price: 0,
      discount_percent: 0,
    },
  ) {
    const el = document.createElement("div");
    el.className = "bill-position";
    el.innerHTML = `<div class="bill-pos-top"><span class="bill-pos-title"></span><div class="bill-pos-tools"><button class="bill-btn" type="button" data-action="up" aria-label="Position nach oben">↑</button><button class="bill-btn" type="button" data-action="down" aria-label="Position nach unten">↓</button><button class="bill-btn" type="button" data-action="copy">Kopie</button><button class="bill-btn bill-danger" type="button" data-action="remove" aria-label="Position entfernen">✕</button></div></div><label class="bill-field">Leistungsbeschreibung<textarea data-field="description" rows="2" maxlength="2000" required placeholder="z. B. Geländer fertigen und montieren">${escape(item.description)}</textarea></label><div class="bill-pos-fields"><label class="bill-field">Menge<input data-field="quantity" inputmode="decimal" value="${escape(decimal(item.quantity))}" required></label><label class="bill-field">Einheit<input data-field="unit" maxlength="40" value="${escape(item.unit)}" list="bill-units" required></label><label class="bill-field">Einzelpreis €<input data-field="price" inputmode="decimal" value="${escape(decimal(item.price))}" required></label><label class="bill-field">Rabatt %<input data-field="discount_percent" inputmode="decimal" value="${escape(decimal(item.discount_percent))}"></label></div><div class="bill-line-total"></div>`;
    list.append(el);
    return el;
  }
  function itemOf(el) {
    return Object.fromEntries(
      [...el.querySelectorAll("[data-field]")].map((input) => [
        input.dataset.field,
        input.value,
      ]),
    );
  }
  function state() {
    return {
      type: data.type,
      ...(data.project ? { project_id: data.project.id } : {}),
      revision: data.revision,
      customer_id: $("bill-customer").value,
      items: [...list.children].map(itemOf),
      tax_rate: $("bill-tax").value,
      discount_percent_doc: $("bill-discount").value,
      discount_amount_doc: $("bill-discount-amount").value,
      status_note: $("bill-note").value,
      ...(data.type === "rechnung"
        ? {
            due_date: $("bill-due").value,
            invoice_subtype: $("bill-subtype").value,
          }
        : {}),
    };
  }
  function totalsHtml(t) {
    return `<div><span>Positionen netto</span><span>${euro(t.subtotal)}</span></div>${t.discount_amount ? `<div><span>Belegrabatt</span><span>− ${euro(t.discount_amount)}</span></div>` : ""}<div><span>Umsatzsteuer ${escape(decimal(t.tax_rate))} %</span><span>${euro(t.tax_amount)}</span></div><div><strong>Gesamt</strong><strong>${euro(t.total_amount)}</strong></div>`;
  }
  function preview() {
    const s = state(),
      customer = data.customers.find((c) => String(c.id) === s.customer_id);
    let totals;
    [...list.children].forEach((el, i) => {
      el.querySelector(".bill-pos-title").textContent =
        "POSITION " + String(i + 1).padStart(2, "0");
      const it = itemOf(el),
        q = math.number(it.quantity),
        p = math.number(it.price),
        d = math.number(it.discount_percent);
      el.querySelector(".bill-line-total").textContent = euro(
        math.round(q * p * (1 - d / 100)),
      );
      el.querySelector('[data-action="up"]').disabled = i === 0;
      el.querySelector('[data-action="down"]').disabled =
        i === list.children.length - 1;
    });
    $("bill-item-count").textContent = s.items.length + " / 200";
    $("bill-address").textContent = customer
      ? [
          customer.contact_person,
          customer.street,
          [customer.zip, customer.city].filter(Boolean).join(" "),
          customer.email,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Noch kein Kunde ausgewählt.";
    try {
      totals = math.calculate(
        s.items,
        s.tax_rate,
        s.discount_percent_doc,
        s.discount_amount_doc,
      );
    } catch (_) {}
    $("bill-preview").innerHTML =
      `<div class="bill-paper-head">${escape(data.company.name)}</div><div class="bill-paper-meta"><p>${customer ? [customer.company_name, customer.contact_person, customer.street, [customer.zip, customer.city].filter(Boolean).join(" ")].filter(Boolean).map(escape).join("<br>") : "Empfänger auswählen"}</p><p>${new Date().toLocaleDateString("de-DE")}<br>${escape(data.doc?.doc_number || "Nummer folgt beim Speichern")}</p></div><h2>${label}</h2><p>Vielen Dank für Ihr Vertrauen.</p><table><thead><tr><th>Leistung</th><th>Menge</th><th>Summe</th></tr></thead><tbody>${s.items.map((it, i) => `<tr><td>${i + 1}. ${escape(it.description || "Leistung eintragen")}${math.number(it.discount_percent) > 0 ? "<br>" + escape(it.discount_percent) + " % Rabatt" : ""}</td><td>${escape(it.quantity)} ${escape(it.unit)}</td><td>${euro(math.round(math.number(it.quantity) * math.number(it.price) * (1 - math.number(it.discount_percent) / 100)))}</td></tr>`).join("")}</tbody></table><div class="bill-totals">${totals ? totalsHtml(totals) : "<p>Bitte gültige Positionsangaben und Konditionen eintragen.</p>"}</div>${data.type === "rechnung" && s.due_date ? '<p style="margin-top:20px">Zahlbar bis ' + escape(new Date(s.due_date).toLocaleDateString("de-DE")) + "</p>" : ""}`;
  }
  function persist() {
    if (!draftWriteEnabled) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ state: state(), at: Date.now() }),
      );
      $("bill-draft-status").textContent =
        "Entwurf lokal in diesem Browser gesichert";
    } catch (_) {
      $("bill-draft-status").textContent =
        "Lokale Sicherung nicht verfügbar – bitte speichern";
    }
  }
  function changed() {
    dirty = true;
    preview();
    persist();
  }
  function restore(s) {
    if (s.revision) data.revision = s.revision;
    $("bill-customer").value = String(s.customer_id || "");
    $("bill-tax").value =
      data.klein ||
      (data.type === "angebot" && data.doc)
        ? data.taxRate
        : (s.tax_rate ?? data.taxRate);
    $("bill-discount").value = s.discount_percent_doc ?? 0;
    $("bill-discount-amount").value = s.discount_amount_doc ?? 0;
    $("bill-note").value = s.status_note || "";
    if (data.type === "rechnung") {
      $("bill-due").value = s.due_date || "";
      const subtype = s.invoice_subtype || "";
      $("bill-subtype").value =
        subtype === "TEIL"
          ? "PARTIAL"
          : subtype === "SCHLUSS"
            ? "FINAL"
            : subtype === "STANDARD"
              ? ""
              : subtype;
    }
    list.replaceChildren();
    (s.items?.length ? s.items : [{}]).slice(0, 200).forEach((it) =>
      row({
        description: "",
        quantity: 1,
        unit: "Stk",
        price: 0,
        discount_percent: 0,
        ...it,
      }),
    );
    preview();
  }
  function clearPlaceholder() {
    if (
      list.children.length === 1 &&
      !itemOf(list.firstElementChild).description.trim() &&
      math.number(itemOf(list.firstElementChild).price) === 0
    )
      list.replaceChildren();
  }
  function add(item) {
    if (list.children.length >= 200) {
      alert("Maximal 200 Positionen pro Beleg.");
      return;
    }
    const el = row(item);
    changed();
    el.querySelector("textarea").focus();
    return el;
  }
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const el = button.closest(".bill-position");
    if (button.dataset.action === "up" && el.previousElementSibling)
      list.insertBefore(el, el.previousElementSibling);
    if (button.dataset.action === "down" && el.nextElementSibling)
      list.insertBefore(el.nextElementSibling, el);
    if (button.dataset.action === "copy") {
      const copy = add(itemOf(el));
      if (copy) el.after(copy);
    }
    if (button.dataset.action === "remove") {
      el.remove();
      if (!list.children.length) row();
    }
    changed();
  });
  $("bill-editor").addEventListener("input", (event) => {
    if (
      !event.target.id.startsWith("bill-new-") &&
      event.target.id !== "bill-ai-text"
    )
      changed();
  });
  $("bill-editor").addEventListener("change", (event) => {
    if (event.target.id === "bill-customer") changed();
  });
  $("bill-add").addEventListener("click", () => add());
  $("bill-article").addEventListener("change", (event) => {
    const article = data.articles.find(
      (a) => String(a.id) === event.target.value,
    );
    event.target.value = "";
    if (article) {
      if (
        list.children.length === 1 &&
        !itemOf(list.firstElementChild).description.trim()
      )
        list.replaceChildren();
      add({
        description: article.title,
        quantity: 1,
        unit: article.unit || "Stk",
        price: article.unit_price,
        discount_percent: 0,
      });
    }
  });
  $("bill-snippet").addEventListener("change", (event) => {
    const i = event.target.value;
    event.target.value = "";
    if (i !== "") {
      const s = data.snippets[Number(i)];
      clearPlaceholder();
      add({
        description: s.text || s.label || String(s),
        quantity: 1,
        unit: "Stk",
        price: 0,
        discount_percent: 0,
      });
    }
  });
  $("bill-restore").addEventListener("click", () => {
    restore(pendingDraft.state);
    draftWriteEnabled = true;
    $("bill-draft").hidden = true;
    changed();
  });
  $("bill-discard").addEventListener("click", () => {
    localStorage.removeItem(key);
    draftWriteEnabled = true;
    $("bill-draft").hidden = true;
    if (dirty) persist();
  });
  $("bill-new-customer").addEventListener("click", async () => {
    const btn = $("bill-new-customer"),
      error = $("bill-customer-error");
    error.textContent = "";
    btn.disabled = true;
    const body = {
      company_name: $("bill-new-name").value,
      contact_person: $("bill-new-person").value,
      street: $("bill-new-street").value,
      zip: $("bill-new-zip").value,
      city: $("bill-new-city").value,
      email: $("bill-new-email").value,
    };
    try {
      if (!body.company_name.trim() && !body.contact_person.trim())
        throw Error("Bitte Firma oder Namen eingeben.");
      if (!$("bill-new-email").checkValidity())
        throw Error("Bitte eine gültige E-Mail eingeben.");
      const res = await fetch("/documents/belege/kunden", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        result = await res.json();
      if (!res.ok || !result.ok)
        throw Error(result.error || "Kunde konnte nicht gespeichert werden.");
      const customer = {
        ...body,
        id: result.id,
        company_name: body.company_name || body.contact_person,
      };
      data.customers.push(customer);
      $("bill-customer").add(
        new Option(customer.company_name, String(customer.id)),
      );
      $("bill-customer").value = String(customer.id);
      btn.closest("details").open = false;
      changed();
    } catch (e) {
      error.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });
  $("bill-ai").addEventListener("click", async () => {
    const btn = $("bill-ai"),
      status = $("bill-ai-status");
    btn.disabled = true;
    status.textContent = "Vorschlag wird erstellt …";
    try {
      const text = $("bill-ai-text").value.trim();
      if (!text) throw Error("Bitte den Auftrag beschreiben.");
      const response = await fetch("/api/ai/offer-assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        }),
        result = await response.json();
      if (!response.ok || result.error)
        throw Error(result.error || "Vorschlag fehlgeschlagen.");
      const match =
        String(result.reply).match(/POSITIONEN_JSON[^[]*(\[[\s\S]*?\])/) ||
        String(result.reply).match(/(\[\s*\{[\s\S]*?\}\s*\])/);
      if (!match)
        throw Error("Keine Positionen erkannt. Bitte genauer beschreiben.");
      const items = JSON.parse(match[1]);
      if (!Array.isArray(items) || !items.length)
        throw Error("Keine Positionen erkannt.");
      if (items.length + list.children.length > 200)
        throw Error("Der Vorschlag überschreitet 200 Positionen.");
      clearPlaceholder();
      items.forEach((it) =>
        row({
          description: it.title || it.description || "",
          quantity: it.quantity ?? 1,
          unit: it.unit || "Stk",
          price: it.price ?? 0,
          discount_percent: 0,
        }),
      );
      changed();
      status.textContent =
        items.length + " Positionen übernommen. Mengen und Preise prüfen.";
    } catch (e) {
      status.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });
  $("bill-editor").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const error = $("bill-error");
    error.hidden = true;
    try {
      const input = state();
      if (!input.customer_id) throw Error("Bitte einen Kunden auswählen.");
      math.calculate(
        input.items,
        input.tax_rate,
        input.discount_percent_doc,
        input.discount_amount_doc,
      );
      if (!$("bill-editor").reportValidity()) return;
      if (
        input.items.some((i) => math.number(i.price) === 0) &&
        !confirm(
          "Mindestens eine Position hat einen Preis von 0 €. Beleg trotzdem speichern?",
        )
      )
        return;
      busy = true;
      $("bill-save").disabled = true;
      $("bill-save").textContent = "Wird gespeichert …";
      const response = await fetch(
        "/documents/belege" + (data.doc ? "/" + data.doc.id : ""),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw Error(result.error || "Speichern fehlgeschlagen.");
      dirty = false;
      try {
        localStorage.removeItem(key);
      } catch (_) {}
      location.assign(result.url);
    } catch (e) {
      error.textContent =
        e.message || "Speichern fehlgeschlagen. Bitte erneut versuchen.";
      error.hidden = false;
      error.scrollIntoView({ block: "center", behavior: "smooth" });
      busy = false;
      $("bill-save").disabled = false;
      $("bill-save").textContent = data.doc
        ? "Änderungen speichern"
        : label + " speichern";
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      $("bill-editor").requestSubmit();
    }
  });
  const units = document.createElement("datalist");
  units.id = "bill-units";
  ["Stk", "m", "m²", "kg", "Std", "Psch"].forEach((u) =>
    units.append(new Option(u)),
  );
  document.body.append(units);
  const due = new Date();
  due.setDate(due.getDate() + data.dueDays);
  restore({
    customer_id: data.doc?.customer_id || data.preCustomer,
    items: data.items.length ? data.items : undefined,
    tax_rate: data.taxRate,
    discount_percent_doc: data.doc?.discount_percent || 0,
    discount_amount_doc: data.doc?.discount_amount || 0,
    status_note: data.doc?.status_note || "",
    due_date: data.doc?.due_date
      ? String(data.doc.due_date).slice(0, 10)
      : due.toISOString().slice(0, 10),
    invoice_subtype: data.doc?.invoice_subtype || "",
  });
  try {
    pendingDraft = JSON.parse(localStorage.getItem(key) || "null");
    if (pendingDraft?.state && Array.isArray(pendingDraft.state.items)) {
      draftWriteEnabled = false;
      $("bill-draft").hidden = false;
    }
  } catch (_) {}
})();
