const SERVER_URL = "https://bugats-wordle-server.onrender.com";
const TOKEN_KEY = "varduzona_token";

const authContainer = document.getElementById("auth-container");
const loginBox = document.getElementById("login-box");
const signupBox = document.getElementById("signup-box");
const gameContainer = document.getElementById("game-container");
const toastEl = document.getElementById("toast");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2500);
}

document.getElementById("go-signup").onclick = () => {
  loginBox.style.display = "none";
  signupBox.style.display = "block";
};
document.getElementById("go-login").onclick = () => {
  signupBox.style.display = "none";
  loginBox.style.display = "block";
};

document.getElementById("login-btn").onclick = async () => {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value.trim();
  if (!username || !password) return showToast("Ievadi niku un paroli");

  try {
    const res = await fetch(`${SERVER_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!data.ok) return showToast(data.message || "Kļūda pieslēdzoties");

    localStorage.setItem(TOKEN_KEY, data.token);
    showToast("Laipni atgriezies, " + data.username);
    loadGame();
  } catch (err) {
    console.error(err);
    showToast("Servera kļūda");
  }
};

document.getElementById("signup-btn").onclick = async () => {
  const username = document.getElementById("signup-username").value.trim();
  const password = document.getElementById("signup-password").value.trim();
  const confirmPassword = document.getElementById("signup-confirm").value.trim();

  if (!username || !password || !confirmPassword)
    return showToast("Aizpildi visus laukus");

  try {
    const res = await fetch(`${SERVER_URL}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, confirmPassword }),
    });
    const data = await res.json();
    if (!data.ok) return showToast(data.message || "Kļūda reģistrējoties");

    showToast("Reģistrācija veiksmīga. Tagad pieslēdzies.");
    signupBox.style.display = "none";
    loginBox.style.display = "block";
  } catch (err) {
    console.error(err);
    showToast("Servera kļūda");
  }
};

function tryAutoLogin() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    loadGame();
  } else {
    authContainer.style.display = "flex";
  }
}

function loadGame() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return showToast("Nepieciešama autorizācija");

  authContainer.style.display = "none";
  gameContainer.style.display = "block";

  const frame = document.getElementById("game-frame");
  frame.src = "game.html?token=" + encodeURIComponent(token);
}

document.addEventListener("DOMContentLoaded", tryAutoLogin);
