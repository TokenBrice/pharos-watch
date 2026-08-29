import type { MockRoute } from "@shared/test-utils/mock-fetch";

export function defaultSyncRoutes(dlData: unknown, cgData: unknown = {}): MockRoute[] {
  return [
    { match: "api.coingecko.com", body: cgData },
    { match: "stablecoins.llama.fi", body: dlData },
    { match: "coins.llama.fi/prices", body: { coins: {} } },
  ];
}

