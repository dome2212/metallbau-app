const CACHE_NAME = 'metallbau-v1';
const OFFLINE_URLS = [
  '/',
  '/timetracking',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
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

  // Für alle anderen Requests: Network first, Cache fallback
  event.respondWith(
    fetch(event.request).then(response => {
      if (event.request.method === 'GET' && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(event.request))
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

// Sync offline stamps when back online
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-stamps') {
    event.waitUntil(syncOfflineStamps());
  }
});

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
