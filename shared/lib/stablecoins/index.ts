import type { StablecoinMeta } from "../../types";
import { USD_MAJOR_COINS } from "./usd-major";
import { USD_MINOR_COINS } from "./usd-minor";
import { NON_USD_COINS } from "./non-usd";
import { COMMODITY_COINS } from "./commodity";

export type { StablecoinOpts } from "./factory";
export { coin, usd, eur, other } from "./factory";

// ---------------------------------------------------------------------------
// Canonical array order — preserves the original rank-based ordering where
// non-USD and commodity entries are interleaved among USD entries.
// When adding a new stablecoin, add its entry to the appropriate category
// file AND insert its ID here at the desired rank position.
// ---------------------------------------------------------------------------
const CANONICAL_ORDER: string[] = [
  "usdt-tether",
  "usdc-circle",
  "usde-ethena",
  "usds-sky",
  "usd1-world-liberty-financial",
  "dai-makerdao",
  "pyusd-paypal",
  "usdf-falcon",
  "usyc-hashnote",
  "usdg-paxos",
  "rlusd-ripple",
  "usdy-ondo-finance",
  "buidl-blackrock",
  "usdd-tron-dao-reserve",
  "usdtb-ethena",
  "m-m0",
  "u-united-stables",
  "usdai-usd-ai",
  "usd0-usual",
  "gho-aave",
  "a7a5-old-vector",
  "tusd-trueusd",
  "fdusd-first-digital",
  "cusd-cap",
  "eurc-circle",
  "usr-resolv",
  "ylds-figure",
  "crvusd-curve",
  "usx-solstice",
  "usda-avalon",
  "frax-frax",
  "dola-inverse-finance",
  "ausd-agora",
  "iusd-infinifi",
  "usdf-astherus",
  "dusd-standx",
  "satusd-river",
  "brz-transfero",
  "gusd-gate",
  "frxusd-frax",
  "rwausdi-multipli",
  "avusd-avant",
  "pusd-pleasing",
  "reusd-re-protocol",
  "pmusd-precious-metals",
  "usdz-anzen",
  "cash-phantom",
  "mnee-mnee",
  "tbill-openeden",
  "fpi-frax",
  "usdu-unitas",
  "usdh-native-markets",
  "lisusd-lista",
  "usdo-openeden",
  "cgusd-cygnus-finance",
  "eurcv-societe-generale-forge",
  "aeur-anchored-coins",
  "usdq-quantoz",
  "reusd-resupply",
  "euri-banking-circle",
  "gusd-gemini",
  "usdp-paxos",
  "usdx-hex-trust",
  "xusd-straitsx",
  "musd-metamask",
  "yusd-aegis",
  "susd-synthetix",
  "bold-liquity",
  "hyusd-hylo",
  "lusd-liquity",
  "fxusd-f-x-protocol",
  "usdn-noble",
  "mim-abracadabra",
  "usdcv-societe-generale-forge",
  "honey-berachain",
  "zchf-frankencoin",
  "usdb-blast",
  "zeusd-zoth",
  "eure-monerium",
  "usn-noon",
  "gyd-gyroscope",
  "nect-beraborrow",
  "eusd-electronic-usd",
  "buck-bucket-protocol",
  "meusd-mezo",
  "uty-xsy",
  "eurs-stasis",
  "msusd-metronome",
  "usdaf-asymmetry",
  "usnd-nerite",
  "ebusd-ebisu",
  "nusd-neutrl",
  "yzusd-yuzu",
  "jupusd-jupiter",
  "usdm-mega",
  "usat-tether",
  "cusd-celo",
  "alusd-alchemix",
  "feusd-felix",
  "fidd-fidelity",
  "usdgo-osl",
  "msusd-main-street",
  "usdm-moneta",
  "hollar-hydrated",
  "usda-anzens",
  "uusd-youves",
  "aznd-mu-digital",
  "pusd-plume",
  "wusd-worldwide",
  "sbc-brale",
  "ousd-origin-protocol",
  "btcusd-btcfi",
  "usp-pikudao",
  "usdr-stablr",
  "usdu-usdu-finance",
  "dusd-dtrinity",
  "ustb-superstate",
  "ousg-ondo-finance",
  "mtbill-midas",
  "wsrusd-reservoir",
  "usdp-parallel",
  "xsgd-straitsx",
  "gyen-gyen",
  "audd-novatti",
  "jpyc-jpyc",
  "axcnh-anchorx",
  "idrt-rupiah-token",
  "tryb-bilira",
  "xaut-tether",
  "paxg-paxos",
  "kau-kinesis",
  "xaum-matrixdock",
  "cgo-comtech",
  "dgld-gold-token-sa",
  "pgold-pleasing",
  "ggbr-goldfish-gold",
  "kag-kinesis",
  "ceur-celo",
  "veur-vnx",
  "eurr-stablr",
  "europ-schuman",
  "eurq-quantoz",
  "eurau-allunity",
  "deuro-deuro",
  "vchf-vnx",
  "vgbp-vnx",
  "tgbp-tokenised",
  "zarp-zarp",
  "isc-international-stable-currency",
  "cadc-cad-coin",
  "pht-pht",
  "cetes-etherfuse",
  "syrupusdc-maple",
  "syrupusdt-maple",
  "yousd-yield-optimizer",
  "aid-gaib",
  "apxusd-apyx",
];

// Build ID → entry lookup from all category arrays
const _allEntries: StablecoinMeta[] = [
  ...USD_MAJOR_COINS,
  ...USD_MINOR_COINS,
  ...NON_USD_COINS,
  ...COMMODITY_COINS,
];
const _byId = new Map(_allEntries.map((s) => [s.id, s]));

/**
 * Tracked stablecoins by market cap (DefiLlama + CoinGecko).
 * IDs use canonical ticker-issuer format.
 *
 * Classification flags:
 *   backing:      rwa-backed | crypto-backed | algorithmic
 *   pegCurrency:  USD | EUR | GBP | CHF | BRL | RUB | JPY | IDR | SGD | TRY | AUD | ZAR | CAD | CNY | CNH | PHP | MXN | UAH | ARS | GOLD | SILVER | VAR | OTHER
 *   governance:   centralized | centralized-dependent | decentralized
 *   yieldBearing: token itself accrues yield
 *   rwa:          backed by real-world assets (treasuries, bonds, etc.)
 */
export const TRACKED_STABLECOINS: StablecoinMeta[] = CANONICAL_ORDER.map((id) => {
  const entry = _byId.get(id);
  if (!entry) throw new Error(`CANONICAL_ORDER references unknown stablecoin ID: ${id}`);
  return entry;
});

// Re-export category arrays for consumers that want a specific subset
export { USD_MAJOR_COINS } from "./usd-major";
export { USD_MINOR_COINS } from "./usd-minor";
export { NON_USD_COINS } from "./non-usd";
export { COMMODITY_COINS } from "./commodity";

// --- Pre-computed lookups (static data, computed once at module level) ---

/** Map of stablecoin ID -> metadata. Use instead of constructing in components. */
export const TRACKED_META_BY_ID = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

/** Set of all tracked stablecoin IDs. */
export const TRACKED_IDS = new Set(TRACKED_STABLECOINS.map((s) => s.id));
