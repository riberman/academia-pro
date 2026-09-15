// Service Worker mínimo: só existe para permitir notificações locais
// (registration.showNotification) mesmo com a página em segundo plano.
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type !== 'REST_DONE') return;

    self.registration.showNotification(data.title || 'Descanso finalizado', {
        body: data.body || '',
        icon: 'favicon.png',
        badge: 'favicon.png',
        vibrate: [200, 100, 200],
        tag: 'rest-timer',
        renotify: true
    });
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
            const existing = clientsArr.find((c) => 'focus' in c);
            if (existing) return existing.focus();
            if (self.clients.openWindow) return self.clients.openWindow('./');
        })
    );
});
