const SHELL = "rcs-shell-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const response = await fetch("/");
      const html = await response.clone().text();
      await cache.put("/", response);
      const assets = [...html.matchAll(/["'](\/assets\/[^"']+)["']/g)].map(
        (m) => m[1],
      );
      await cache.addAll([
        "/icon.svg",
        "/icon-192.png",
        "/manifest.webmanifest",
        ...assets,
      ]);
    })(),
  );
  self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/web/") ||
    url.pathname.startsWith("/@") ||
    url.pathname.includes("node_modules")
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(SHELL).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/"))
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches
                .open(SHELL)
                .then((cache) => cache.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
});
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {}
  const notification = payload.notification || payload.data || {};
  event.waitUntil(
    self.registration.showNotification(notification.title || "RCS", {
      body: notification.body || "Новое событие в команде",
      icon: "/icon-192.png",
      tag: payload.data?.notification_id || payload.fcmMessageId || undefined,
      data: { link: payload.data?.link || "notifications" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link || "notifications";
  const safe =
    /^(shift:[a-f0-9-]+|home|schedule|exchange|payroll|notifications|profile|employees|types)$/.test(
      link,
    )
      ? link
      : "notifications";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const target = `${location.origin}/#${safe}`;
        if (clients[0]) {
          await clients[0].navigate(target);
          return clients[0].focus();
        }
        return self.clients.openWindow(target);
      }),
  );
});
