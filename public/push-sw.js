// Web Push handlers — imported into the generated service worker via workbox importScripts.
self.addEventListener('push', event => {
  let d = {}
  try {
    d = event.data ? event.data.json() : {}
  } catch {
    d = { body: event.data && event.data.text() }
  }
  event.waitUntil(
    self.registration.showNotification(d.title || 'FPL Differential', {
      body: d.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      tag: d.tag || 'fpl-differential',
      // without renotify, a same-tag follow-up (e.g. doubtful → ruled out) would
      // replace the old notification silently — no sound, no banner
      renotify: true,
      data: { url: d.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus()
      }
      return clients.openWindow((event.notification.data && event.notification.data.url) || '/')
    }),
  )
})
