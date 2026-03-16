const CACHE = 'pharmascan-v5';
const ASSETS = ['./', './index.html', './app.js', './manifest.json'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== CACHE).map(n => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(f => { if (f.status === 200) { const c = f.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); } return f; }).catch(() => caches.match('./index.html')))));
