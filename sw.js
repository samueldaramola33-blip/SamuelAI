// Minimal service worker — just enough to make SamuelAI installable
// ("Add to Home Screen") on phones and desktops.
//
// Deliberately simple: it only caches the static app shell (the page
// itself, icons, manifest) for a smoother reload. It NEVER caches or
// intercepts /api/ calls or external requests (Gemini, Pollinations,
// Tavily) — those always go live over the network, untouched.

const CACHE_NAME = 'samuelai-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => { /* fine if some shell files aren't found yet */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only touch same-origin GET requests for the app shell.
  // Everything else (API calls, streaming chat, external image/search
  // APIs) is left completely alone — default browser behavior applies.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
