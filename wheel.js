// wheel.js (ESM) — VĀRDU ZONA wheel module
import fs from "fs";
import path from "path";
import crypto from "crypto";
import jwt from "jsonwebtoken";

const fsp = fs.promises;

function now() {
  return Date.now();
}

function safeName(v) {
  let s = String(v ?? "").trim();
  s = s.replace(/\s+/g, " ");
  // atļaujam burtus, ciparus, atstarpes, _ . -
  s = s.replace(/[^\p{L}\p{N} _.\-]/gu, "");
  return s.slice(0, 22);
}

function makeDefaultState() {
  return {
    version: 1,
    slots: [], // array of strings (username)
    settings: { spinMs: 9000, removeOnWin: true },
    lastSpin: null,
    updatedAt: 0,
  };
}

export function initWheel({
  app,
  io,
  jwtSecret,
  adminUsernames = ["Bugats", "BugatsLV"],
  dataDir = process.env.DATA_DIR || process.cwd(),
  fileName = "wheel.json",
}) {
  const WHEEL_PATH = path.join(dataDir, fileName);

  let state = makeDefaultState();

  // async save queue (lai nesalauž paralēli rakstot)
  let saving = Promise.resolve();

  async function load() {
    try {
      const raw = await fsp.readFile(WHEEL_PATH, "utf8");
      const parsed = JSON.parse(raw);
      state = { ...makeDefaultState(), ...parsed };
      if (!Array.isArray(state.slots)) state.slots = [];
      if (!state.settings) state.settings = { spinMs: 9000, removeOnWin: true };
      if (typeof state.settings.spinMs !== "number") state.settings.spinMs = 9000;
      if (typeof state.settings.removeOnWin !== "boolean") state.settings.removeOnWin = true;
    } catch {
      // ja nav faila — izveidojam
      await save();
    }
  }

  async function save() {
    state.updatedAt = now();
    const payload = JSON.stringify(state, null, 2);
    saving = saving
      .then(() => fsp.mkdir(path.dirname(WHEEL_PATH), { recursive: true }))
      .then(() => fsp.writeFile(WHEEL_PATH, payload, "utf8"))
      .catch(() => {});
    return saving;
  }

  function isAdminUsername(u) {
    return adminUsernames.includes(String(u || ""));
  }

  function getUserFromAuthHeader(req) {
    try {
      const h = String(req.headers.authorization || "");
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (!m) return null;
      const token = m[1];
      const decoded = jwt.verify(token, jwtSecret);
      return decoded?.username ? String(decoded.username) : null;
    } catch {
      return null;
    }
  }

  function getUserFromToken(token) {
    try {
      const decoded = jwt.verify(String(token || ""), jwtSecret);
      return decoded?.username ? String(decoded.username) : null;
    } catch {
      return null;
    }
  }

  function publicState() {
    return {
      slots: state.slots,
      slotsCount: state.slots.length,
      settings: state.settings,
      lastSpin: state.lastSpin,
      updatedAt: state.updatedAt,
    };
  }

  async function broadcastUpdate() {
    io.emit("wheel:update", publicState());
  }

  async function addSlots(name, count = 1) {
    const n = safeName(name);
    const c = Math.max(1, Math.min(1000, Number(count) || 1));
    if (!n) return { ok: false, error: "bad_name" };

    for (let i = 0; i < c; i++) state.slots.push(n);

    await save();
    await broadcastUpdate();
    return { ok: true, added: c, name: n, slotsCount: state.slots.length };
  }

  async function removeByName(name) {
    const n = safeName(name);
    if (!n) return { ok: false, error: "bad_name" };
    const before = state.slots.length;
    state.slots = state.slots.filter((x) => x !== n);
    const removed = before - state.slots.length;
    await save();
    await broadcastUpdate();
    return { ok: true, removed, name: n, slotsCount: state.slots.length };
  }

  async function removeByIndex(index) {
    const i = Number(index);
    if (!Number.isFinite(i)) return { ok: false, error: "bad_index" };
    if (i < 0 || i >= state.slots.length) return { ok: false, error: "out_of_range" };
    const name = state.slots[i];
    state.slots.splice(i, 1);
    await save();
    await broadcastUpdate();
    return { ok: true, removed: 1, name, slotsCount: state.slots.length };
  }

  async function shuffle() {
    // Fisher-Yates
    for (let i = state.slots.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [state.slots[i], state.slots[j]] = [state.slots[j], state.slots[i]];
    }
    await save();
    await broadcastUpdate();
    return { ok: true, slotsCount: state.slots.length };
  }

  async function setSettings({ spinMs, removeOnWin } = {}) {
    if (spinMs != null) {
      const v = Math.max(1500, Math.min(60000, Number(spinMs) || 9000));
      state.settings.spinMs = v;
    }
    if (removeOnWin != null) state.settings.removeOnWin = !!removeOnWin;

    await save();
    await broadcastUpdate();
    return { ok: true, settings: state.settings };
  }

  async function spin(byUsername) {
    if (state.slots.length <= 0) return { ok: false, error: "empty" };

    const spinMs = state.settings.spinMs || 9000;
    const winnerIndex = crypto.randomInt(0, state.slots.length);
    const winnerName = state.slots[winnerIndex];

    const snapCount = state.slots.length;

    // broadcast “spin” start so skatītāji redz animāciju
    io.emit("wheel:spin", {
      winnerIndex,
      winnerName,
      slotsCount: snapCount,
      spinMs,
      at: now(),
    });

    let removed = false;
    if (state.settings.removeOnWin) {
      state.slots.splice(winnerIndex, 1);
      removed = true;
    }

    state.lastSpin = {
      by: String(byUsername || ""),
      winnerName,
      winnerIndex,
      removed,
      spinMs,
      at: now(),
      beforeCount: snapCount,
      afterCount: state.slots.length,
    };

    await save();
    await broadcastUpdate();

    return { ok: true, ...state.lastSpin };
  }

  // REST (ērti wheel.html initial load / debug)
  app.get("/wheel", async (_req, res) => {
    res.json(publicState());
  });

  // Admin-only REST (optional)
  app.post("/wheel/admin/shuffle", async (req, res) => {
    const u = getUserFromAuthHeader(req);
    if (!u || !isAdminUsername(u)) return res.status(403).json({ ok: false });
    res.json(await shuffle());
  });

  // Socket.IO
  io.on("connection", (socket) => {
    socket.on("wheel:join", () => {
      socket.emit("wheel:update", publicState());
    });

    socket.on("wheel:shuffle", async ({ token } = {}) => {
      const u = getUserFromToken(token);
      if (!u || !isAdminUsername(u)) return;
      await shuffle();
    });

    socket.on("wheel:settings", async ({ token, spinMs, removeOnWin } = {}) => {
      const u = getUserFromToken(token);
      if (!u || !isAdminUsername(u)) return;
      await setSettings({ spinMs, removeOnWin });
    });

    socket.on("wheel:add", async ({ token, name, count } = {}) => {
      const u = getUserFromToken(token);
      if (!u || !isAdminUsername(u)) return;
      await addSlots(name, count);
    });

    socket.on("wheel:remove", async ({ token, name, index } = {}) => {
      const u = getUserFromToken(token);
      if (!u || !isAdminUsername(u)) return;

      if (name) await removeByName(name);
      else if (index != null) await removeByIndex(index);
    });

    socket.on("wheel:spin", async ({ token } = {}) => {
      const u = getUserFromToken(token);
      if (!u || !isAdminUsername(u)) return;
      await spin(u);
    });
  });

  // init
  load().then(broadcastUpdate).catch(() => {});

  return {
    getState: () => state,
    getPublicState: publicState,
    addSlots,
    removeByName,
    removeByIndex,
    shuffle,
    setSettings,
    spin,
  };
}

