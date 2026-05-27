// auth.js — VĀRDU ZONA autentifikācija (signup / login)

const API_BASE = "https://bugats-wordle-server.onrender.com";

const signupForm = document.getElementById("signup-form");
const loginForm = document.getElementById("login-form");
const authErrorEl = document.getElementById("auth-error");
const tabLoginBtn = document.getElementById("auth-tab-login");
const tabSignupBtn = document.getElementById("auth-tab-signup");
const loginPanel = document.getElementById("auth-panel-login");
const signupPanel = document.getElementById("auth-panel-signup");

// Mazs helperis kļūdas rādīšanai
function showAuthError(msg) {
  if (!authErrorEl) return;
  authErrorEl.textContent = msg || "";
}

function setAuthTab(tab) {
  const isLogin = tab !== "signup";
  if (loginPanel) {
    loginPanel.hidden = !isLogin;
    loginPanel.classList.toggle("is-active", isLogin);
  }
  if (signupPanel) {
    signupPanel.hidden = isLogin;
    signupPanel.classList.toggle("is-active", !isLogin);
  }
  if (tabLoginBtn) {
    tabLoginBtn.classList.toggle("is-active", isLogin);
    tabLoginBtn.setAttribute("aria-selected", String(isLogin));
  }
  if (tabSignupBtn) {
    tabSignupBtn.classList.toggle("is-active", !isLogin);
    tabSignupBtn.setAttribute("aria-selected", String(!isLogin));
  }
  showAuthError("");
}

if (tabLoginBtn) {
  tabLoginBtn.addEventListener("click", () => setAuthTab("login"));
}
if (tabSignupBtn) {
  tabSignupBtn.addEventListener("click", () => setAuthTab("signup"));
}
setAuthTab(window.location.hash === "#signup" ? "signup" : "login");

try {
  const n = sessionStorage.getItem("vz_auth_notice");
  if (n && String(n).trim()) {
    showAuthError(String(n).trim());
    sessionStorage.removeItem("vz_auth_notice");
  }
} catch {}

// Referrāla kods no URL (?ref=Username)
function getReferralFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref")?.trim();
    return ref && ref.length >= 3 ? ref : "";
  } catch {
    return "";
  }
}

// Referrāla ziņojums, ja ?ref= ir URL
function updateReferralNote() {
  const ref = getReferralFromUrl();
  const el = document.getElementById("signup-referral-note");
  if (!el) return;
  if (ref) {
    el.textContent = `🎁 Tevi uzaicinājis ${ref}! Reģistrējoties, abi saņemsit bonusu (+50 un +25 coins).`;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}
updateReferralNote();

function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem("vz_device_id");
    if (id && String(id).trim()) return String(id).trim();
    id = crypto?.randomUUID
      ? crypto.randomUUID()
      : "vz_" + Math.random().toString(16).slice(2) + Date.now();
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
  } catch {
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
    setAuthTab("signup");
    showAuthError("");

    const username = document.getElementById("signup-username").value.trim();
    const email = document.getElementById("signup-email")?.value?.trim() || "";
    const password = document.getElementById("signup-password").value.trim();
    const region =
      document.getElementById("signup-region")?.value?.trim() || "";
    const referredBy = getReferralFromUrl();

    if (!username || !password) {
      showAuthError("Aizpildi lietotājvārdu un paroli.");
      return;
    }
    if (!email) {
      showAuthError("E-pasts ir obligāts reģistrācijai.");
      return;
    }
    if (!region) {
      showAuthError("Izvēlies novadu.");
      return;
    }
    const ageOk = document.getElementById("signup-age-18")?.checked;
    if (!ageOk) {
      showAuthError("Jāapstiprina, ka tev ir vismaz 18 gadu.");
      return;
    }

    const payload = {
      username,
      email,
      password,
      region,
      ageConfirmed: true,
      deviceId: getOrCreateDeviceId(),
    };
    if (referredBy) payload.referredBy = referredBy;

    try {
      const data = await apiPost("/signup", payload);
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
    setAuthTab("login");
    showAuthError("");

    const identifier = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value.trim();

    if (!identifier || !password) {
      showAuthError("Aizpildi lietotājvārdu vai e-pastu un paroli.");
      return;
    }

    try {
      const data = await apiPost("/login", {
        username: identifier,
        password,
        deviceId: getOrCreateDeviceId(),
      });
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
  const legacyUser = localStorage.getItem("varduZonaUser");

  const newToken = localStorage.getItem("vz_token");
  const newUser = localStorage.getItem("vz_username");

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
