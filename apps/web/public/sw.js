/* Workspace service worker: an offline-capable app shell. Never caches API, realtime, MCP or OAuth traffic. */
const VERSION = "v2";
const SHELL = `ws-shell-${VERSION}`; // index.html (navigations)
const ASSETS = `ws-assets-${VERSION}`; // hashed /assets/* (immutable)
const RUNTIME = `ws-runtime-${VERSION}`; // other same-origin GETs (icons; dev-server modules)
const NEVER = /^\/(api|sync|events|mcp|authorize|oauth|\.well-known)(\/|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add(new Request("/", { cache: "reload" })))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (![SHELL, ASSETS, RUNTIME].includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const cacheable = (url) => url.origin === self.location.origin && !NEVER.test(url.pathname);
const bucket = (url) => (url.pathname.startsWith("/assets/") ? ASSETS : RUNTIME);

// Resources fetched before this worker controlled the page (the first visit) are sent here to cache.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-urls" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    (async () => {
      for (const raw of event.data.urls.slice(0, 500)) {
        let url;
        try {
          url = new URL(raw);
        } catch {
          continue;
        }
        if (!cacheable(url)) continue;
        const cache = await caches.open(url.pathname === "/" ? SHELL : bucket(url));
        if (await cache.match(url.href, MATCH)) continue;
        try {
          const res = await fetch(url.href, { credentials: "same-origin" });
          if (res.ok && res.type === "basic") await cache.put(url.pathname === "/" ? "/" : url.href, res);
        } catch {
          /* offline or gone: best effort */
        }
      }
    })(),
  );
});

async function navigation(request) {
  try {
    const res = await fetch(request);
    if (res.ok && (res.headers.get("Content-Type") || "").includes("text/html")) {
      const copy = res.clone();
      void caches.open(SHELL).then((c) => c.put("/", copy));
    }
    return res;
  } catch {
    const cached = await caches.match("/", { cacheName: SHELL, ignoreVary: true });
    return cached || new Response("<!doctype html><title>Offline</title><p>You're offline and this app hasn't been saved on this device yet.</p>", { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

// Same-origin static files: `Vary: Origin` (sent by dev servers and some CDNs) must not cause misses.
const MATCH = { ignoreVary: true };

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") void cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(request);
    if (res.ok && res.type === "basic") void cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, MATCH);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!cacheable(url)) return;
  if (request.mode === "navigate") event.respondWith(navigation(request));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(request));
  else if (request.headers.get("Upgrade") !== "websocket") event.respondWith(networkFirst(request));
});
