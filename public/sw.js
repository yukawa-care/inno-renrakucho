// 院の連絡帳：スマホへのお知らせを受け取る係
// 届くのは「お知らせがある」という合図だけ。中身はアプリへ取りに行く。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let n = { title: "院の連絡帳", body: "新しいお知らせがあります。開いて確かめてください。" };
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const r = await fetch("/api/notices/latest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub ? sub.endpoint : "" }),
      });
      if (r.ok) n = await r.json();
    } catch (x) { /* 取れなくても、合図だけは出す */ }
    await self.registration.showNotification(n.title, {
      body: n.body, icon: "/icon-192.png", badge: "/icon-192.png", tag: "renraku-" + Date.now(), data: { url: "/" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && "focus" in c) return c.focus();
    }
    return self.clients.openWindow("/");
  })());
});
