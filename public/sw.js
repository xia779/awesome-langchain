// Service Worker - AI 智能体 PWA 离线缓存
const CACHE_NAME = 'ai-agent-v1';
const ASSETS = [
  '/m',
  '/m/manifest.json',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    }).catch(function() {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) { return name !== CACHE_NAME; }).map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  // 只对 GET 请求缓存，API 请求走网络
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/')) return; // API 不缓存

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      // Network first, fallback to cache
      return fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return response;
      }).catch(function() {
        return cached || new Response('Offline', { status: 503 });
      });
    })
  );
});
