/**
 * DEX Core Constants — Reusable across any DEX operation
 *
 * Quality multipliers, symbol normalization, composite pool names,
 * blocked DEX IDs, DEX symbol aliases.
 *
 * Cron-specific config (subgraph URLs, rate limits, TVL factors):
 * see ../cron/dex-liquidity/constants.ts
 */

export const GT_API_BASE = "https://api.geckoterminal.com/api/v2";

/**
 * Pool-type-adjusted TVL multipliers for liquidity score quality weighting.
 * Values are expert-judgment calibration, not measured slippage; last table
 * change 2026-04-23, last reviewed 2026-08-19 (Liquidity v6 Phase 2).
 */
export const QUALITY_MULTIPLIERS: Record<string, number> = {
  "curve-stableswap-high-a": 1.0,
  "curve-stableswap": 0.85,
  "curve-cryptoswap": 0.5,
  "uniswap-v3-1bp": 1.1,
  "uniswap-v3-5bp": 0.85,
  "uniswap-v3-30bp": 0.4,
  // PancakeSwap V3 tiers: 1/5/25/30/100 bp. 25bp sits between 5bp stable and 30bp
  // generic; 100bp is a wide volatile tier that should score below 30bp.
  "pancakeswap-v3-1bp": 1.1,
  "pancakeswap-v3-5bp": 0.85,
  "pancakeswap-v3-25bp": 0.7,
  "pancakeswap-v3-30bp": 0.4,
  "pancakeswap-v3-100bp": 0.25,
  "pancakeswap-stableswap": 0.85,
  "meteora-dlmm": 0.85,
  "aerodrome-slipstream-1bp": 1.1,
  "aerodrome-slipstream-5bp": 0.85,
  "aerodrome-slipstream-30bp": 0.4,
  "velodrome-slipstream-1bp": 1.1,
  "velodrome-slipstream-5bp": 0.85,
  "velodrome-slipstream-30bp": 0.4,
  "fluid-dex": 0.85,
  "raydium-clmm": 0.85,
  "raydium-amm": 0.4,
  "orca-whirlpool": 0.85,
  "aerodrome-stable": 0.85,
  "aerodrome-volatile": 0.4,
  "balancer-stable": 0.85,
  "balancer-weighted": 0.4,
  "generic": 0.3,
  "orderbook": 0.6,
};

/** Quality multipliers for GT-only pools, keyed by DEX ID prefix */
export const GT_DEX_QUALITY: [string, number][] = [
  ["balancer", 0.7],
  ["velodrome", 0.7],
  ["velodrome-slipstream", 0.7],
  ["aerodrome-slipstream", 0.7],
  ["meteora", 0.7],
  ["pancakeswap-v3", 0.5],
  ["pancakeswap", 0.5],
  ["trader-joe", 0.5],
  ["sushiswap-v3", 0.5],
  ["camelot-v3", 0.5],
  ["maverick", 0.5],
  ["ambient", 0.5],
  ["pancakeswap-v2", 0.3],
  ["sushiswap", 0.3],
];

/** Well-known USD-pegged tokens used as reference prices in Uni V3 pool observations */
const USD_REFERENCE_SYMBOLS = new Set([
  "USDC", "USDT", "DAI", "BUSD", "TUSD", "USDP", "GUSD", "LUSD", "FRAX",
]);

const DEX_SYMBOL_ALIASES: Record<string, string> = {
  "USD₮0": "USDT",
  "USDT0": "USDT",
  "AUSDC": "USDC",
  "AUSDT": "USDT",
  "USDBC": "USDC",
  "USDC.E": "USDC",
  "USDT.E": "USDT",
};

export function normalizeDexSymbol(symbol: string | null | undefined): string {
  if (typeof symbol !== "string") return "";
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return "";
  return DEX_SYMBOL_ALIASES[normalized] ?? normalized;
}

export function isUsdReferenceSymbol(symbol: string): boolean {
  return USD_REFERENCE_SYMBOLS.has(normalizeDexSymbol(symbol));
}

/** Well-known composite pool names → constituent symbols */
export const COMPOSITE_POOL_NAMES: Record<string, string[]> = {
  "3pool": ["DAI", "USDC", "USDT"],
  "3crv": ["DAI", "USDC", "USDT"],
  "3CRV": ["DAI", "USDC", "USDT"],
  "fraxbp": ["FRAX", "USDC"],
  "FRAXBP": ["FRAX", "USDC"],
};

/** Explicitly blocked DEX slugs (dead/deprecated protocols not yet flagged by DeFiLlama) */
const BLOCKED_DEX_IDS = new Set(["retro", "retro-finance", "retro-finance-v3", "bunni"]);

const BLOCKED_DEX_PREFIXES = ["bunni-"];

export function isBlockedDexId(dexId: string | null | undefined): boolean {
  if (typeof dexId !== "string") return false;
  const normalized = dexId.trim().toLowerCase();
  if (!normalized) return false;
  return BLOCKED_DEX_IDS.has(normalized) || BLOCKED_DEX_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
