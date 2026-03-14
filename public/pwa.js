(() => {
  if (!("serviceWorker" in navigator)) return;

  const SW_VERSION = "2026-03-26";
  const SW_VERSION_KEY = "vz_sw_version";
  const SW_URL = "sw.js?v=" + SW_VERSION;

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  async function resetOldServiceWorkers() {
    try {
      const stored = localStorage.getItem(SW_VERSION_KEY);
      if (stored === SW_VERSION) return;
      localStorage.setItem(SW_VERSION_KEY, SW_VERSION);

      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    } catch (_) {}
  }

  window.addEventListener("load", () => {
    resetOldServiceWorkers().finally(() => {
      navigator.serviceWorker
        .register(SW_URL)
        .then((reg) => {
          if (!reg) return;
          reg.update().catch(() => {});
          setInterval(() => reg.update().catch(() => {}), 5 * 60 * 1000);
          reg.addEventListener("updatefound", () => {
            const worker = reg.installing;
            if (!worker) return;
            worker.addEventListener("statechange", () => {
              if (
                worker.state === "installed" &&
                navigator.serviceWorker.controller
              ) {
                worker.postMessage({ type: "SKIP_WAITING" });
              }
            });
          });
        })
        .catch(() => {});
    });
  });
})();
