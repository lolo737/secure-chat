/* Offline shell: the app opens with no signal; messages wait in the outbox until it's back. */
const CACHE = "securechat-v2";
const SHELL = ["./", "index.html", "css/app.css", "js/config.js", "js/core.js", "js/app.js",
  "vendor/nacl-fast.min.js", "vendor/jsQR.js", "vendor/qrcode.js", "manifest.webmanifest", "icons/icon-192.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
