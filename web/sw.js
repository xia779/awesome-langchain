// sw.js - Service Worker（用于离线缓存）
const CACHE_NAME = 'ai-tester-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/script.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});