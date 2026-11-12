/**
 * Glocke / Benachrichtigungen (Top-Bar).
 * Holt GET /notifications (alle 60 s, beim Öffnen, beim Zurückkehren in den Tab,
 * nach Wieder-Online und wenn der Service Worker einen Push meldet).
 * Texte kommen von Benutzern (Pinnwand, Aufgaben …) → ausschließlich per textContent.
 */
(function () {
  'use strict';

  var btn      = document.getElementById('nb-btn');
  var panel    = document.getElementById('nb-panel');
  var badge    = document.getElementById('nb-badge');
  var list     = document.getElementById('nb-list');
  var readAll  = document.getElementById('nb-readall');
  if (!btn || !panel || !badge || !list || !readAll) return;

  var POLL_MS = 60000;
  var state = { items: [], unread: 0, loaded: false };
  var timer = null;
  var busy = false;

  // ── Hilfen ───────────────────────────────────────────────────────────
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'gerade eben';
    var m = Math.round(s / 60);
    if (m < 60) return 'vor ' + m + ' Min.';
    var h = Math.round(m / 60);
    if (h < 24) return 'vor ' + h + ' Std.';
    var d = Math.round(h / 24);
    if (d === 1) return 'gestern';
    if (d < 7) return 'vor ' + d + ' Tagen';
    return new Date(ms).toLocaleDateString('de-DE');
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function emptyState() {
    var box = el('div', 'nb-empty');
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>';
    box.appendChild(el('strong', null, 'Alles gelesen'));
    box.appendChild(el('span', null, 'Hinweise zu Aufgaben, Terminen, Urlaub, Aufträgen und Lager erscheinen hier.'));
    return box;
  }

  // ── Darstellung ──────────────────────────────────────────────────────
  function renderBadge() {
    var n = state.unread;
    badge.hidden = n < 1;
    badge.textContent = n > 99 ? '99+' : String(n);
    btn.setAttribute('aria-label', n > 0 ? 'Benachrichtigungen (' + n + ' ungelesen)' : 'Benachrichtigungen');
    readAll.disabled = n < 1;
  }

  function render() {
    renderBadge();
    list.textContent = '';
    if (!state.items.length) { list.appendChild(emptyState()); return; }

    state.items.forEach(function (it) {
      var a = el('a', 'nb-item' + (it.read ? '' : ' is-unread'));
      a.href = it.url || '/';
      a.dataset.id = String(it.id);
      a.appendChild(el('span', 'nb-item-title', it.title));
      if (it.body) a.appendChild(el('span', 'nb-item-body', it.body));
      a.appendChild(el('span', 'nb-item-time', ago(it.createdAt)));
      list.appendChild(a);
    });
  }

  // ── Daten ────────────────────────────────────────────────────────────
  function refresh() {
    if (busy) return Promise.resolve();
    busy = true;
    return fetch('/notifications', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) {
        var json = (r.headers.get('content-type') || '').indexOf('application/json') !== -1;
        if (!r.ok || !json) throw new Error('keine Daten');   // offline / Login abgelaufen / 2FA-Pflicht
        return r.json();
      })
      .then(function (d) {
        var before = state.unread;
        state.items = d.items || [];
        state.unread = d.unread || 0;
        render();
        if (state.loaded && state.unread > before) ring();
        state.loaded = true;
      })
      .catch(function () { /* still bleiben – Anzeige bleibt auf letztem Stand */ })
      .then(function () { busy = false; });
  }

  function post(url) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { Accept: 'application/json' } });
  }

  function ring() {
    btn.classList.remove('is-ringing');
    void btn.offsetWidth;                // Animation neu starten
    btn.classList.add('is-ringing');
  }

  // ── Öffnen / Schließen ───────────────────────────────────────────────
  function isOpen() { return !panel.hidden; }

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    render();                            // relative Zeiten aktualisieren
    refresh();
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    isOpen() ? close(false) : open();
  });

  document.addEventListener('click', function (e) {
    if (isOpen() && !panel.contains(e.target) && !btn.contains(e.target)) close(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) close(true);
  });

  // Klick auf eine Meldung: als gelesen merken, dann normal zum Link
  list.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('.nb-item') : null;
    if (!a) return;
    var id = a.dataset.id;
    state.items.forEach(function (it) {
      if (String(it.id) === id && !it.read) { it.read = true; state.unread = Math.max(0, state.unread - 1); }
    });
    post('/notifications/' + encodeURIComponent(id) + '/read').catch(function () {});
    a.classList.remove('is-unread');
    renderBadge();                       // Zähler sofort aktualisieren (Liste bleibt, damit der Link greift)
  });

  readAll.addEventListener('click', function () {
    state.items.forEach(function (it) { it.read = true; });
    state.unread = 0;
    render();
    post('/notifications/read-all').catch(function () {});
  });

  // ── Aktualisieren ────────────────────────────────────────────────────
  function schedule() {
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  window.addEventListener('online', refresh);
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'notification-push') refresh();
    });
  }

  render();
  refresh();
  schedule();
})();
