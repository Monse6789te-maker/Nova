// Nova SW — v1.1.0
const CACHE_NAME = 'nova-cache-v1';

const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './nova-logo.png',
];

// ——— Install ———
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    cache.add(url).catch(() => console.warn('No se pudo cachear:', url))
                )
            )
        )
    );
});

// ——— Activate ———
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ——— Fetch ———
self.addEventListener('fetch', event => {
    const { request } = event;

    // FIX: ignorar cualquier esquema que no sea http/https
    // (chrome-extension://, data:, blob:, etc. NO son cacheables)
    if (!request.url.startsWith('http')) return;

    const url = new URL(request.url);

    // CDN externos → siempre red, sin cachear
    const externalHosts = [
        'cdn.jsdelivr.net',
        'fonts.googleapis.com',
        'fonts.gstatic.com',
        'pixabay.com',
        'cdnjs.cloudflare.com',
    ];
    if (externalHosts.some(h => url.hostname.includes(h))) {
        event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
        return;
    }

    // Assets propios → Cache-first con fallback a red
    event.respondWith(
        caches.match(request).then(cached => {
            if (cached) return cached;

            return fetch(request).then(response => {
                if (
                    !response ||
                    response.status !== 200 ||
                    response.type === 'opaque'
                ) {
                    return response;
                }

                const clone = response.clone();
                caches.open(CACHE_NAME)
                    .then(cache => cache.put(request, clone))
                    .catch(() => {});

                return response;
            }).catch(() => {
                if (request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
                return new Response('', { status: 503 });
            });
        })
    );
});
