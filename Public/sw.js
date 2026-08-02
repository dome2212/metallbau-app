/**
 * Service Worker – Metallbau-App
 * Handles incoming Web-Push notifications and notification click events.
 */

self.addEventListener('push', function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Neue Nachricht', body: event.data ? event.data.text() : '' };
  }

  const title   = data.title || 'Metallbau-App';
  const options = {
    body:    data.body  || '',
    icon:    data.icon  || '/img/icon-192.png',
    badge:   '/img/icon-192.png',
    tag:     'metallbau-push',
    renotify: true,
    data: { url: data.url || '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      // Focus existing tab if already open
      for (const client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
