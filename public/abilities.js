"use strict";

// expects global: window.socket (your existing Socket.IO connection)
(function () {
  const sock = window.socket;
  if (!sock) return;

  const el = document.createElement("div");
  el.id = "vzAbilitiesMini";
  el.innerHTML = `
    <div class="vzAbTitle">ABILITIES</div>
    <div class="vzAbBtns">
      <button data-a="reveal" type="button">🔍 REVEAL <span data-x="reveal">0</span></button>
      <button data-a="extraRow" type="button">➕ ROW <span data-x="extraRow">0</span></button>
      <button data-a="freeze" type="button">❄️ FREEZE <span data-x="freeze">0</span></button>
    </div>
    <div class="vzAbMsg" aria-live="polite"></div>
  `;
  document.body.appendChild(el);

  const msg = el.querySelector(".vzAbMsg");
  const setMsg = (t) => { msg.textContent = String(t || ""); };

  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-a]");
    if (!b) return;
    const type = b.getAttribute("data-a");
    sock.emit("ability:use", { type });
  });

  sock.on("abilities:state", (p) => {
    const ch = (p && p.charges) || {};
    ["reveal", "extraRow", "freeze"].forEach((k) => {
      const s = el.querySelector(`[data-x="${k}"]`);
      if (s) s.textContent = String(ch[k] ?? 0);
    });
  });

  sock.on("ability:reveal", (p) => {
    if (!p) return;
    setMsg(`Reveal: ${Number(p.index) + 1}. burts = ${p.letter}`);
    setTimeout(() => setMsg(""), 2500);
  });

  sock.on("ability:extraRow", (p) => {
    setMsg(`+1 row (tagad max: ${p?.maxAttempts})`);
    setTimeout(() => setMsg(""), 2500);
  });

  sock.on("ability:freeze", (p) => {
    if (!p) return;
    setMsg(`FREEZE by ${p.by} (${p.seconds}s)`);
    setTimeout(() => setMsg(""), 2500);
  });

  sock.on("ability:reject", (p) => setMsg(p?.msg || "Ability reject"));
})();
