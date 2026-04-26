/**
 * NHL izlozei — komandu «cepures» ar oficiālajiem logo (nhle assets).
 * Lasa window.VZNhlGiveaway no game.js.
 */
(function (w) {
  /** PAŠREIZĒJĀS 32 NHL komandas (saīsinājumi pēc nhle.com) */
  const TEAMS = [
    { abbr: "ANA", name: "Ducks" },
    { abbr: "BOS", name: "Bruins" },
    { abbr: "BUF", name: "Sabres" },
    { abbr: "CAR", name: "Hurricanes" },
    { abbr: "CBJ", name: "Blue Jackets" },
    { abbr: "CGY", name: "Flames" },
    { abbr: "CHI", name: "Blackhawks" },
    { abbr: "COL", name: "Avalanche" },
    { abbr: "DAL", name: "Stars" },
    { abbr: "DET", name: "Red Wings" },
    { abbr: "EDM", name: "Oilers" },
    { abbr: "FLA", name: "Panthers" },
    { abbr: "LAK", name: "Kings" },
    { abbr: "MIN", name: "Wild" },
    { abbr: "MTL", name: "Canadiens" },
    { abbr: "NSH", name: "Predators" },
    { abbr: "NJD", name: "Devils" },
    { abbr: "NYI", name: "Islanders" },
    { abbr: "NYR", name: "Rangers" },
    { abbr: "OTT", name: "Senators" },
    { abbr: "PHI", name: "Flyers" },
    { abbr: "PIT", name: "Penguins" },
    { abbr: "SEA", name: "Kraken" },
    { abbr: "SJS", name: "Sharks" },
    { abbr: "STL", name: "Blues" },
    { abbr: "TBL", name: "Lightning" },
    { abbr: "TOR", name: "Maple Leafs" },
    { abbr: "UTA", name: "Utah" },
    { abbr: "VAN", name: "Canucks" },
    { abbr: "VGK", name: "Golden Knights" },
    { abbr: "WPG", name: "Jets" },
    { abbr: "WSH", name: "Capitals" },
  ];

  function logoDarkUrl(abbr) {
    const a = String(abbr || "").trim().toUpperCase();
    return `https://assets.nhle.com/logos/nhl/svg/${a}_dark.svg`;
  }

  /**
   * @param {HTMLElement} container
   * @param {{ selectedAbbr?: string; onPick?: (abbr: string) => void }} opts
   */
  function renderHatPicker(container, opts) {
    if (!container) return;
    const selected = String(opts?.selectedAbbr || "").trim().toUpperCase();
    const onPick = typeof opts?.onPick === "function" ? opts.onPick : () => {};
    container.innerHTML = "";
    container.classList.add("vz-nhl-hat-grid");

    for (const t of TEAMS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vz-nhl-hat-btn";
      btn.dataset.abbr = t.abbr;
      btn.setAttribute(
        "aria-label",
        `${t.abbr} — ${t.name}`
      );
      btn.title = `${t.abbr} · ${t.name}`;
      if (t.abbr === selected) btn.classList.add("vz-nhl-hat-btn--selected");

      const cap = document.createElement("span");
      cap.className = "vz-nhl-hat-cap";
      cap.setAttribute("aria-hidden", "true");

      const img = document.createElement("img");
      img.className = "vz-nhl-hat-logo";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = logoDarkUrl(t.abbr);
      img.addEventListener("error", () => {
        img.remove();
        cap.textContent = t.abbr;
        cap.classList.add("vz-nhl-hat-cap--fallback");
      });

      cap.appendChild(img);
      btn.appendChild(cap);

      btn.addEventListener("click", () => {
        container.querySelectorAll(".vz-nhl-hat-btn").forEach((b) => {
          b.classList.toggle(
            "vz-nhl-hat-btn--selected",
            b.dataset.abbr === t.abbr
          );
        });
        onPick(t.abbr);
      });
      container.appendChild(btn);
    }
  }

  w.VZNhlGiveaway = { TEAMS, logoDarkUrl, renderHatPicker };
})(window);
