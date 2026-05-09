/** NHL komandu katalogs un validācija (/giveaway/nhl-team, misijas). */

export const GIVEAWAY_NHL_TEAM_MAX = 64;

/** saīsinājums → pilns nosaukums (misijai / eksportam) */
export const NHL_GIVEAWAY_ABBR_TO_NAME = {
  ANA: "Anaheim Ducks",
  BOS: "Boston Bruins",
  BUF: "Buffalo Sabres",
  CAR: "Carolina Hurricanes",
  CBJ: "Columbus Blue Jackets",
  CGY: "Calgary Flames",
  CHI: "Chicago Blackhawks",
  COL: "Colorado Avalanche",
  DAL: "Dallas Stars",
  DET: "Detroit Red Wings",
  EDM: "Edmonton Oilers",
  FLA: "Florida Panthers",
  LAK: "Los Angeles Kings",
  MIN: "Minnesota Wild",
  MTL: "Montréal Canadiens",
  NSH: "Nashville Predators",
  NJD: "New Jersey Devils",
  NYI: "New York Islanders",
  NYR: "New York Rangers",
  OTT: "Ottawa Senators",
  PHI: "Philadelphia Flyers",
  PIT: "Pittsburgh Penguins",
  SEA: "Seattle Kraken",
  SJS: "San Jose Sharks",
  STL: "St. Louis Blues",
  TBL: "Tampa Bay Lightning",
  TOR: "Toronto Maple Leafs",
  UTA: "Utah Hockey Club",
  VAN: "Vancouver Canucks",
  VGK: "Vegas Golden Knights",
  WPG: "Winnipeg Jets",
  WSH: "Washington Capitals",
};

export function normalizeGiveawayNhlAbbr(raw) {
  const a = String(raw || "")
    .trim()
    .toUpperCase();
  if (!a || a.length > 4) return "";
  if (!/^[A-Z]+$/.test(a)) return "";
  return NHL_GIVEAWAY_ABBR_TO_NAME[a] ? a : "";
}

/** NHL / komandas nosaukums izlozei — bez HTML / vadības zīmēm. */
export function normalizeGiveawayNhlTeam(raw) {
  let s = String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\x00-\x1f<>\"\\{}|]/g, "")
    .slice(0, GIVEAWAY_NHL_TEAM_MAX);
  return s;
}
