import type { MockRoute } from "@shared/test-utils/mock-fetch";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type { PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";

export function defaultSyncRoutes(dlData: unknown, cgData: unknown = {}): MockRoute[] {
  return [
    { match: "api.coingecko.com", body: cgData },
    { match: "stablecoins.llama.fi", body: dlData },
    { match: "coins.llama.fi/prices", body: { coins: {} } },
  ];
}

export function makeDlResponse(assetCount: number): { peggedAssets: PeggedAsset[] } {
  return {
    peggedAssets: Array.from({ length: assetCount }, (_, i) => makePeggedAsset({
      id: String(i + 1),
      name: `Stablecoin ${i + 1}`,
      symbol: `SC${i + 1}`,
      geckoId: undefined,
      price: 1,
      priceSource: "defillama",
      priceConfidence: "high",
      supplySource: "defillama",
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      circulating: { peggedUSD: 1_000_000 },
      circulatingPrevDay: { peggedUSD: 1_000_000 },
      circulatingPrevWeek: { peggedUSD: 1_000_000 },
      circulatingPrevMonth: { peggedUSD: 1_000_000 },
      chainCirculating: {},
      chains: ["Ethereum"],
    })),
  };
}

export const DEFAULT_SYNC_D1_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
];

export function makeSyncDb(extra: MockTableConfig[] = []) {
  return mockD1([
    ...extra,
    { match: "cache", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "price_cache", rows: [] },
    { match: "circuit", rows: [] },
  ]);
}

export function trackCacheWrites(db: D1Database): Array<{ key: string; value: string }> {
  const writes: Array<{ key: string; value: string }> = [];
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("INSERT INTO cache")) return statement;
    return {
      ...statement,
      bind: (...args: unknown[]) => {
        writes.push({ key: String(args[0] ?? ""), value: String(args[1] ?? "") });
        return statement.bind(...args);
      },
    };
  }) as typeof db.prepare;
  return writes;
}
