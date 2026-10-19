// Rova service worker: the app opens instantly and still opens with no signal.
const V = "rova-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", (e) => {
  const req = e.request; if (req.method !== "GET") return;
  const u = new URL(req.url);
  // The app page: always try the network first (so updates show right away), fall back to the saved copy
  if (u.origin === location.origin && u.pathname === "/") {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const c = r.clone(); caches.open(V).then((x) => x.put("/", c)); } return r; }).catch(() => caches.match("/")));
    return;
  }
  // Map library, fonts and icons never change at the same address: serve from the phone
  if (/(^|\.)unpkg\.com$|fonts\.googleapis\.com$|fonts\.gstatic\.com$/.test(u.hostname) || (u.origin === location.origin && /\.(png|jpg)$/.test(u.pathname))) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const c = r.clone(); caches.open(V).then((x) => x.put(req, c)); } return r; })));
  }
});
