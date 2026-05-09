import fs from "fs";
import path from "path";
import { saveJsonAtomic } from "./lib/atomic-json.js";

const USERS_FILE =
  process.env.USERS_FILE || path.join(process.cwd(), "users.json");

const ADD_COINS = Number(process.env.ADD_COINS || 500);
const ADD_TOKENS = Number(process.env.ADD_TOKENS || 5);

const raw = fs.readFileSync(USERS_FILE, "utf8");
const data = JSON.parse(raw);
const arr = Array.isArray(data) ? data : Object.values(data || {});

for (const u of arr) {
  if (!u || !u.username) continue;
  u.coins = (u.coins || 0) + ADD_COINS;
  u.tokens = (u.tokens || 0) + ADD_TOKENS;
}

saveJsonAtomic(USERS_FILE, arr);

console.log(
  `OK: +${ADD_COINS} coins, +${ADD_TOKENS} tokens visiem (${arr.length} useri).`
);
