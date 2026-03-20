(function (global) {
  "use strict";

  function createApiBase() {
    try {
      const forced = String(localStorage.getItem("vz_api_base") || "").trim();
      if (forced) return forced.replace(/\/+$/, "");
    } catch {}
    const host = String(window.location.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return String(window.location.origin || "").replace(/\/+$/, "");
    }
    return "https://bugats-wordle-server.onrender.com";
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("Tīkls neatbildēja laikā. Pamēģini vēlreiz.");
      }
      throw new Error(
        "Neizdevās pieslēgties serverim. Pārbaudi internetu un mēģini vēlreiz."
      );
    } finally {
      clearTimeout(t);
    }
  }

  async function readJsonOrThrow(response) {
    const txt = await response.text();

    if (!txt) {
      if (!response.ok)
        throw new Error("Servera kļūda (" + response.status + ").");
      return {};
    }

    let data = null;
    try {
      data = JSON.parse(txt);
    } catch {
      console.error("Non-JSON response:", txt);
      throw new Error("Servera kļūda (nav korekts JSON).");
    }

    if (!response.ok) {
      const err = new Error(
        (data && data.message) || "Servera kļūda (" + response.status + ")."
      );
      err.status = response.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  global.VZServices = Object.freeze({
    createApiBase,
    fetchWithTimeout,
    readJsonOrThrow,
  });
})(window);
