// Service Worker for AvGeek Flight Tracker
// Minimal SW - just for PWA install, no aggressive caching

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Clear all old caches
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key))))
    );
    self.clients.claim();
});

// Network-first for everything - no caching issues
self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request));
});
