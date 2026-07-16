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
  "pyth",
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

export type PriceSourceDepthDistribution = Record<PriceSourceDepthBucket, number>;

export interface PriceSourceHealth {
  sourceDistribution: Record<PriceSourceHealthBucketKey, number> & Record<string, number>;
  /**
   * Distribution of active canonical assets by candidate `consensusSources`
   * count. Bucket `5+` contains all assets with five or more candidate
   * sources.
   */
  sourceDepthDistribution?: PriceSourceDepthDistribution;
  confidenceDistribution: {
    high: number;
    "single-source": number;
    low: number;
    fallback: number;
  };
  totalAssets: number;
  lastSync: number;
}
