/** DEX pipeline constants extracted from sync-dex-liquidity.ts */

export const GT_API_BASE = "https://api.geckoterminal.com/api/v2";

/** Pool-type-adjusted TVL multipliers for liquidity score quality weighting */
export const QUALITY_MULTIPLIERS: Record<string, number> = {
  "curve-stableswap-high-a": 1.0,
  "curve-stableswap": 0.85,
  "curve-cryptoswap": 0.5,
  "uniswap-v3-1bp": 1.1,
  "uniswap-v3-5bp": 0.85,
  "uniswap-v3-30bp": 0.4,
  "fluid-dex": 0.85,
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
  ["pancakeswap-v3", 0.5],
  ["trader-joe", 0.5],
  ["sushiswap-v3", 0.5],
  ["camelot-v3", 0.5],
  ["maverick", 0.5],
  ["ambient", 0.5],
  ["pancakeswap-v2", 0.3],
  ["sushiswap", 0.3],
];

/** Well-known USD-pegged tokens used as reference prices in Uni V3 pool observations */
export const USD_REFERENCE_SYMBOLS = new Set([
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

export function normalizeDexSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
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
export const BLOCKED_DEX_IDS = new Set(["retro", "retro-finance", "retro-finance-v3"]);
