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

export const PriceSourceHealthSchema = z.object({
  sourceDistribution: z.record(z.string(), z.number()),
  /**
   * Distribution of active canonical assets by candidate `consensusSources`
   * count. Bucket `5+` contains all assets with five or more candidate
   * sources.
   */
  sourceDepthDistribution: PriceSourceDepthDistributionSchema.optional(),
  confidenceDistribution: z.object({
    high: z.number(),
    "single-source": z.number(),
    low: z.number(),
    fallback: z.number(),
  }),
  totalAssets: z.number(),
  lastSync: z.number(),
});
export type PriceSourceHealth = z.output<typeof PriceSourceHealthSchema>;
