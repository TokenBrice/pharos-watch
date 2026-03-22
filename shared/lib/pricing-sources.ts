const PRICING_SOURCE_LABELS = {
  coingecko: "CoinGecko",
  defillama: "DefiLlama",
  "defillama-list": "DefiLlama (list)",
  geckoterminal: "GeckoTerminal",
  pyth: "Pyth Network",
  binance: "Binance",
  kraken: "Kraken",
  bitstamp: "Bitstamp",
  coinbase: "Coinbase",
  redstone: "RedStone",
  "curve-onchain": "Curve on-chain",
  "curve-oracle": "Curve oracle",
  "dex-promoted": "DEX prices",
  "fluid-dex": "Fluid",
  "balancer-dex": "Balancer",
  "raydium-dex": "Raydium",
  "orca-dex": "Orca",
  jupiter: "Jupiter",
  coinmarketcap: "CoinMarketCap",
  dexscreener: "DexScreener",
  "defillama-contract": "DefiLlama (contract)",
  "protocol-redeem": "Protocol Redemption",
  "pool-tvl-weighted": "Pool TVL-weighted",
  cached: "Cached fallback",
} as const;

export type PricingSourceKey = keyof typeof PRICING_SOURCE_LABELS;

export const PRICE_TRANSPARENCY_SOURCE_KEYS = [
  "coingecko",
  "defillama",
  "defillama-list",
  "geckoterminal",
  "pyth",
  "binance",
  "kraken",
  "bitstamp",
  "coinbase",
  "redstone",
  "curve-onchain",
  "curve-oracle",
  "dex-promoted",
  "fluid-dex",
  "balancer-dex",
  "raydium-dex",
  "orca-dex",
  "coinmarketcap",
  "dexscreener",
  "jupiter",
  "defillama-contract",
  "pool-tvl-weighted",
  "cached",
] as const satisfies readonly PricingSourceKey[];

const PRICE_SOURCE_HEALTH_BUCKET_DEFS = [
  { key: "coingecko+defillama-list", label: "CoinGecko + DefiLlama (list)", shortLabel: "CG+DL-list" },
  { key: "coingecko", label: "CoinGecko", shortLabel: "CG" },
  { key: "defillama", label: "DefiLlama", shortLabel: "DL" },
  { key: "defillama-list", label: "DefiLlama (list)", shortLabel: "DL-list" },
  { key: "protocol-redeem", label: "Protocol Redemption", shortLabel: "Protocol" },
  { key: "defillama-contract", label: "DefiLlama (contract)", shortLabel: "Contract" },
  { key: "coinmarketcap", label: "CoinMarketCap", shortLabel: "CMC" },
  { key: "dexscreener", label: "DexScreener", shortLabel: "DexScreener" },
  { key: "jupiter", label: "Jupiter", shortLabel: "Jupiter" },
  { key: "pyth", label: "Pyth Network", shortLabel: "Pyth" },
  { key: "binance", label: "Binance", shortLabel: "Binance" },
  { key: "kraken", label: "Kraken", shortLabel: "Kraken" },
  { key: "bitstamp", label: "Bitstamp", shortLabel: "Bitstamp" },
  { key: "coinbase", label: "Coinbase", shortLabel: "Coinbase" },
  { key: "redstone", label: "RedStone", shortLabel: "RedStone" },
  { key: "curve-onchain", label: "Curve on-chain", shortLabel: "Curve" },
  { key: "curve-oracle", label: "Curve oracle", shortLabel: "Curve oracle" },
  { key: "dex-promoted", label: "DEX prices", shortLabel: "DEX" },
  { key: "fluid-dex", label: "Fluid", shortLabel: "Fluid" },
  { key: "balancer-dex", label: "Balancer", shortLabel: "Balancer" },
  { key: "raydium-dex", label: "Raydium", shortLabel: "Raydium" },
  { key: "orca-dex", label: "Orca", shortLabel: "Orca" },
  { key: "geckoterminal", label: "GeckoTerminal", shortLabel: "GT" },
  { key: "pool-tvl-weighted", label: "Pool TVL-weighted", shortLabel: "Pool" },
  { key: "cached", label: "Cached fallback", shortLabel: "Cached" },
  { key: "missing", label: "Missing", shortLabel: "Missing" },
] as const;

export const PRICE_SOURCE_HEALTH_BUCKET_KEYS = PRICE_SOURCE_HEALTH_BUCKET_DEFS.map((bucket) => bucket.key);
const PRICE_SOURCE_HEALTH_BUCKET_KEY_SET = new Set<string>(PRICE_SOURCE_HEALTH_BUCKET_KEYS);

export type PriceSourceHealthBucketKey = (typeof PRICE_SOURCE_HEALTH_BUCKET_DEFS)[number]["key"];

export function createEmptyPriceSourceHealthDistribution(): Record<PriceSourceHealthBucketKey, number> {
  return Object.fromEntries(
    PRICE_SOURCE_HEALTH_BUCKET_KEYS.map((key) => [key, 0]),
  ) as Record<PriceSourceHealthBucketKey, number>;
}

export function getPricingSourceLabel(sourceKey: string): string {
  return PRICING_SOURCE_LABELS[sourceKey as PricingSourceKey] ?? sourceKey;
}

export function getPriceSourceHealthBucketShortLabel(bucketKey: PriceSourceHealthBucketKey): string {
  return PRICE_SOURCE_HEALTH_BUCKET_DEFS.find((bucket) => bucket.key === bucketKey)?.shortLabel ?? bucketKey;
}

export function isPriceSourceHealthBucketKey(value: string): value is PriceSourceHealthBucketKey {
  return PRICE_SOURCE_HEALTH_BUCKET_KEY_SET.has(value);
}

export function splitCompositePriceSource(source: string): string[] {
  return source
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function formatPricingSourceLabel(source: string): string {
  return splitCompositePriceSource(source)
    .map((part) => getPricingSourceLabel(part))
    .join(" + ");
}
