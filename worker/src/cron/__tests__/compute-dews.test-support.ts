import { makeNoopD1 } from "../../test-helpers/noop-d1";

export function createDewsDb(prepare: (sql: string) => unknown): D1Database {
  return makeNoopD1({
    prepare,
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  });
}

export function dewsCoin(overrides: Record<string, unknown> = {}) {
  return {
    id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", price: 1, priceConfidence: "high",
    circulating: { peggedUSD: 100_000_000 },
    circulatingPrevDay: { peggedUSD: 99_000_000 },
    circulatingPrevWeek: { peggedUSD: 98_000_000 },
    ...overrides,
  };
}

export function dewsCache(peggedAssets = [dewsCoin()], extra: Record<string, unknown> = {}) {
  return {
    value: JSON.stringify({ peggedAssets, ...extra }),
    updatedAt: Math.floor(Date.now() / 1000),
  };
}
