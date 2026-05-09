(function (global) {
  "use strict";

  function $(selector) {
    return document.querySelector(selector);
  }

  function createEl(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  function safeText(el, txt) {
    if (!el) return;
    el.textContent = String(txt ?? "");
  }

  function applyRankColor(el, color) {
    if (!el) return;
    const c = typeof color === "string" ? color.trim() : "";
    el.style.color = c || "";
  }

  global.VZUI = Object.freeze({
    $,
    applyRankColor,
    createEl,
    safeText,
  });
})(window);
