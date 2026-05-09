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
    let sceneRef = null;
    let particlePool = [];
    let activeParticles = [];
    const density = (isMobile || lowMem) ? 0.65 : 1;
    const maxParticles = (isMobile || lowMem) ? 90 : 160;
    const lastPulseAt = new Map();

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

    function rand(min, max) {
      return min + Math.random() * (max - min);
    }

    function clamp(v, min, max) {
      return Math.max(min, Math.min(max, v));
    }

    function scaleCount(n) {
      return Math.max(1, Math.round(n * density));
    }

    const SOUND_PRESETS = {
      default: {
        count: scaleCount(8),
        color: 0x80d8ff,
        speed: [60, 110],
        life: [0.18, 0.28],
        scale: [0.5, 0.9],
        jitter: 16,
        alpha: 0.8,
        drag: 0.9,
        gap: 40,
      },
      type: {
        count: scaleCount(6),
        color: 0x80d8ff,
        speed: [40, 90],
        life: [0.16, 0.26],
        scale: [0.4, 0.8],
        jitter: 12,
        alpha: 0.75,
        drag: 0.9,
        gap: 26,
      },
      backspace: {
        count: scaleCount(8),
        color: 0xff8a80,
        speed: [50, 110],
        life: [0.18, 0.28],
        scale: [0.5, 0.95],
        jitter: 14,
        alpha: 0.8,
        drag: 0.9,
        gap: 40,
      },
      enter: {
        count: scaleCount(12),
        color: 0x69f0ae,
        speed: [70, 140],
        life: [0.22, 0.34],
        scale: [0.6, 1.1],
        jitter: 20,
        alpha: 0.85,
        drag: 0.9,
        gap: 120,
      },
      "s-error": {
        count: scaleCount(16),
        color: 0xff5252,
        speed: [90, 170],
        life: [0.24, 0.36],
        scale: [0.7, 1.25],
        jitter: 30,
        alpha: 0.9,
        drag: 0.92,
        gap: 90,
      },
      "s-win": {
        count: scaleCount(28),
        color: 0xffd54f,
        speed: [110, 200],
        life: [0.3, 0.46],
        scale: [0.8, 1.5],
        jitter: 40,
        alpha: 0.95,
        drag: 0.93,
        gap: 200,
      },
      "s-lose": {
        count: scaleCount(20),
        color: 0x8c9eff,
        speed: [90, 160],
        life: [0.26, 0.4],
        scale: [0.7, 1.3],
        jitter: 34,
        alpha: 0.85,
        drag: 0.92,
        gap: 160,
      },
      "s-coin": {
        count: scaleCount(18),
        color: 0xffe082,
        speed: [100, 180],
        life: [0.24, 0.38],
        scale: [0.7, 1.3],
        jitter: 24,
        alpha: 0.9,
        drag: 0.92,
        gap: 90,
        angle: [-Math.PI / 2 - 0.9, -Math.PI / 2 + 0.9],
      },
      "s-token": {
        count: scaleCount(20),
        color: 0xb388ff,
        speed: [100, 180],
        life: [0.26, 0.4],
        scale: [0.7, 1.35],
        jitter: 24,
        alpha: 0.9,
        drag: 0.92,
        gap: 100,
      },
      "s-click": {
        count: scaleCount(5),
        color: 0x90caf9,
        speed: [40, 80],
        life: [0.14, 0.22],
        scale: [0.35, 0.6],
        jitter: 10,
        alpha: 0.7,
        drag: 0.88,
        gap: 32,
      },
      "s-type": {
        count: scaleCount(6),
        color: 0x80d8ff,
        speed: [40, 90],
        life: [0.16, 0.26],
        scale: [0.4, 0.8],
        jitter: 12,
        alpha: 0.75,
        drag: 0.9,
        gap: 26,
      },
    };

    function allowPulse(kind, gap) {
      const g = typeof gap === "number" ? gap : 40;
      const now =
        typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      const last = lastPulseAt.get(kind) || 0;
      if (now - last < g) return false;
      lastPulseAt.set(kind, now);
      return true;
    }

    function getDefaultPos(kind) {
      const cx = bounds.w * 0.5;
      const cy = bounds.h * 0.58;

      if (kind === "s-win") return { x: cx, y: bounds.h * 0.42 };
      if (kind === "s-lose") return { x: cx, y: bounds.h * 0.5 };
      if (kind === "s-error") return { x: cx, y: bounds.h * 0.55 };
      if (kind === "s-coin" || kind === "s-token") return { x: bounds.w * 0.7, y: bounds.h * 0.35 };
      if (kind === "enter") return { x: cx, y: bounds.h * 0.6 };
      return { x: cx, y: cy };
    }

    function resolvePreset(kind) {
      const key = String(kind || "");
      return SOUND_PRESETS[key] || SOUND_PRESETS.default;
    }

    function spawnBurst(kind, pos) {
      const cfg = resolvePreset(kind);
      if (!cfg || !sceneRef) return;
      if (!allowPulse(kind || "default", cfg.gap)) return;

      const base = getDefaultPos(kind);
      const x0 = Number.isFinite(pos && pos.x) ? pos.x : base.x;
      const y0 = Number.isFinite(pos && pos.y) ? pos.y : base.y;

      const count = cfg.count || 8;
      const jitter = cfg.jitter ?? 16;

      for (let i = 0; i < count; i++) {
        if (activeParticles.length >= maxParticles) break;

        let p = particlePool.pop();
        if (!p) {
          p = sceneRef.add.image(0, 0, "vzSpark");
          p.setBlendMode(Phaser.BlendModes.ADD);
        }

        const px = clamp(x0 + rand(-jitter, jitter), -20, bounds.w + 20);
        const py = clamp(y0 + rand(-jitter, jitter), -20, bounds.h + 20);

        const speed = rand(cfg.speed[0], cfg.speed[1]);
        const angle = cfg.angle ? rand(cfg.angle[0], cfg.angle[1]) : rand(0, Math.PI * 2);

        p.setActive(true);
        p.setVisible(true);
        p.setPosition(px, py);
        p.setTint(cfg.color || 0x80d8ff);
        p._alpha = cfg.alpha ?? 0.8;
        p.alpha = p._alpha;
        p._vx = Math.cos(angle) * speed;
        p._vy = Math.sin(angle) * speed;
        p._life = rand(cfg.life[0], cfg.life[1]);
        p._age = 0;
        p._drag = cfg.drag ?? 0.9;
        p._scale = rand(cfg.scale[0], cfg.scale[1]);
        p.setScale(p._scale);

        activeParticles.push(p);
      }
    }

    function pulseSound(kind, pos) {
      spawnBurst(kind, pos);
    }

    function create() {
      const scene = this;
      sceneRef = scene;

      const gfx = scene.make.graphics({ x: 0, y: 0, add: false });
      gfx.fillStyle(0xffffff, 1);
      gfx.fillCircle(32, 32, 32);
      gfx.generateTexture("vzGlow", 64, 64);
      gfx.destroy();

      const spark = scene.make.graphics({ x: 0, y: 0, add: false });
      spark.fillStyle(0xffffff, 1);
      spark.fillCircle(4, 4, 4);
      spark.generateTexture("vzSpark", 8, 8);
      spark.destroy();

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

      for (let i = activeParticles.length - 1; i >= 0; i--) {
        const p = activeParticles[i];
        if (!p || p._life <= 0) continue;

        p._age += dt;
        if (p._age >= p._life) {
          p.setActive(false);
          p.setVisible(false);
          activeParticles.splice(i, 1);
          particlePool.push(p);
          continue;
        }

        p._vx *= p._drag;
        p._vy *= p._drag;
        p.x += p._vx * dt;
        p.y += p._vy * dt;

        const k = 1 - p._age / p._life;
        p.alpha = (p._alpha ?? 0.8) * k;
        p.setScale(p._scale * (0.6 + 0.4 * k));
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

      try {
        activeParticles.forEach((p) => p && p.destroy && p.destroy());
        particlePool.forEach((p) => p && p.destroy && p.destroy());
      } catch (_) {}

      activeParticles = [];
      particlePool = [];
      sceneRef = null;

      try { delete grid.dataset.vzPhaserFxInit; } catch (_) {}
    }

    window.vzPhaserFx = { destroy, game, pulseSound };
    setTimeout(() => boot(0), 0);
  }
})();
