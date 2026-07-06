const CACHE_NAME = 'meu-pwa-cache-v1';
const urlsToCache = [
  './',
  './index.html',
  './app.js',
  './styles/style.css',
  './scripts/database.js',
  './scripts/ai-worker.js',
  './manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .catch(err => console.log('Cache failed:', err))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});
