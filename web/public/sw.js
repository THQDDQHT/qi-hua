const CACHE_NAME = "infinite-canvas-shell-v1";
const SHELL = ["/", "/image", "/manifest.webmanifest", "/logo.svg"];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/health/") || request.destination === "image") return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok && response.type === "basic") {
                    const copy = response.clone();
                    void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
    );
});
