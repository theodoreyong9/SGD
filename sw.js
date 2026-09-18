// sw.js — caches the app shell so SGD's page, styles, and the last graph
// you loaded still open with no network. Publishing/searching against a
// live GitHub Issue obviously still needs a real connection, but reading
// what's already on screen (or was, last time you had one) doesn't.

const CACHE_NAME = 'sgd-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles.css',
  './src/app.js',
  './src/config.js',
  './src/embeddings.js',
  './src/geolocation.js',
  './src/github-api.js',
  './src/graph-render.js',
  './src/oauth.js',
  './src/publish.js',
  './src/semantic.js',
  './src/synthesis.js',
  './src/tracker.js',
  './data/graph.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only manage same-origin app-shell requests; let CDN modules (WebLLM,
  // transformers.js, fonts) and the GitHub API pass straight through.
  if (url.origin !== self.location.origin) return;

  // Network-first, cache as fallback — not cache-first, so an online
  // reload always sees the live deploy and the latest graph.json, and
  // only falls back to whatever's cached when the network request
  // actually fails (genuinely offline).
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return res;
    }).catch(() => caches.match(event.request))
  );
});
