/* ==============================
   VARDU ZONA — Phaser 3 grid FX
   File: phaser-fx.js
   ============================== */
(function () {
  "use strict";

  const OVERLAY_ID = "vz-phaser-fx";
  const REDUCE_MOTION =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (REDUCE_MOTION) return;

  const WAIT_STEP_MS = 70;
  const MAX_TRIES = 260;

  let lastGridEl = null;

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function boot(tryN = 0) {
    const grid = document.getElementById("grid");
    if (!grid) {
      if (tryN < MAX_TRIES) return setTimeout(() => boot(tryN + 1), WAIT_STEP_MS);
      return;
    }

    if (lastGridEl && lastGridEl !== grid) {
      try {
        window.vzPhaserFx && window.vzPhaserFx.destroy && window.vzPhaserFx.destroy();
      } catch (_) {}
    }
    lastGridEl = grid;

    if (grid.dataset.vzPhaserFxInit === "1") return;

    if (window.Phaser) return init(grid);

    if (tryN < MAX_TRIES) return setTimeout(() => boot(tryN + 1), WAIT_STEP_MS);
  }

  ready(() => boot(0));

  function ensureOverlay(grid) {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("aria-hidden", "true");
    }

    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";

    const cs = getComputedStyle(grid);
    if (cs.position === "static") grid.style.position = "relative";

    if (!grid.contains(overlay)) grid.appendChild(overlay);

    return overlay;
  }

  function init(grid) {
    if (grid.dataset.vzPhaserFxInit === "1") return;
    grid.dataset.vzPhaserFxInit = "1";

    const isMobile =
      window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
    const lowMem =
      typeof navigator !== "undefined" &&
      navigator.deviceMemory &&
      navigator.deviceMemory <= 4;

    const overlay = ensureOverlay(grid);

    let bounds = {
      w: Math.max(1, grid.clientWidth),
      h: Math.max(1, grid.clientHeight),
    };

    let glows = [];
    let game = null;
    let ro = null;
    let gridObserver = null;

    const config = {
      type: Phaser.AUTO,
      parent: overlay,
      width: bounds.w,
      height: bounds.h,
      transparent: true,
      backgroundColor: "#00000000",
      scale: { mode: Phaser.Scale.NONE },
      fps: {
        target: (isMobile || lowMem) ? 24 : 30,
        forceSetTimeOut: true,
      },
      scene: {
        create,
        update,
      },
    };

    function create() {
      const scene = this;

      const gfx = scene.make.graphics({ x: 0, y: 0, add: false });
      gfx.fillStyle(0xffffff, 1);
      gfx.fillCircle(32, 32, 32);
      gfx.generateTexture("vzGlow", 64, 64);
      gfx.destroy();

      const count = (isMobile || lowMem) ? 6 : 10;
      const speed = (isMobile || lowMem) ? 8 : 14;
      const colors = [0x4fc3f7, 0xff80ab, 0x7c4dff, 0x00e5ff, 0xffc400];

      glows = [];

      for (let i = 0; i < count; i++) {
        const s = scene.add.image(
          Math.random() * bounds.w,
          Math.random() * bounds.h,
          "vzGlow"
        );
        s.setBlendMode(Phaser.BlendModes.ADD);
        s.setAlpha(0.08 + Math.random() * 0.12);

        const base = 1.4 + Math.random() * 2.8;
        s.setScale(base);
        s.setTint(colors[i % colors.length]);

        s._vx = (Math.random() - 0.5) * speed;
        s._vy = (Math.random() - 0.5) * speed;
        s._baseScale = base;
        s._pulse = Math.random() * Math.PI * 2;
        s._pulseSpeed = 0.6 + Math.random() * 0.7;

        glows.push(s);
      }
    }

    function update(_, delta) {
      const dt = Math.min(0.05, delta / 1000);

      for (const g of glows) {
        g.x += g._vx * dt;
        g.y += g._vy * dt;

        if (g.x < -40 || g.x > bounds.w + 40) g._vx *= -1;
        if (g.y < -40 || g.y > bounds.h + 40) g._vy *= -1;

        g._pulse += dt * g._pulseSpeed;
        g.setScale(g._baseScale + Math.sin(g._pulse) * 0.15);
      }
    }

    try {
      game = new Phaser.Game(config);
    } catch (e) {
      try { delete grid.dataset.vzPhaserFxInit; } catch (_) {}
      return;
    }

    function ensureMounted() {
      if (!grid.contains(overlay)) grid.appendChild(overlay);
    }

    function resize() {
      ensureMounted();
      const w = Math.max(1, grid.clientWidth);
      const h = Math.max(1, grid.clientHeight);
      if (!w || !h || (w === bounds.w && h === bounds.h)) return;

      bounds.w = w;
      bounds.h = h;

      if (game && game.scale && typeof game.scale.resize === "function") {
        game.scale.resize(w, h);
      }

      overlay.style.width = w + "px";
      overlay.style.height = h + "px";
    }

    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => resize());
      ro.observe(grid);
    }
    window.addEventListener("resize", resize, { passive: true });

    gridObserver = new MutationObserver(() => {
      ensureMounted();
      resize();
    });
    gridObserver.observe(grid, { childList: true, subtree: true });

    const visHandler = () => {
      if (!game || !game.loop) return;
      if (document.hidden) game.loop.sleep();
      else game.loop.wake();
    };
    document.addEventListener("visibilitychange", visHandler);

    function destroy() {
      try {
        window.removeEventListener("resize", resize);
        document.removeEventListener("visibilitychange", visHandler);
        if (ro) ro.disconnect();
        if (gridObserver) gridObserver.disconnect();
      } catch (_) {}

      try {
        if (game) game.destroy(true);
      } catch (_) {}

      try { delete grid.dataset.vzPhaserFxInit; } catch (_) {}
    }

    window.vzPhaserFx = { destroy, game };
    setTimeout(() => boot(0), 0);
  }
})();
