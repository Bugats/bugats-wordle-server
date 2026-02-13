/* ==============================
   VARDU ZONA — Phaser 3 logo FX
   File: phaser-logo.js
   ============================== */
(function () {
  "use strict";

  const OVERLAY_ID = "vz-logo-fx";
  const REDUCE_MOTION =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (REDUCE_MOTION) return;

  const WAIT_STEP_MS = 70;
  const MAX_TRIES = 220;

  let lastHost = null;

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function boot(tryN = 0) {
    const overlay = document.getElementById(OVERLAY_ID);
    const host = overlay ? overlay.parentElement : null;

    if (!overlay || !host) {
      if (tryN < MAX_TRIES) return setTimeout(() => boot(tryN + 1), WAIT_STEP_MS);
      return;
    }

    if (lastHost && lastHost !== host) {
      try {
        window.vzLogoFx && window.vzLogoFx.destroy && window.vzLogoFx.destroy();
      } catch (_) {}
    }
    lastHost = host;

    if (overlay.dataset.vzLogoFxInit === "1") return;

    if (window.Phaser) return init(overlay, host);

    if (tryN < MAX_TRIES) return setTimeout(() => boot(tryN + 1), WAIT_STEP_MS);
  }

  ready(() => boot(0));

  function init(overlay, host) {
    if (overlay.dataset.vzLogoFxInit === "1") return;
    overlay.dataset.vzLogoFxInit = "1";

    const isMobile =
      window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
    const lowMem =
      typeof navigator !== "undefined" &&
      navigator.deviceMemory &&
      navigator.deviceMemory <= 4;

    const cs = getComputedStyle(host);
    if (cs.position === "static") host.style.position = "relative";

    let bounds = {
      w: Math.max(1, host.clientWidth),
      h: Math.max(1, host.clientHeight),
    };

    let glows = [];
    let sparkles = [];
    let game = null;
    let ro = null;

    const config = {
      type: Phaser.AUTO,
      parent: overlay,
      width: bounds.w,
      height: bounds.h,
      transparent: true,
      backgroundColor: "#00000000",
      scale: { mode: Phaser.Scale.NONE },
      fps: {
        target: (isMobile || lowMem) ? 20 : 30,
        forceSetTimeOut: true,
      },
      scene: { create, update },
    };

    function rand(min, max) {
      return min + Math.random() * (max - min);
    }

    function wrap(v, min, max) {
      if (v < min) return max;
      if (v > max) return min;
      return v;
    }

    function create() {
      const scene = this;

      const gfx = scene.make.graphics({ x: 0, y: 0, add: false });
      gfx.fillStyle(0xffffff, 1);
      gfx.fillCircle(32, 32, 32);
      gfx.generateTexture("vzLogoGlow", 64, 64);
      gfx.destroy();

      const dot = scene.make.graphics({ x: 0, y: 0, add: false });
      dot.fillStyle(0xffffff, 1);
      dot.fillCircle(3, 3, 3);
      dot.generateTexture("vzLogoSpark", 6, 6);
      dot.destroy();

      const glowCount = (isMobile || lowMem) ? 5 : 9;
      const sparkleCount = (isMobile || lowMem) ? 8 : 14;
      const colors = [0xff4081, 0xff1744, 0x7c4dff, 0x2196f3, 0x00e5ff, 0xff6d00];

      glows = [];
      for (let i = 0; i < glowCount; i++) {
        const g = scene.add.image(
          rand(0, bounds.w),
          rand(bounds.h * 0.15, bounds.h * 0.85),
          "vzLogoGlow"
        );
        g.setBlendMode(Phaser.BlendModes.ADD);
        g.setTint(colors[i % colors.length]);
        g._baseAlpha = rand(0.12, 0.24);
        g.alpha = g._baseAlpha;
        g._baseScale = rand(1.1, 2.2);
        g.setScale(g._baseScale);
        g._vx = rand(-7, 7) * ((isMobile || lowMem) ? 0.55 : 1);
        g._vy = rand(-3, 3) * ((isMobile || lowMem) ? 0.5 : 1);
        g._pulse = rand(0, Math.PI * 2);
        g._pulseSpeed = rand(0.25, 0.5);
        glows.push(g);
      }

      sparkles = [];
      for (let i = 0; i < sparkleCount; i++) {
        const s = scene.add.image(
          rand(0, bounds.w),
          rand(bounds.h * 0.2, bounds.h * 0.8),
          "vzLogoSpark"
        );
        s.setBlendMode(Phaser.BlendModes.ADD);
        s.setTint(colors[(i + 2) % colors.length]);
        s._baseAlpha = rand(0.25, 0.6);
        s.alpha = s._baseAlpha;
        s._baseScale = rand(0.5, 1.1);
        s.setScale(s._baseScale);
        s._phase = rand(0, Math.PI * 2);
        s._pulseSpeed = rand(0.8, 1.35);
        sparkles.push(s);
      }
    }

    let t = 0;
    function update(_, delta) {
      const dt = Math.min(0.05, delta / 1000);
      t += dt;

      for (const g of glows) {
        g.x = wrap(g.x + g._vx * dt, -60, bounds.w + 60);
        g.y = wrap(g.y + g._vy * dt, -40, bounds.h + 40);
        g._pulse += dt * g._pulseSpeed;
        g.setScale(g._baseScale + Math.sin(g._pulse) * 0.1);
        g.alpha = g._baseAlpha + Math.sin(g._pulse) * 0.02;
      }

      for (const s of sparkles) {
        const w = Math.sin(t * s._pulseSpeed + s._phase);
        s.alpha = s._baseAlpha + w * 0.18;
        s.setScale(s._baseScale + w * 0.12);
      }
    }

    try {
      game = new Phaser.Game(config);
    } catch (e) {
      try { delete overlay.dataset.vzLogoFxInit; } catch (_) {}
      return;
    }

    function resize() {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
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
      ro.observe(host);
    }
    window.addEventListener("resize", resize, { passive: true });

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
      } catch (_) {}

      try {
        if (game) game.destroy(true);
      } catch (_) {}

      try { delete overlay.dataset.vzLogoFxInit; } catch (_) {}
    }

    window.vzLogoFx = { destroy, game };
  }
})();
