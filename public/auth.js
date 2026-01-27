// auth.js — VĀRDU ZONA autentifikācija (signup / login)

const API_BASE = "https://bugats-wordle-server.onrender.com";

const signupForm  = document.getElementById("signup-form");
const loginForm   = document.getElementById("login-form");
const authErrorEl = document.getElementById("auth-error");

// Mazs helperis kļūdas rādīšanai
function showAuthError(msg) {
  if (!authErrorEl) return;
  authErrorEl.textContent = msg || "";
}
function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem("vz_device_id");
    if (id && String(id).trim()) return String(id).trim();
    id = (crypto?.randomUUID
      ? crypto.randomUUID()
      : ("vz_" + Math.random().toString(16).slice(2) + Date.now()));
    localStorage.setItem("vz_device_id", id);
    return id;
  } catch {
    return "";
  }
}
// POST helperis
async function apiPost(path, payload) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error("Non-JSON response:", text);
    throw new Error("Servera kļūda (nav korekts JSON).");
  }

  if (!res.ok) {
    throw new Error(data.message || "Servera kļūda (" + res.status + ").");
  }

  return data;
}

// Pēc veiksmīgas autentifikācijas
function handleAuthSuccess(data) {
  if (!data || !data.token || !data.username) {
    console.error("Neparasta /login atbilde:", data);
    showAuthError("Servera atbilde nav korekta.");
    return;
  }

  // JAUNIE key, ko izmanto game.js
  localStorage.setItem("vz_token", data.token);
  localStorage.setItem("vz_username", data.username);

  // drošības pēc – izmetam vecos key, lai neradās bardaks
  localStorage.removeItem("varduZonaToken");
  localStorage.removeItem("varduZonaUser");

  // Aiziet uz spēli
  window.location.href = "game.html";
}

// ===== Reģistrācija =====
if (signupForm) {
  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAuthError("");

    const username = document
      .getElementById("signup-username")
      .value.trim();
    const password = document
      .getElementById("signup-password")
      .value.trim();
    const region = document.getElementById("signup-region")?.value?.trim() || "";

    if (!username || !password) {
      showAuthError("Aizpildi lietotājvārdu un paroli.");
      return;
    }
    if (!region) {
      showAuthError("Izvēlies novadu.");
      return;
    }

    try {
     const data = await apiPost("/signup", { username, password, region, deviceId: getOrCreateDeviceId() });
      // uzreiz ielogojam un metam uz spēli
      handleAuthSuccess(data);
    } catch (err) {
      console.error("Signup error:", err);
      showAuthError(err.message || "Reģistrācijas kļūda.");
    }
  });
}

// ===== Pierakstīšanās =====
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAuthError("");

    const username = document
      .getElementById("login-username")
      .value.trim();
    const password = document
      .getElementById("login-password")
      .value.trim();

    if (!username || !password) {
      showAuthError("Aizpildi lietotājvārdu un paroli.");
      return;
    }

    try {
     const data = await apiPost("/login", { username, password, deviceId: getOrCreateDeviceId() });
      handleAuthSuccess(data);
    } catch (err) {
      console.error("Login error:", err);
      showAuthError(err.message || "Pierakstīšanās kļūda.");
    }
  });
}

// Neliela migrācija no vecajiem key -> jaunajiem
function migrateLegacyKeysIfAny() {
  const legacyToken = localStorage.getItem("varduZonaToken");
  const legacyUser  = localStorage.getItem("varduZonaUser");

  const newToken = localStorage.getItem("vz_token");
  const newUser  = localStorage.getItem("vz_username");

  // ja jaunie jau ir, neko nedaram
  if (newToken && newUser) return;

  // ja nav jaunie, bet ir vecie – pārceļam tos
  if (legacyToken && legacyUser) {
    localStorage.setItem("vz_token", legacyToken);
    localStorage.setItem("vz_username", legacyUser);
  }
}

// izsaucam migrāciju, BET vairs neveicam redirect šeit
migrateLegacyKeysIfAny();
