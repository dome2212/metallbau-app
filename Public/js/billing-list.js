"use strict";
(() => {
  const search = document.getElementById("bill-search"),
    status = document.getElementById("bill-status"),
    sort = document.getElementById("bill-sort"),
    body = document.getElementById("bill-records");
  const initial = new URLSearchParams(location.search).get("status");
  if ([...status.options].some((o) => o.value === initial))
    status.value = initial;
  function render() {
    const rows = [...body.rows],
      q = search.value.trim().toLocaleLowerCase("de");
    let count = 0;
    rows.sort((a, b) =>
      sort.value === "customer"
        ? a.dataset.customer.localeCompare(b.dataset.customer, "de")
        : sort.value === "amount"
          ? Number(b.dataset.amount) - Number(a.dataset.amount)
          : sort.value === "old"
            ? Number(a.dataset.time) - Number(b.dataset.time)
            : Number(b.dataset.time) - Number(a.dataset.time),
    );
    rows.forEach((row) => {
      row.hidden =
        !row.dataset.search.includes(q) ||
        (status.value !== "all" &&
          !(status.value === "open"
            ? ["open", "overdue"].includes(row.dataset.state)
            : row.dataset.state === status.value));
      if (!row.hidden) count++;
      body.append(row);
    });
    document.getElementById("bill-count").textContent =
      count + " von " + rows.length + " Belegen";
    document.getElementById("bill-empty").hidden = count > 0;
  }
  [search, status, sort].forEach((el) => el.addEventListener("input", render));
  [status, sort].forEach((el) => el.addEventListener("change", render));
  render();
})();
