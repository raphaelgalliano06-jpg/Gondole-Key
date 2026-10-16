/* Gondole Key — l'appli fonctionne même sans réseau (le code est calculé sur le téléphone). */
const CACHE = 'gondole-key-v1';
const FICHIERS = ['/app', '/assets/style.css', '/assets/app.css', '/assets/app.js', '/assets/icon.svg', '/assets/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;
  // Réseau d'abord (mises à jour), cache si hors ligne.
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok && FICHIERS.includes(url.pathname)) { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copie)); } return r; })
      .catch(() => caches.match(url.pathname === '/' ? '/app' : e.request))
  );
});
