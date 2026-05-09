/**
 * Stripe Checkout — virtuālie coins (nav naudas izmaksas / nav preču piegādes).
 * Konfigurācija: STRIPE_COIN_PACKS_JSON — JSON masīvs ar { id, priceId, coins, label? }.
 */

const DEFAULT_PACKS = [
  { id: "coins_500", priceId: "", coins: 500, label: "500 coins" },
  { id: "coins_1200", priceId: "", coins: 1200, label: "1200 coins" },
  { id: "coins_3000", priceId: "", coins: 3000, label: "3000 coins" },
];

function parseCoinPacksFromEnv() {
  const raw = String(process.env.STRIPE_COIN_PACKS_JSON || "").trim();
  if (!raw) return DEFAULT_PACKS.map((p) => ({ ...p }));
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return [];
    return arr
      .map((row) => ({
        id: String(row.id || "").trim(),
        priceId: String(row.priceId || row.price_id || "").trim(),
        coins: Math.max(0, Math.floor(Number(row.coins) || 0)),
        label: String(row.label || "").trim() || undefined,
      }))
      .filter((p) => p.id && p.priceId && p.coins > 0);
  } catch {
    return [];
  }
}

let cachedPacks = null;
let cachedAt = 0;
const PACK_CACHE_MS = 60_000;

/** Vitest: atsvaidzina ENV lasījumu */
export function __resetCoinPacksCacheForTest() {
  cachedPacks = null;
  cachedAt = 0;
}

export function getStripeCoinPacksConfig() {
  const now = Date.now();
  if (cachedPacks && now - cachedAt < PACK_CACHE_MS) return cachedPacks;
  cachedPacks = parseCoinPacksFromEnv();
  cachedAt = now;
  return cachedPacks;
}

export function isStripeCoinsConfigured() {
  const sk = String(process.env.STRIPE_SECRET_KEY || "").trim();
  const wh = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  const packs = getStripeCoinPacksConfig();
  return !!(sk && wh && packs.length > 0);
}

/** Klientam — bez price ID validācijas */
export function getCoinPacksPublicList() {
  return getStripeCoinPacksConfig().map((p) => ({
    id: p.id,
    coins: p.coins,
    label: p.label || `${p.coins} coins`,
  }));
}

export function findPackById(packId) {
  const id = String(packId || "").trim();
  if (!id) return null;
  return getStripeCoinPacksConfig().find((p) => p.id === id) || null;
}

/**
 * Pēc apmaksas — idempotenti pieskaita coins (bez save — caller saglabā).
 * @returns {{ ok: boolean, already?: boolean, error?: string, coinsAdded?: number }}
 */
export function grantCoinsForCheckoutSession(user, session) {
  if (!user || !session) return { ok: false, error: "missing" };
  const sessionId = session.id;
  if (!sessionId) return { ok: false, error: "no_session_id" };

  const meta = session.metadata || {};
  const uname = String(meta.username || "").trim();
  const packId = String(meta.packId || "").trim();
  const coinsRaw = meta.coins != null ? String(meta.coins) : "";
  const coins = Math.max(0, Math.floor(Number(coinsRaw) || 0));

  if (!uname || user.username !== uname) {
    return { ok: false, error: "user_mismatch" };
  }
  const pack = findPackById(packId);
  if (!pack || coins !== pack.coins) {
    return { ok: false, error: "invalid_pack" };
  }

  if (session.payment_status !== "paid") {
    return { ok: false, error: "not_paid" };
  }

  user.stripeSessionsProcessed = user.stripeSessionsProcessed || [];
  const seen = user.stripeSessionsProcessed;
  if (seen.includes(sessionId)) {
    return { ok: true, already: true, coinsAdded: 0 };
  }
  seen.push(sessionId);
  if (seen.length > 500) {
    user.stripeSessionsProcessed = seen.slice(-400);
  }

  user.coins = Math.max(0, Math.floor(Number(user.coins) || 0)) + coins;
  user.stripeLastPurchaseAt = Date.now();
  return { ok: true, coinsAdded: coins };
}
