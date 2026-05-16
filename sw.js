// daily — Service Worker v3
// Strategy:
//   - index.html: NETWORK-FIRST, cache fallback. Ensures users see the latest UI
//     when online and prevents the "forgot to bump CACHE_NAME → stale shell" foot-gun.
//   - Other app-shell files: cache-first with background revalidation.
//   - Firebase CDN: network-first, cache fallback.
//   - Firebase realtime data: never cached.
//
// IMPORTANT: bump CACHE_NAME whenever you change the offline-fallback contract
// (cache layout, file list). For routine index.html edits the network-first
// strategy already gives online users fresh content.
const CACHE_NAME = 'daily-v4';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
const CDN_URLS = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js'
];

// Install: cache app shell and CDN resources
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache app shell (must succeed)
      const shellPromise = cache.addAll(APP_SHELL);
      // Cache CDN resources (best effort, don't block install)
      const cdnPromise = Promise.allSettled(
        CDN_URLS.map(url => 
          fetch(url).then(resp => {
            if (resp.ok) return cache.put(url, resp);
          }).catch(() => {})
        )
      );
      return Promise.all([shellPromise, cdnPromise]);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - Navigation & app shell: Cache first, fallback to network, update cache in background
// - CDN (Firebase): Network first, fallback to cache (so we get latest SDK but still work offline)
// - Firebase API calls (*.firebaseio.com): Always network, never cache (realtime data)
// - Everything else: Network first, cache fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache Firebase realtime database requests
  if (url.hostname.includes('firebaseio.com') || 
      url.hostname.includes('firebasedatabase.app') ||
      url.hostname.includes('googleapis.com/identitytoolkit')) {
    return; // Let browser handle normally
  }

  // Navigation requests: network-first so online users always get the latest
  // index.html; fall back to cache when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put('./index.html', clone));
        }
        return resp;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // CDN resources: network first, cache fallback
  if (CDN_URLS.some(cdn => event.request.url.startsWith(cdn)) ||
      url.hostname === 'www.gstatic.com') {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell files: cache first, background update
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return resp;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }
});

// Listen for skip-waiting message from app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
