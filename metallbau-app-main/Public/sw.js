const CACHE_NAME = 'metallbau-v4';
const STATIC_CACHE_NAME = 'metallbau-static-v4';

// Seiten, die sofort beim Installieren vorab gecacht werden, damit die App
// auch ganz ohne vorherigen Besuch offline startet (z.B. nach Neuinstallation).
const OFFLINE_URLS = [
  '/',
  '/dashboard',
  '/projects',
  '/customers',
  '/lager',
  '/timetracking',
  '/heute',
  '/lager/inventur',
  '/manifest.json',
  '/offline.html',
  '/js/offline-queue.js',
];

// Statische Fremd-Ressourcen (Schriften, Tailwind), die sich kaum ändern –
// hier "cache-first", damit die App auch offline korrekt aussieht.
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.tailwindcss.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(OFFLINE_URLS.map(url => cache.add(url).catch(() => {
        // einzelne Seite evtl. nicht erreichbar (z.B. noch nicht eingeloggt) → ignorieren
      })))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== STATIC_CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Offline-first für Stempel-Requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Stempel-POST offline puffern
  if (event.request.method === 'POST' && url.pathname === '/timetracking/stamp') {
    event.respondWith(
      fetch(event.request.clone()).catch(() => {
        // Offline: in IndexedDB speichern für spätere Synchronisierung
        return event.request.json().then(body => {
          saveOfflineStamp(body);
          return new Response(JSON.stringify({ offline: true, message: 'Stempel gespeichert (offline)' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }).catch(() => new Response('Offline', { status: 200 }));
      })
    );
    return;
  }

  // Statische Fremd-Ressourcen (Google Fonts, Tailwind CDN): cache-first,
  // damit die App auch offline sofort korrekt aussieht und schneller lädt.
  if (STATIC_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(STATIC_CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        }).catch(() => cached);
      })
    );
    return;
  }

  // Für alle anderen Requests (eigene Seiten, Kunden-/Projekt-/Lagerdaten, …):
  // Network first, Cache-Fallback → so ist jede zuletzt geladene Seite auch
  // ganz ohne Internet einsehbar (z.B. Projekt- und Kundendaten unterwegs).
  event.respondWith(
    fetch(event.request).then(response => {
      if (event.request.method === 'GET' && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
      }
      return response;
    }).catch(() =>
      caches.match(event.request).then(cached =>
        cached || (event.request.mode === 'navigate'
          ? caches.match('/offline.html')
          : new Response('Offline', { status: 503 }))
      )
    )
  );
});

function saveOfflineStamp(data) {
  // Offline-Stempel in IndexedDB speichern
  const req = indexedDB.open('metallbau-offline', 1);
  req.onupgradeneeded = e => e.target.result.createObjectStore('stamps', { autoIncrement: true });
  req.onsuccess = e => {
    const db = e.target.result;
    const tx = db.transaction('stamps', 'readwrite');
    tx.objectStore('stamps').add({ ...data, timestamp: new Date().toISOString() });
  };
}

// ── Push-Benachrichtigungen empfangen ─────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { title: 'Metallbau-App', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Metallbau-App';
  const options = {
    body:  data.body || '',
    icon:  data.icon  || '/img/icon-192.png',
    badge: '/img/icon-192.png',
    data:  { url: data.url || '/' },
    vibrate: [100, 50, 100]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Klick auf Benachrichtigung: passende Seite öffnen/fokussieren ────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Sync offline stamps / generic queued requests when back online
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-stamps') {
    event.waitUntil(syncOfflineStamps());
  }
  if (event.tag === 'sync-queue') {
    event.waitUntil(syncGenericQueue());
  }
});

// ── Generische Offline-Warteschlange (Inventur, Lager, Aufgaben, …) ─────────
// Wird von Public/js/offline-queue.js befüllt (Store 'requestQueue' in
// derselben IndexedDB 'metallbau-offline'). Der Service Worker übernimmt hier
// nur die Nachsendung im Hintergrund, wenn ein Background-Sync-Event kommt
// (z.B. wenn die App im Hintergrund/geschlossen war, während wieder Netz da war).
async function syncGenericQueue() {
  return new Promise((resolve) => {
    const req = indexedDB.open('metallbau-offline', 2);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('requestQueue')) return resolve();
      const tx = db.transaction('requestQueue', 'readwrite');
      const store = tx.objectStore('requestQueue');
      const getAll = store.getAll();
      getAll.onsuccess = async () => {
        for (const entry of getAll.result) {
          try {
            const params = new URLSearchParams();
            Object.entries(entry.body || {}).forEach(([k, v]) => {
              if (Array.isArray(v)) v.forEach(vv => params.append(k, vv));
              else params.append(k, v);
            });
            const res = await fetch(entry.url, {
              method: entry.method || 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params
            });
            if (res.ok || res.status < 500) store.delete(entry.id);
          } catch (_) { /* immer noch offline, beim nächsten Sync erneut versuchen */ }
        }
        resolve();
      };
      getAll.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

async function syncOfflineStamps() {
  return new Promise((resolve) => {
    const req = indexedDB.open('metallbau-offline', 1);
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('stamps', 'readwrite');
      const store = tx.objectStore('stamps');
      const getAll = store.getAll();
      getAll.onsuccess = async () => {
        for (const stamp of getAll.result) {
          try {
            await fetch('/timetracking/stamp', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams(stamp)
            });
          } catch(_) {}
        }
        store.clear();
        resolve();
      };
    };
    req.onerror = () => resolve();
  });
}
