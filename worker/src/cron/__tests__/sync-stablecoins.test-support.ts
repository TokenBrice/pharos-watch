import type { MockRoute } from "@shared/test-utils/mock-fetch";

export type CacheWrite = { key: string; value: string };

export function defaultSyncRoutes(dlData: unknown, cgData: unknown = {}): MockRoute[] {
  return [
    { match: "api.coingecko.com", body: cgData },
    { match: "stablecoins.llama.fi", body: dlData },
    { match: "coins.llama.fi/prices", body: { coins: {} } },
  ];
}

export function getPublishedAsset<T extends Record<string, unknown>>(
  writes: CacheWrite[],
  id: string,
): T | undefined {
  const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
  if (!stablecoinsWrite) return undefined;
  const payload = JSON.parse(stablecoinsWrite.value) as { peggedAssets?: T[] };
  return payload.peggedAssets?.find((asset) => asset.id === id);
}
