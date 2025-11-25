// ================= Helperi =================
function $(sel) { return document.querySelector(sel); }
function createEl(tag, cls) { const el = document.createElement(tag); if(cls) el.className = cls; return el; }
function escapeHtml(str) { return str.replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s])); }


// ================= Client state =================
const state = {
    rows: 6,
    cols: 5,
    currentRow: 0,
    currentCol: 0,
    roundId: null,
    isLocked: false,
    isRoundOver: false,
    gridTiles: [],
    gridLetters: [],
    keyboardButtons: new Map(),
    shiftOn: false,

    xp: 0,
    rank: "-",
    streak: 0,
    coins: 0,
    tokens: 0,

    lastGuessTime: 0
};


// ================= JWT =================
function needAuth() {
    const token = localStorage.getItem("varduZonaToken");
    const nick  = localStorage.getItem("varduZonaNick");

    if (!token || !nick) {
        alert("Lūdzu pieslēdzies!");
        location.href = "index.html";
        return null;
    }
    return { token, nick };
}

const auth = needAuth();
if (!auth) throw new Error("NAV AUTH");


// ================= Socket.IO =================
const socket = io("https://bugats-wordle-server.onrender.com", {
    transports: ["websocket"],
    auth: { token: auth.token }
});


// ================= DOM refs =================
const gridEl = $("#grid");
const keyboardEl = $("#keyboard");

const statsRankEl  = $("#stat-rank");
const statsXP      = $("#stat-xp");
const statsStreak  = $("#stat-streak");
const statsCoins   = $("#stat-coins");
const statsTokens  = $("#stat-tokens");

const chatBox = $("#chat-box");
const chatInput = $("#chat-input");
const onlineEl = $("#online-count");


// ================= Skaņas =================
const sndFlip = new Audio("sounds/flip.mp3");
const sndPop  = new Audio("sounds/pop.mp3");
const sndWin  = new Audio("sounds/win.mp3");
const sndKey  = new Audio("sounds/key.mp3");

const bgMusic = new Audio("sounds/bg.mp3");
bgMusic.loop = true;
bgMusic.volume = 0.25;
bgMusic.play().catch(()=>{});


// ================= Confetti =================
function spawnConfetti() {
    for (let i = 0; i < 40; i++) {
        const c = createEl("div","confetti");
        c.style.left = Math.random()*100+"%";
        c.style.backgroundColor = `hsl(${Math.random()*360},100%,60%)`;
        document.body.appendChild(c);
        setTimeout(()=>c.remove(),1500);
    }
}


// ================= GRID =================
function buildGrid() {
    gridEl.innerHTML = "";
    gridEl.style.setProperty("--cols", state.cols);

    state.gridTiles = [];
    state.gridLetters = [];

    for (let r = 0; r < state.rows; r++) {
        const rowTiles = [];
        const rowLetters = [];

        for (let c = 0; c < state.cols; c++) {
            const tile = createEl("div", "tile");
            tile.dataset.row = r;
            tile.dataset.col = c;
            gridEl.appendChild(tile);

            rowTiles.push(tile);
            rowLetters.push("");
        }
        state.gridTiles.push(rowTiles);
        state.gridLetters.push(rowLetters);
    }
}


// ================== Keyboard ==================
const KEYS = {
    normal: [
        ["q","w","e","r","t","y","u","i","o","p"],
        ["a","s","d","f","g","h","j","k","l","ņ"],
        ["z","č","ž","c","v","b","n","m","ē","ū"],
    ],
    shift: [
        ["ā","ē","ī","ū","š","ž","č","ņ","ļ","ķ"],
        ["â","ê","î","ô","û","ģ","ŗ","ö","ā","ē"],
        ["á","é","í","ó","ú","ä","ë","ï","ö","ü"]
    ]
};

function buildKeyboard() {
    keyboardEl.innerHTML = "";
    state.keyboardButtons.clear();

    const mode = state.shiftOn ? KEYS.shift : KEYS.normal;

    mode.forEach(row => {
        const rowDiv = createEl("div", "kb-row");
        row.forEach(key => {
            const btn = createEl("button", "kb-key");
            btn.textContent = key;
            btn.dataset.key = key;
            btn.onclick = () => handleKey(key);
            state.keyboardButtons.set(key, btn);
            rowDiv.appendChild(btn);
        });
        keyboardEl.appendChild(rowDiv);
    });

    // SHIFT
    const rowShift = createEl("div", "kb-row");
    const shiftBtn = createEl("button", "kb-key");
    shiftBtn.textContent = "↑";
    shiftBtn.classList.toggle("shift-on", state.shiftOn);
    shiftBtn.onclick = () => {
        state.shiftOn = !state.shiftOn;
        buildKeyboard();
    };
    rowShift.appendChild(shiftBtn);

    // ENTER
    const enterBtn = createEl("button", "kb-key");
    enterBtn.textContent = "Ievadīt";
    enterBtn.onclick = () => submitWord();
    rowShift.appendChild(enterBtn);

    // DELETE
    const delBtn = createEl("button", "kb-key");
    delBtn.textContent = "Dzēst";
    delBtn.onclick = () => deleteLetter();
    rowShift.appendChild(delBtn);

    keyboardEl.appendChild(rowShift);
}


// ===================== Letter Handling =====================
function handleKey(k) {
    if (state.isLocked || state.isRoundOver) return;

    sndKey.currentTime = 0;
    sndKey.play();

    if (k === "Ievadīt") return submitWord();
    if (k === "Dzēst") return deleteLetter();

    addLetter(k);
}

function addLetter(ch) {
    if (state.currentCol >= state.cols) return;

    state.gridLetters[state.currentRow][state.currentCol] = ch;

    const tile = state.gridTiles[state.currentRow][state.currentCol];
    tile.textContent = ch;
    tile.classList.add("pop");

    sndPop.currentTime = 0;
    sndPop.play();

    state.currentCol++;
}

function deleteLetter() {
    if (state.currentCol === 0) return;

    state.currentCol--;
    state.gridLetters[state.currentRow][state.currentCol] = "";
    state.gridTiles[state.currentRow][state.currentCol].textContent = "";
}


// ===================== Submit guess =====================
function submitWord() {
    const now = Date.now();
    if (now - state.lastGuessTime < 800) return;
    state.lastGuessTime = now;

    if (state.currentCol < state.cols) return;

    const word = state.gridLetters[state.currentRow].join("");
    socket.emit("guess", word);
}


// ===================== Color from server =====================
function applyColorFromServer(word, target) {
    const row = state.currentRow;
    const tiles = state.gridTiles[row];

    for (let i = 0; i < word.length; i++) {
        setTimeout(() => {
            sndFlip.currentTime = 0;
            sndFlip.play();

            tiles[i].classList.add("flip");
            const keyBtn = state.keyboardButtons.get(word[i]);

            if (target[i] === "correct") {
                tiles[i].classList.add("correct");
                if (keyBtn) keyBtn.classList.add("correct");

            } else if (target[i] === "present") {
                tiles[i].classList.add("present");
                if (keyBtn && !keyBtn.classList.contains("correct"))
                    keyBtn.classList.add("present");

            } else {
                tiles[i].classList.add("absent");
                if (keyBtn &&
                    !keyBtn.classList.contains("correct") &&
                    !keyBtn.classList.contains("present"))
                    keyBtn.classList.add("absent");
            }
        }, i * 180);
    }
}


// ===================== SOCKET EVENTS =====================
socket.on("roundStart", data => {
    state.roundId = data.roundId;
    state.cols = data.length;

    document.documentElement.style.setProperty("--cols", state.cols);

    state.currentRow = 0;
    state.currentCol = 0;
    state.isRoundOver = false;

    buildGrid();
    buildKeyboard();
});

socket.on("guess", ({ nick, word, target }) => {
    if (nick === auth.nick) {

        applyColorFromServer(word, target);

        state.currentRow++;
        state.currentCol = 0;
    }
});

socket.on("win", ({ nick, word, rank, xp, coins, tokens }) => {

    if (nick === auth.nick) {
        sndWin.currentTime = 0;
        sndWin.play();
        spawnConfetti();
    }

    if (nick === auth.nick) {
        statsRankEl.textContent = rank;
        statsXP.textContent = xp;
        statsCoins.textContent = coins;
        statsTokens.textContent = tokens;
    }
});

socket.on("chat", ({ nick, msg }) => {
    const div = createEl("div", "chat-msg");
    div.innerHTML = `<b>${escapeHtml(nick)}:</b> ${escapeHtml(msg)}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("online", n => {
    onlineEl.textContent = `Online: ${n}`;
});


// ===================== Chat Input =====================
chatInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && chatInput.value.trim()) {
        socket.emit("chat", chatInput.value.trim());
        chatInput.value = "";
    }
});


// ===================== INIT =====================
buildGrid();
buildKeyboard();
