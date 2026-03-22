// Nova SW — v2.0.0 (GitHub Pages compatible)
// Detects base path automatically — works at root or in subdirectory

const CACHE_VERSION = 'nova-v2';

// Detect base path from SW location (e.g. /Nova/ on GitHub Pages)
const SW_SCOPE = self.registration.scope; // e.g. https://user.github.io/Nova/
const BASE_PATH = new URL(SW_SCOPE).pathname; // e.g. /Nova/

const STATIC_ASSETS = [
    BASE_PATH,
    BASE_PATH + 'index.html',
    BASE_PATH + 'nova-logo.png',
    BASE_PATH + 'manifest.json',
    BASE_PATH + 'sw.js',
];

// ——— Install: cache static assets ———
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then(cache =>
            Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    cache.add(url).catch(e => console.warn('SW: no se pudo cachear', url, e.message))
                )
            )
        )
    );
});

// ——— Activate: clear old caches ———
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_VERSION).map(k => {
                    console.log('SW: eliminando caché antigua:', k);
                    return caches.delete(k);
                })
            ))
            .then(() => self.clients.claim())
    );
});

// ——— Fetch: smart caching strategy ———
self.addEventListener('fetch', event => {
    const { request } = event;

    // Skip non-HTTP requests (chrome-extension, data, blob)
    if (!request.url.startsWith('http')) return;

    const url = new URL(request.url);

    // CDN & external APIs → network-only (no cache)
    const networkOnly = [
        'cdn.jsdelivr.net',
        'fonts.googleapis.com',
        'fonts.gstatic.com',
        'pixabay.com',
        'cdnjs.cloudflare.com',
        'unpkg.com',
        'gstatic.com',
        'overpass-api.de',
        'openstreetmap.org',
        'tile.openstreetmap.org',
        'firestore.googleapis.com',
        'firebase',
        'identitytoolkit',
    ];
    if (networkOnly.some(h => url.hostname.includes(h) || url.href.includes(h))) {
        event.respondWith(
            fetch(request).catch(() => new Response('', { status: 503 }))
        );
        return;
    }

    // Own assets → Cache-first, then network, then offline fallback
    event.respondWith(
        caches.match(request).then(cached => {
            if (cached) return cached;

            return fetch(request).then(response => {
                // Only cache valid same-origin responses
                if (!response || response.status !== 200 || response.type === 'opaque') {
                    return response;
                }
                const clone = response.clone();
                caches.open(CACHE_VERSION)
                    .then(cache => cache.put(request, clone))
                    .catch(() => {});
                return response;
            }).catch(() => {
                // Offline fallback: serve index.html for navigation
                if (request.mode === 'navigate') {
                    return caches.match(BASE_PATH + 'index.html')
                        || caches.match(BASE_PATH)
                        || new Response('<h1>Nova — Sin conexión</h1><p>Carga la app con internet primero.</p>', {
                            headers: { 'Content-Type': 'text/html' }
                        });
                }
                return new Response('', { status: 503 });
            });
        })
    );
});
