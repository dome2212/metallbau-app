/**
 * offline-queue.js
 * ----------------
 * Generisches Offline-System für die ganze App.
 *
 * Funktionsweise:
 *  - Jedes <form> mit dem Attribut data-offline="true" wird abgefangen.
 *  - Ist die Internetverbindung da: ganz normal absenden (wie bisher).
 *  - Ist keine Verbindung da (oder der Request schlägt fehl): der Request
 *    wird in IndexedDB gespeichert ("Offline-Warteschlange") und die
 *    Eingabe geht NICHT verloren. Der Nutzer bekommt eine Bestätigung.
 *  - Sobald das Handy wieder online ist (Event 'online' ODER Background-Sync
 *    des Service Workers), werden alle gespeicherten Requests der Reihe
 *    nach nachgesendet.
 *
 * Einbindung: wird global im header.ejs geladen, keine weitere Konfiguration
 * nötig. Um ein neues Formular offline-fähig zu machen, einfach
 * `data-offline="true"` auf das <form>-Tag setzen.
 */
(function () {
  const DB_NAME    = 'metallbau-offline';
  const DB_VERSION = 2;
  const STORE      = 'requestQueue';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('stamps')) {
          db.createObjectStore('stamps', { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e);
    });
  }

  async function queueRequest(entry) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(entry);
      tx.oncomplete = () => resolve();
      tx.onerror    = (e) => reject(e);
    });
  }

  async function getQueue() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = (e) => reject(e);
    });
  }

  async function removeFromQueue(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror    = (e) => reject(e);
    });
  }

  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }

  // ── Badge: zeigt Anzahl wartender Einträge unten rechts ────────────────────
  let badgeEl = null;
  function ensureBadge() {
    if (badgeEl) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.id = 'offline-queue-badge';
    badgeEl.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:9998;' +
      'background:#d97706;color:#fff;font-size:12px;font-weight:600;' +
      'padding:8px 12px;border-radius:999px;box-shadow:0 4px 12px rgba(0,0,0,.25);' +
      'display:none;align-items:center;gap:6px;cursor:default;';
    document.body.appendChild(badgeEl);
    return badgeEl;
  }

  async function refreshBadge() {
    const el = ensureBadge();
    try {
      const q = await getQueue();
      if (q.length > 0) {
        el.style.display = 'flex';
        el.innerHTML = '📡 ' + q.length + ' offline gespeichert – wird synchronisiert…';
      } else {
        el.style.display = 'none';
      }
    } catch (_) { /* IndexedDB evtl. nicht verfügbar (privater Modus etc.) */ }
  }

  // ── Formulare abfangen ──────────────────────────────────────────────────────
  function serializeForm(form, submitter) {
    // WICHTIG: Bei Buttons wie <button type="submit" name="type" value="IN">
    // wird der Name/Wert nur mitgeschickt, wenn genau dieser Button das Formular
    // ausgelöst hat. new FormData(form) allein "weiß" das nicht – deshalb muss
    // der auslösende Button (submitter) explizit mitgegeben werden, sonst fehlt
    // z.B. beim Stempeln das Feld "type" (IN/OUT) komplett.
    const fd = submitter ? new FormData(form, submitter) : new FormData(form);
    const obj = {};
    for (const [k, v] of fd.entries()) {
      if (obj[k] === undefined) {
        obj[k] = v;
      } else if (Array.isArray(obj[k])) {
        obj[k].push(v);
      } else {
        obj[k] = [obj[k], v];
      }
    }
    return obj;
  }

  function toUrlEncoded(obj) {
    const params = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach(vv => params.append(k, vv));
      else params.append(k, v);
    });
    return params;
  }

  async function handleOfflineForm(e) {
    const form = e.target;
    if (form.dataset.offline !== 'true') return;

    // Immer abfangen und selbst per fetch senden – „navigator.onLine“
    // erkennt nur die Netzwerkschnittstelle, nicht ob wirklich eine Verbindung
    // zum Server besteht (typisch auf der Baustelle: WLAN zeigt „verbunden“,
    // kommt aber nichts durch). Nur so wird die Eingabe in JEDEM Fall gesichert.
    e.preventDefault();
    const data = serializeForm(form, e.submitter);
    const url = form.action || window.location.href;
    const method = (form.method || 'POST').toUpperCase();
    const label = form.dataset.offlineLabel || 'Eintrag';

    // Wenn der Browser sicher weiß, dass kein Netz da ist: direkt in die
    // Warteschlange legen, ohne den (sicher erfolglosen) Versuch zu senden.
    if (!navigator.onLine) {
      return queueAndNotify(form, url, method, data, label);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: toUrlEncoded(data),
          credentials: 'same-origin',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (res.ok) {
        // Erfolgreich gesendet → wie beim normalen Formular weiterleiten
        window.location.href = res.url || form.dataset.offlineRedirect || window.location.href;
        return;
      }

      if (res.status >= 500) {
        // Serverfehler → kann an einem vorübergehenden Problem liegen, später erneut versuchen
        throw new Error('Serverfehler ' + res.status);
      }

      // 4xx: Der Server hat die Anfrage inhaltlich abgelehnt (z.B. fehlendes GPS,
      // zu weit von der Baustelle entfernt). Ein erneuter Versuch würde am selben
      // Problem scheitern – deshalb NICHT zwischenspeichern, sondern die echte
      // Fehlermeldung sofort anzeigen, damit der Nutzer weiß, woran es liegt.
      let errText = '';
      try { errText = await res.text(); } catch (_) {}
      toast('❌ ' + (errText && errText.length < 200 ? errText : ('Fehler ' + res.status)), 'error');
    } catch (err) {
      // Echter Netzwerkfehler (Timeout, keine Verbindung) → nichts verloren gehen
      // lassen, sondern in die Warteschlange legen
      await queueAndNotify(form, url, method, data, label);
    }
  }

  async function queueAndNotify(form, url, method, data, label) {
    const entry = { url, method, body: data, createdAt: new Date().toISOString(), label };
    try {
      await queueRequest(entry);
      await refreshBadge();
      toast('📡 Offline gespeichert: ' + label + ' – wird automatisch hochgeladen, sobald wieder Internet da ist.', 'info');
      if (form.dataset.offlineRedirect) {
        window.location.href = form.dataset.offlineRedirect;
      } else if (typeof form.reset === 'function') {
        form.reset();
      }
      registerBackgroundSync();
    } catch (err) {
      toast('Fehler beim Offline-Speichern: ' + err.message, 'error');
    }
  }

  document.addEventListener('submit', handleOfflineForm, true);

  // ── Warteschlange synchronisieren ───────────────────────────────────────────
  let syncing = false;
  async function syncQueue() {
    if (syncing) return;
    syncing = true;
    try {
      const queue = await getQueue();
      if (queue.length === 0) return; // nichts zu tun → keine Meldung anzeigen

      let uploaded = 0;
      let rejected = 0;
      for (const entry of queue) {
        try {
          const res = await fetch(entry.url, {
            method: entry.method,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: toUrlEncoded(entry.body)
          });
          if (res.ok) {
            await removeFromQueue(entry.id);
            uploaded++;
          } else if (res.status >= 400 && res.status < 500) {
            // Server lehnt die gespeicherte Anfrage inhaltlich ab (z.B. GPS/Standort
            // ungültig). Erneutes Senden würde immer wieder scheitern -> verwerfen,
            // statt für immer als "wird hochgeladen" hängen zu bleiben.
            await removeFromQueue(entry.id);
            rejected++;
          }
          // bei 5xx: in der Warteschlange belassen und später erneut versuchen
        } catch (_) {
          // immer noch offline → Rest der Queue abbrechen, später erneut versuchen
          break;
        }
      }
      await refreshBadge();
      const remaining = await getQueue();
      if (uploaded > 0 && remaining.length === 0 && rejected === 0) {
        toast('✅ Alle offline gespeicherten Einträge wurden hochgeladen.', 'success');
        // Seite neu laden, damit z.B. der Stempeluhr-Status (Ein-/Ausgestempelt)
        // wieder den aktuellen Server-Stand zeigt und nicht veraltet stehen bleibt.
        setTimeout(() => window.location.reload(), 1400);
      } else if (rejected > 0) {
        toast('⚠️ ' + rejected + ' gespeicherter Eintrag konnte nicht übernommen werden (z.B. Standort/GPS abgelehnt). Bitte die Aktion erneut durchführen.', 'warn');
        if (uploaded > 0) setTimeout(() => window.location.reload(), 1800);
      }
    } finally {
      syncing = false;
    }
  }

  function registerBackgroundSync() {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then(reg => reg.sync.register('sync-queue')).catch(() => {});
    }
  }

  window.addEventListener('online', syncQueue);
  document.addEventListener('DOMContentLoaded', () => {
    refreshBadge();
    if (navigator.onLine) syncQueue();
  });

  // Für Seiten, die manuell einen Sync anstoßen wollen (z.B. Inventur-Modus)
  window.offlineQueue = { syncQueue, getQueue, queueRequest, refreshBadge };
})();
