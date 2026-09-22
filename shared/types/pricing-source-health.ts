import { z } from "zod";

export const PRICE_SOURCE_HEALTH_BUCKET_KEYS = [
  "coingecko+defillama-list",
  "coingecko",
  "coingecko-low-volume",
  "coingecko-native-implied",
  "defillama",
  "defillama-list",
  "coingecko-mirror",
  "cg-ticker",
  "geckoterminal",
  "binance",
  "kraken",
  "bitstamp",
  "coinbase",
  "redstone",
  "curve-onchain",
  "curve-oracle",
  "chainlink-nav",
  "superstate-liquidity",
  "dex-promoted",
  "fluid-dex",
  "balancer-dex",
  "curve-dex",
  "curve-thin-onchain",
  "uniswap-v3-dex",
  "uniswap-v3-exact",
  "uniswap-v4-dex",
  "raydium-dex",
  "orca-dex",
  "meteora-dex",
  "pancakeswap-dex",
  "aerodrome-dex",
  "aerodrome-exact",
  "velodrome-dex",
  "jupiter",
  "coinmarketcap",
  "dexscreener-exact",
  "dexscreener-address",
  "dexpaprika-address",
  "alchemy-address",
  "moralis-address",
  "birdeye-address",
  "coingecko-onchain-address",
  "dexscreener-search",
  "defillama-contract",
  "protocol-redeem",
  "zephyr-scanner",
  "pool-tvl-weighted",
  "cached",
  "missing",
] as const;

export type PriceSourceHealthBucketKey = (typeof PRICE_SOURCE_HEALTH_BUCKET_KEYS)[number];

export type PriceSourceDepthBucket = "0" | "1" | "2" | "3" | "4" | "5+";

const PRICE_SOURCE_DEPTH_BUCKETS = ["0", "1", "2", "3", "4", "5+"] as const;

export const PriceSourceDepthDistributionSchema = z.record(
  z.enum(PRICE_SOURCE_DEPTH_BUCKETS),
  z.number(),
);
export type PriceSourceDepthDistribution = z.output<typeof PriceSourceDepthDistributionSchema>;

const PriceSourceHealthDistributionSchema = z.object({
  sourceDistribution: z.record(z.string(), z.number()),
  confidenceDistribution: z.object({
    high: z.number(),
    "single-source": z.number(),
    low: z.number(),
    fallback: z.number(),
  }),
  totalAssets: z.number(),
});

export const PriceSourceHealthSchema = PriceSourceHealthDistributionSchema.extend({
  /** Active catalog only; absent active rows count as missing. Legacy totals retain full-cache scope. */
  active: PriceSourceHealthDistributionSchema.optional(),
  /** Active canonical assets grouped by candidate consensus source count. */
  sourceDepthDistribution: PriceSourceDepthDistributionSchema.optional(),
  lastSync: z.number(),
});
export type PriceSourceHealth = z.output<typeof PriceSourceHealthSchema>;
