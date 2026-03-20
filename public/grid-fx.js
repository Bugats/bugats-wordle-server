/* ==============================
   VĀRDU ZONA — PIXI GRID FX (overlay)
   Failā: grid-fx.js
   ============================== */
(function () {
  "use strict";

  const TILE_SEL = ".tile, .vz-tile";
  const OVERLAY_ID = "vz-grid-fx";          // konteineris (DIV) — saskan ar style.css
  const CANVAS_ID = "vz-grid-fx-canvas";   // PIXI canvas iekšā konteinerī

  const REDUCE_MOTION =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (REDUCE_MOTION) return;

  // --- BOOT (FIX) ---
  const WAIT_STEP_MS = 60;
  const MAX_TRIES = 260; // ~15.6s

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
        window.vzGridFx && window.vzGridFx.destroy && window.vzGridFx.destroy();
      } catch (_) {}
    }
    lastGridEl = grid;

    if (grid.dataset.vzGridFxInit === "1") return;

    if (window.PIXI) return init(grid);

    if (tryN < MAX_TRIES) return setTimeout(() => boot(tryN + 1), WAIT_STEP_MS);
  }

  ready(() => boot(0));

  function ensureOverlayAndCanvas(grid) {
    // 1) Overlay konteineris (#vz-grid-fx) var jau eksistēt HTML (kā DIV)
    let overlay = document.getElementById(OVERLAY_ID);

    // 2) Ja overlay ir vecais CANVAS (legacy), pārvēršam uz DIV + ieliekam CANVAS iekšā
    if (overlay && overlay.tagName === "CANVAS") {
      const legacyCanvas = overlay;
      const wrap = document.createElement("div");
      wrap.id = OVERLAY_ID;

      legacyCanvas.id = CANVAS_ID;
      wrap.appendChild(legacyCanvas);

      legacyCanvas.replaceWith(wrap);
      overlay = wrap;
    }

    // 3) Ja overlay vispār nav — izveidojam
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
    }

    // fallback inline (ja CSS nav ielādējies / vai overlay nav pareizi ielikts)
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";

    // 4) Iekšā vajag CANVAS
    let canvas = overlay.querySelector("canvas#" + CANVAS_ID);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = CANVAS_ID;
      overlay.appendChild(canvas);
    }

    // 5) Grid jābūt anchor priekš absolute overlay
    const cs = getComputedStyle(grid);
    if (cs.position === "static") grid.style.position = "relative";

    // 6) Overlay jābūt iekš grid (ja game.js notīra / pārnes)
    if (!grid.contains(overlay)) grid.appendChild(overlay);

    return { overlay, canvas };
  }

  function init(grid) {
    if (grid.dataset.vzGridFxInit === "1") return;

    const isMobile =
      window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
    const lowMem =
      typeof navigator !== "undefined" &&
      navigator.deviceMemory &&
      navigator.deviceMemory <= 4;

    let app = null;

    const { overlay, canvas } = ensureOverlayAndCanvas(grid);

    try {
      app = new PIXI.Application({
        view: canvas,
        backgroundAlpha: 0,
        antialias: false,
        autoDensity: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        powerPreference: "low-power",
      });
    } catch (e) {
      try { delete grid.dataset.vzGridFxInit; } catch (_) {}
      return;
    }

    grid.dataset.vzGridFxInit = "1";

    app.ticker.maxFPS = (isMobile || lowMem) ? 24 : 30;

    const borderLayer = new PIXI.Container();
    borderLayer.blendMode = PIXI.BLEND_MODES.ADD;
    app.stage.addChild(borderLayer);

    const particleLayer = new PIXI.Container();
    particleLayer.blendMode = PIXI.BLEND_MODES.ADD;
    app.stage.addChild(particleLayer);

    const sweep = new PIXI.Graphics();
    sweep.blendMode = PIXI.BLEND_MODES.ADD;
    app.stage.addChild(sweep);

    // “electric sparks”
    const spark = new PIXI.Graphics();
    spark.blendMode = PIXI.BLEND_MODES.ADD;
    app.stage.addChild(spark);

    let borderGfx = [];
    let gridObserver = null;
    let attrObserver = null;
    let ro = null;

    const pool = [];
    const maxParticles = (isMobile || lowMem) ? 16 : 28;

    const lastStatus = new WeakMap(); // el -> "correct"|"present"|"absent"|null

    let layoutRAF = 0;
    const scheduleLayout = () => {
      if (layoutRAF) return;
      layoutRAF = requestAnimationFrame(() => {
        layoutRAF = 0;
        layout();
      });
    };

    function resizeRenderer() {
      const w = Math.round(grid.clientWidth);
      const h = Math.round(grid.clientHeight);
      if (w <= 0 || h <= 0) return;

      app.renderer.resize(w, h);

      // piespiežam izmēru overlay/kanvai (drošībai)
      overlay.style.width = w + "px";
      overlay.style.height = h + "px";
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }

    function getTiles() {
      return Array.from(grid.querySelectorAll(TILE_SEL));
    }

    function ensureMounted() {
      // Ja game.js notīra grid.innerHTML, overlay pazūd.
      if (!grid.contains(overlay)) grid.appendChild(overlay);
      if (!overlay.contains(canvas)) overlay.appendChild(canvas);
    }

    function layout() {
      ensureMounted();
      resizeRenderer();

      const gridRect = grid.getBoundingClientRect();
      const tiles = getTiles();

      borderLayer.removeChildren();
      borderGfx = [];

      tiles.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const x = r.left - gridRect.left;
        const y = r.top - gridRect.top;

        const g = new PIXI.Graphics();
        g._phase = (i % 8) * 0.35 + Math.floor(i / 8) * 0.22;

        // neon outline + inner soft line
        g.lineStyle({ width: 2, color: 0x3f51ff, alpha: 0.55 });
        g.drawRoundedRect(x + 1, y + 1, r.width - 2, r.height - 2, 6);

        g.lineStyle({ width: 1, color: 0x00b0ff, alpha: 0.22 });
        g.drawRoundedRect(x + 4, y + 4, r.width - 8, r.height - 8, 5);

        borderLayer.addChild(g);
        borderGfx.push(g);
      });
    }

    function spawnBurst(x, y, color, count) {
      const n = count || ((isMobile || lowMem) ? 6 : 10);

      for (let i = 0; i < n; i++) {
        let p = pool.pop();
        if (!p) {
          p = new PIXI.Sprite(PIXI.Texture.WHITE);
          p.anchor.set(0.5);
        }

        p.tint = color;
        p.alpha = 0.95;
        p.x = x;
        p.y = y;

        const a = Math.random() * Math.PI * 2;
        const sp = (isMobile || lowMem ? 70 : 110) * (0.6 + Math.random() * 1.2);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;

        p.life = 0.22 + Math.random() * 0.18;
        p.age = 0;

        const s = (isMobile || lowMem ? 1.6 : 2.2) + Math.random() * 2.5;
        p.width = s;
        p.height = s;

        particleLayer.addChild(p);
      }

      while (particleLayer.children.length > maxParticles) {
        const c = particleLayer.children[0];
        particleLayer.removeChild(c);
        pool.push(c);
      }
    }

    function pulseTile(el, type) {
      const gridRect = grid.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const cx = (r.left - gridRect.left) + r.width / 2;
      const cy = (r.top - gridRect.top) + r.height / 2;

      let color = 0x3f51ff;
      if (type === "correct") color = 0x00ff7f;
      else if (type === "present") color = 0xffd54f;
      else if (type === "absent") color = 0x5a5d7a;

      spawnBurst(cx, cy, color);
    }

    function getStatusFromClass(cls) {
      if (!cls) return null;
      if (cls.includes("correct")) return "correct";
      if (cls.includes("present")) return "present";
      if (cls.includes("absent")) return "absent";
      return null;
    }

    function attachAttrObserver() {
      if (attrObserver) attrObserver.disconnect();

      attrObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type !== "attributes" || m.attributeName !== "class") continue;
          const el = m.target;
          if (!(el instanceof Element)) continue;
          if (!el.matches(TILE_SEL)) continue;

          const next = getStatusFromClass(el.className || "");
          const prev = lastStatus.get(el) || null;

          if (next && next !== prev) pulseTile(el, next);

          lastStatus.set(el, next);
        }
      });

      attrObserver.observe(grid, { subtree: true, attributes: true, attributeFilter: ["class"] });
    }

    function attachGridObserver() {
      if (gridObserver) gridObserver.disconnect();

      let t = null;
      gridObserver = new MutationObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          ensureMounted();
          scheduleLayout();
        }, 40);
      });

      gridObserver.observe(grid, { childList: true, subtree: true });
    }

    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => scheduleLayout());
      ro.observe(grid);
    }
    window.addEventListener("resize", scheduleLayout, { passive: true });

    layout();
    attachAttrObserver();
    attachGridObserver();

    let sweepPos = -120;

    // spark timer
    let sparkT = 0;
    let sparkHold = 0;

    function drawSpark(w, h) {
      // neliels “zibšņa” segments (retāk mobilajā)
      const lines = (isMobile || lowMem) ? 1 : 2;
      const alpha = (isMobile || lowMem) ? 0.22 : 0.30;

      spark.clear();
      for (let k = 0; k < lines; k++) {
        const y = 8 + Math.random() * (h - 16);
        const x0 = -30 + Math.random() * (w + 60);
        const len = 80 + Math.random() * 140;

        spark.lineStyle(2, 0x66ccff, alpha);
        spark.moveTo(x0, y);

        const steps = 5 + Math.floor(Math.random() * 5);
        for (let i = 1; i <= steps; i++) {
          const px = x0 + (len * i) / steps;
          const py = y + (Math.random() * 18 - 9);
          spark.lineTo(px, py);
        }

        // 2. “core” līnija
        spark.lineStyle(1, 0xff66cc, alpha * 0.65);
        spark.moveTo(x0, y);
        for (let i = 1; i <= steps; i++) {
          const px = x0 + (len * i) / steps;
          const py = y + (Math.random() * 14 - 7);
          spark.lineTo(px, py);
        }
      }
    }

    app.ticker.add(() => {
      const t = app.ticker.lastTime * 0.001;

      for (const g of borderGfx) {
        const a = 0.22 + 0.18 * Math.sin(t * 2.2 + (g._phase || 0));
        g.alpha = a;
      }

      const w = app.renderer.width;
      const h = app.renderer.height;

      sweepPos += (isMobile || lowMem) ? 2.2 : 3.2;
      if (sweepPos > w + 120) sweepPos = -120;

      sweep.clear();
      sweep.beginFill(0x00b0ff, 0.08);
      sweep.drawRoundedRect(sweepPos, -10, 90, h + 20, 18);
      sweep.endFill();

      // “spark” uzliesmojumi (reti)
      const dt = app.ticker.deltaMS / 1000;
      sparkT += dt;

      if (sparkHold > 0) {
        sparkHold -= dt;
        if (sparkHold <= 0) spark.clear();
      } else {
        const interval = (isMobile || lowMem) ? 1.6 : 1.1;
        if (sparkT >= interval + Math.random() * interval) {
          sparkT = 0;
          sparkHold = (isMobile || lowMem) ? 0.10 : 0.14;
          drawSpark(w, h);
        }
      }

      // particles
      for (let i = particleLayer.children.length - 1; i >= 0; i--) {
        const p = particleLayer.children[i];
        p.age += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        const k = 1 - (p.age / p.life);
        p.alpha = Math.max(0, k);

        if (p.age >= p.life) {
          particleLayer.removeChild(p);
          pool.push(p);
        }
      }
    });

    const visHandler = () => {
      if (!app) return;
      if (document.hidden) app.ticker.stop();
      else app.ticker.start();
    };
    document.addEventListener("visibilitychange", visHandler);

    function destroy() {
      try {
        window.removeEventListener("resize", scheduleLayout);
        document.removeEventListener("visibilitychange", visHandler);
        if (ro) ro.disconnect();
        if (attrObserver) attrObserver.disconnect();
        if (gridObserver) gridObserver.disconnect();
        if (layoutRAF) cancelAnimationFrame(layoutRAF);

        if (app) {
          app.ticker.stop();
          app.destroy(true);
        }
      } catch (_) {}

      try { delete grid.dataset.vzGridFxInit; } catch (_) {}
    }

    window.vzGridFx = { pulseTile, destroy, app };

    // Papildus drošība: ja game.js nomaina grid, “boot” to atkal pacels
    setTimeout(() => boot(0), 0);
  }
})();
