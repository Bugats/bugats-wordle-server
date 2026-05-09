(function (global) {
  "use strict";

  function dmStorageKey(username) {
    const u = String(username || "").trim() || "unknown";
    return "vz_dm_store_" + u;
  }

  function dmSanitizeMeta(meta) {
    if (!meta || typeof meta !== "object") return null;
    const out = { ...meta };
    if (out.avatarUrl && String(out.avatarUrl).startsWith("data:image/")) {
      if (String(out.avatarUrl).length > 120000) delete out.avatarUrl;
    }
    return out;
  }

  function dmNormalizeMessageForStore(msg) {
    if (!msg || typeof msg !== "object") return null;
    const out = {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      text: msg.text || "",
      ts: Number(msg.ts) || 0,
    };
    if (msg.reply && typeof msg.reply === "object") {
      const r = {
        id: msg.reply.id,
        from: msg.reply.from,
        text: msg.reply.text,
      };
      if (r.id && r.from && r.text) out.reply = r;
    }
    if (msg.edited) out.edited = true;
    if (msg.editedAt) out.editedAt = Number(msg.editedAt) || 0;
    if (msg.deleted) out.deleted = true;
    if (msg.deletedAt) out.deletedAt = Number(msg.deletedAt) || 0;
    const meta = dmSanitizeMeta(msg.meta);
    if (meta) out.meta = meta;
    return out;
  }

  function dmThreadsToObject(dmThreads, maxPerThread = 200) {
    const out = {};
    if (!(dmThreads instanceof Map)) return out;
    for (const [k, arr] of dmThreads.entries()) {
      const key = String(k || "").trim();
      if (!key) continue;
      const list = Array.isArray(arr) ? arr.slice(-Math.max(1, maxPerThread)) : [];
      out[key] = list.map(dmNormalizeMessageForStore).filter(Boolean);
    }
    return out;
  }

  function dmObjectToThreads(obj) {
    const map = new Map();
    for (const [k, arr] of Object.entries(obj || {})) {
      if (!Array.isArray(arr)) continue;
      map.set(k, arr.map(dmNormalizeMessageForStore).filter(Boolean));
    }
    return map;
  }

  global.VZChat = Object.freeze({
    dmNormalizeMessageForStore,
    dmObjectToThreads,
    dmSanitizeMeta,
    dmStorageKey,
    dmThreadsToObject,
  });
})(window);
