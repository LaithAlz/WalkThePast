/* Walk the Past service worker: cache-first for world assets so the hero world
   loads instantly and offline. Everything else goes to the network. */
const CACHE = "wtp-worlds-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isWorldAsset =
    url.pathname.includes("/worlds/") ||
    url.hostname === "wlt-ai-cdn.art" ||
    url.hostname.endsWith("marble.worldlabs.ai");
  if (event.request.method !== "GET" || !isWorldAsset) return;
  if (url.pathname.endsWith("world.json") || url.pathname.endsWith("index.json")) return; // manifests stay fresh
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok && res.status === 200) cache.put(event.request, res.clone());
      return res;
    }),
  );
});
