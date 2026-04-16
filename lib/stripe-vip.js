const DAY_MS = 24 * 60 * 60 * 1000;
const OFFER_CACHE_MS = 60_000;

let cachedOffer = null;
let cachedAt = 0;

function parsePositiveInt(raw, fallback) {
  const n = Math.floor(Number(raw) || 0);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseVipOfferFromEnv() {
  const priceId = String(process.env.STRIPE_VIP_PRICE_ID || "").trim();
  if (!priceId) return null;
  const days = Math.max(
    1,
    Math.min(
      365,
      parsePositiveInt(
        process.env.STRIPE_VIP_DAYS || process.env.VIP_DURATION_DAYS || "30",
        30
      )
    )
  );
  const tier = String(process.env.STRIPE_VIP_TIER || "vip_basic").trim() || "vip_basic";
  const label =
    String(process.env.STRIPE_VIP_LABEL || "").trim() || `VIP · ${days} dienas`;
  const id =
    String(process.env.STRIPE_VIP_OFFER_ID || "").trim() || `${tier}_${days}d`;
  return {
    id,
    priceId,
    days,
    tier,
    label,
  };
}

export function __resetStripeVipOfferCacheForTest() {
  cachedOffer = null;
  cachedAt = 0;
}

export function getStripeVipOfferConfig() {
  const now = Date.now();
  if (cachedAt && now - cachedAt < OFFER_CACHE_MS) return cachedOffer;
  cachedOffer = parseVipOfferFromEnv();
  cachedAt = now;
  return cachedOffer;
}

export function isStripeVipConfigured() {
  const sk = String(process.env.STRIPE_SECRET_KEY || "").trim();
  const wh = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  return !!(sk && wh && getStripeVipOfferConfig()?.priceId);
}

export function getStripeVipOfferPublic() {
  const offer = getStripeVipOfferConfig();
  if (!offer) return null;
  return {
    id: offer.id,
    days: offer.days,
    tier: offer.tier,
    label: offer.label,
  };
}

function claimStripeSession(user, sessionId) {
  user.stripeSessionsProcessed = user.stripeSessionsProcessed || [];
  const seen = user.stripeSessionsProcessed;
  if (seen.includes(sessionId)) return false;
  seen.push(sessionId);
  if (seen.length > 500) {
    user.stripeSessionsProcessed = seen.slice(-400);
  }
  return true;
}

export function grantVipForCheckoutSession(user, session, now = Date.now()) {
  if (!user || !session) return { ok: false, error: "missing" };
  const offer = getStripeVipOfferConfig();
  if (!offer) return { ok: false, error: "vip_not_configured" };
  const sessionId = String(session.id || "").trim();
  if (!sessionId) return { ok: false, error: "no_session_id" };
  if (session.payment_status !== "paid") {
    return { ok: false, error: "not_paid" };
  }

  const meta = session.metadata || {};
  const uname = String(meta.username || "").trim();
  const priceId = String(meta.vipPriceId || "").trim();
  const tier = String(meta.vipTier || "").trim();
  const days = Math.max(0, Math.floor(Number(meta.vipDays) || 0));

  if (!uname || String(user.username || "") !== uname) {
    return { ok: false, error: "user_mismatch" };
  }
  if (priceId !== offer.priceId || tier !== offer.tier || days !== offer.days) {
    return { ok: false, error: "invalid_offer" };
  }
  if (!claimStripeSession(user, sessionId)) {
    return {
      ok: true,
      already: true,
      vipUntil: Math.max(0, Math.floor(Number(user.vipUntil) || 0)),
      daysAdded: 0,
      tier: String(user.vipTier || offer.tier || "vip_basic") || "vip_basic",
    };
  }

  const startAt = Math.max(Math.floor(Number(now) || 0), Number(user.vipUntil || 0));
  const nextUntil = startAt + offer.days * DAY_MS;
  user.vipUntil = nextUntil;
  user.vipTier = offer.tier;
  user.vipLastPurchaseAt = Math.floor(Number(now) || 0) || Date.now();

  return {
    ok: true,
    vipUntil: nextUntil,
    daysAdded: offer.days,
    tier: offer.tier,
  };
}
