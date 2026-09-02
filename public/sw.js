/*
 * Service worker cho Vyen — AI Innovations.
 * Chiến lược bảo toàn:
 *  - /api/*            → không can thiệp (stream phải đi thẳng mạng)
 *  - /_next/static/*   → cache-first (asset có hash, bất biến)
 *  - navigation        → network-first, fallback cache rồi /offline.html
 *  - asset tĩnh khác   → stale-while-revalidate
 */
const VERSION = 'v4';
const STATIC_CACHE = `aichat-static-${VERSION}`;
const PAGES_CACHE = `aichat-pages-${VERSION}`;
const OFFLINE_URL = '/offline.html';

const PRECACHE_URLS = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req, event));
    return;
  }

  event.respondWith(staleWhileRevalidate(req, STATIC_CACHE, event));
});

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
    try {
      const body = await res.blob();
      const cloned = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      const cache = await caches.open(cacheName);
      await cache.put(req, cloned);
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch {
      return new Response(null, { status: res.status });
    }
  }
  return res;
}

async function networkFirstPage(req, event) {
  try {
    const res = await fetch(req);
    if (!(res.ok && (res.type === 'basic' || res.type === 'cors'))) {
      return res;
    }
    const cache = await caches.open(PAGES_CACHE);
    const body = await res.blob();
    const cloned = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    const put = cache.put(req, cloned);
    if (event && event.waitUntil) event.waitUntil(put);
    else await put;
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch {
    const cached = (await caches.match(req)) || (await caches.match('/'));
    return cached || caches.match(OFFLINE_URL);
  }
}

async function staleWhileRevalidate(req, cacheName, event) {
  const cached = await caches.match(req);
  const network = fetch(req)
    .then(async (res) => {
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
        try {
          const body = await res.blob();
          const cloned = new Response(body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
          const put = caches.open(cacheName).then((cache) => cache.put(req, cloned));
          // Revalidate chạy nền — phải báo cho browser đợi, nếu không SW bị
          // kill giữa chừng là cache mãi cũ.
          if (event && event.waitUntil) event.waitUntil(put);
          return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
        } catch {
          return new Response(null, { status: res.status, statusText: res.statusText });
        }
      }
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

async function cacheFirstSafe(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
    try {
      const body = await res.blob();
      const cloned = new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      const cache = await caches.open(cacheName);
      await cache.put(req, cloned);
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch {
      return new Response(null, { status: res.status });
    }
  }
  return res;
}
