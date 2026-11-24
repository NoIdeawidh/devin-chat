// Service Worker fuer Devin Remote.
// App-Shell: stale-while-revalidate, CDN-Module (jsdelivr): cache-first,
// Supabase/REST: nie cachen.
const VERSION = 'v3';
const SHELL_CACHE = `dr-shell-${VERSION}`;
const CDN_CACHE = `dr-cdn-${VERSION}`;
const SHELL = ['./', 'index.html', 'app.js', 'apply.js', 'style.css', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL_CACHE, CDN_CACHE].includes(k)).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Supabase & Auth: immer Netz, nie Cache.
  if (url.hostname.endsWith('supabase.co')) return;
  // CDN-Module (gepinnter jsdelivr-Import): cache-first.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.open(CDN_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }
  // Eigenes Shell / Mock-Fixture: stale-while-revalidate.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(SHELL_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        const fresh = fetch(e.request)
          .then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; })
          .catch(() => hit);
        return hit || fresh;
      }),
    );
  }
});
