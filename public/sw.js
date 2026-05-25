// Service Worker for Dashboard Caching
// Strategy: Network First for JS/CSS (always fresh), Cache fallback for offline
const CACHE_NAME = 'ikiru-dashboard-v3';
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/dashboard.css',
  '/script.js',
  '/dashboard-render.js',
  '/dashboard-utils.js',
];

// Install event - pre-cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHE_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - Network First strategy
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Skip non-HTTP requests (chrome-extension://, data:, blob:, etc.)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return;
  }

  // Skip API requests — always go directly to network
  if (url.includes('/api/')) {
    return;
  }

  // Network First: try network, fall back to cache if offline
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Clone immediately — Response is a stream, must clone before any async op
        if (networkResponse.ok && event.request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed (offline) — serve from cache
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          // Last resort: only return cached root HTML for navigation/document requests
          // This prevents broken images or scripts from being replaced by HTML content
          if (event.request.mode === 'navigate' || event.request.destination === 'document') {
            return caches.match('/');
          }
        });
      })
  );
});
