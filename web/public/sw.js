/**
 * Veylo service worker.
 *
 * Its only job is notifications. It deliberately does not cache anything: Veylo decrypts
 * messages in the page using a key held in memory, and a worker that served stale application
 * code could leave someone on a build whose crypto no longer matches the server's. Offline
 * support is not worth that risk here.
 *
 * What arrives in a push is metadata this server already holds — who contacted you and which
 * conversation to open. Never message content: the server has only ciphertext. The notification
 * you see from a push therefore says "Sent you a message", while the richer one you see with
 * Veylo open is written by the page itself, after decryption.
 */

self.addEventListener('install', () => {
  // Take over straight away rather than waiting for every old tab to close, so that turning
  // notifications on in Settings works without a reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push with no body, or a body we cannot parse, still means "something happened".
  }

  const title = payload.title || 'Veylo';
  const options = {
    body: payload.body || 'You have a new notification.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    // Replaces rather than stacks: ten messages in one conversation is one notification.
    tag: payload.tag || 'veylo',
    renotify: Boolean(payload.tag),
    data: { path: payload.path || '/app' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.path) || '/app';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // Prefer focusing a tab that is already open, and steer it to the right conversation,
      // rather than opening a second copy of the app beside it.
      for (const client of clientList) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target).catch(() => {});
          return;
        }
      }

      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
