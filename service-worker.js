// Service Worker: app shell offline + notificações locais de fim de descanso.
//
// Atualização: o shell (index/app/styles/...) é servido do cache (funciona offline),
// mas a página pede periodicamente um CHECK_UPDATE. O SW busca os arquivos na rede
// (sem cache HTTP), compara o hash com a cópia local e, se o servidor tiver versão
// diferente, atualiza o cache e avisa a página (SHELL_UPDATED). Depois de atualizado,
// continua offline até o servidor mudar de novo. Os treinos (treinos/*.json) são
// sempre buscados primeiro na rede, com o cache só como reserva offline.
const SHELL_CACHE = 'academia-shell-v1';
const RUNTIME_CACHE = 'academia-runtime-v1';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.json', 'favicon.png', 'apple-touch-icon.png'];
const CDN_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

async function hashOf(response) {
    const buf = await response.clone().arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Guards against captive portals / error pages answering 200 with something else:
// never let those replace a good cached copy of the app.
async function looksValid(url, res) {
    if (!res || !res.ok || res.redirected) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const path = new URL(url, self.location.href).pathname;
    if (/\.js$/.test(path)) return type.includes('javascript') || type.includes('ecmascript');
    if (/\.css$/.test(path)) return type.includes('css');
    if (/\.json$/.test(path)) { try { await res.clone().json(); return true; } catch (e) { return false; } }
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico)$/.test(path)) return type.startsWith('image/');
    return type.includes('html') || /\/$/.test(path) || /\.html$/.test(path) ? type.includes('html') : true;
}

async function workoutUrls() {
    try {
        const res = await fetch('treinos/index.json', { cache: 'no-store' });
        if (!res.ok) return [];
        const list = await res.json();
        return ['treinos/index.json', ...list.map((t) => 'treinos/' + t.file)];
    } catch (e) {
        return [];
    }
}

// Fetches `urls` from the network and stores them when new or different.
// Returns true when something changed compared to what was cached.
async function refreshInto(cacheName, urls, compare) {
    const cache = await caches.open(cacheName);
    // Phase 1: download and validate everything; Phase 2: write all at once, so a page load
    // in between never pairs a new file with an old one.
    const fetched = [];
    await Promise.all(urls.map(async (u) => {
        try {
            const fresh = await fetch(u, { cache: 'no-store' });
            if (!(await looksValid(u, fresh))) return;
            const old = await cache.match(u);
            if (compare && old && (await hashOf(old)) === (await hashOf(fresh))) return;
            fetched.push({ u, fresh, hadOld: !!old });
        } catch (e) { /* offline: keep what we have */ }
    }));
    let changed = false;
    await Promise.all(fetched.map(async ({ u, fresh, hadOld }) => {
        try { await cache.put(u, fresh); if (compare && hadOld) changed = true; } catch (e) {}
    }));
    return changed;
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await Promise.all(SHELL.map(async (u) => {
            try {
                const res = await fetch(u, { cache: 'reload' });
                if (await looksValid(u, res)) await cache.put(u, res);
            } catch (e) {}
        }));
        await refreshInto(RUNTIME_CACHE, await workoutUrls(), false);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = [SHELL_CACHE, RUNTIME_CACHE];
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('academia-') && !keep.includes(n)).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

// Extends the worker's life until a background cache write finishes (best effort: waitUntil
// throws if the event is already over, in which case the write still runs, just unprotected).
function keep(event, promise) {
    const p = Promise.resolve(promise).catch(() => {});
    try { event.waitUntil(p); } catch (e) {}
}

async function cacheFirst(req, event) {
    const cache = await caches.open(SHELL_CACHE);
    let res = await cache.match(req, { ignoreSearch: true });
    if (res) return res;
    if (req.mode === 'navigate') {
        res = (await cache.match('./')) || (await cache.match('index.html'));
        if (res) return res;
    }
    try {
        const net = await fetch(req);
        if (net.ok) keep(event, cache.put(req, net.clone()));
        return net;
    } catch (e) {
        return Response.error();
    }
}

async function networkFirst(req, event) {
    const cache = await caches.open(RUNTIME_CACHE);
    try {
        const net = await fetch(new Request(req, { cache: 'no-store' }));
        if (!(await looksValid(req.url, net))) throw new Error('resposta inválida');
        keep(event, cache.put(req, net.clone()));
        return net;
    } catch (e) {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached || Response.error();
    }
}

async function staleWhileRevalidate(req, event) {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((net) => {
        if (net.ok || net.type === 'opaque') keep(event, cache.put(req, net.clone()));
        return net;
    }).catch(() => null);
    return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin === location.origin) {
        if (url.pathname.endsWith('service-worker.js')) return;
        if (url.pathname.includes('/treinos/')) return event.respondWith(networkFirst(req, event));
        return event.respondWith(cacheFirst(req, event));
    }
    if (CDN_HOSTS.includes(url.hostname)) event.respondWith(staleWhileRevalidate(req, event));
});

self.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'CHECK_UPDATE') {
        event.waitUntil((async () => {
            const shellChanged = await refreshInto(SHELL_CACHE, SHELL, true);
            const workoutsChanged = await refreshInto(RUNTIME_CACHE, await workoutUrls(), true);
            if (shellChanged || workoutsChanged) {
                const all = await self.clients.matchAll({ type: 'window' });
                all.forEach((c) => c.postMessage({ type: 'SHELL_UPDATED' }));
            }
        })());
        return;
    }

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
