export const API_CACHE_PROFILES = {
  realtime: "public, s-maxage=60, max-age=10",
  // Cron-published payloads with 15-30 min producers: edge TTL near producer
  // cadence instead of 60s. stale-while-revalidate only benefits browser
  // caches; Cloudflare's edge cache does not honor it.
  producerBacked: "public, s-maxage=300, max-age=60, stale-while-revalidate=300",
  standard: "public, s-maxage=300, max-age=60",
  custom: "public, s-maxage=300, max-age=300",
  perCoin: "public, s-maxage=300, max-age=10",
  slow: "public, s-maxage=3600, max-age=300",
  archive: "public, s-maxage=86400, max-age=3600",
  noStore: "no-store",
  publicStatus: "public, max-age=60",
  ogImage: "public, max-age=900, s-maxage=900",
  reserveLive: "public, s-maxage=3600, max-age=300",
  reserveLiveStale: "public, s-maxage=1800, max-age=120",
  reserveFallback: "public, s-maxage=300, max-age=60",
} as const;

export type ApiCacheProfileKey = keyof typeof API_CACHE_PROFILES;

export const API_CACHE_PROFILE_DOCUMENTED_KEYS = [
  "realtime",
  "producerBacked",
  "standard",
  "custom",
  "perCoin",
  "slow",
  "archive",
  "noStore",
] as const satisfies readonly ApiCacheProfileKey[];

export const PER_COIN_CACHE_TTL_SECONDS = 5 * 60;

export function buildPerCoinCacheControl(sMaxageSeconds: number): string {
  const boundedSMaxage = Math.max(0, Math.floor(sMaxageSeconds));
  return `public, s-maxage=${boundedSMaxage}, max-age=10`;
}
