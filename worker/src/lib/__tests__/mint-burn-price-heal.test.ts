import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  batchExecute: vi.fn().mockResolvedValue(0),
  getPriceCache: vi.fn().mockResolvedValue(new Map()),
}));

import { batchExecute, getPriceCache } from "../db";
import { healNullPrices } from "../mint-burn-pipeline/price-heal";

const NOW = 1_700_000_000;

function mockDb(
  nullEvents: Array<{
    id: string;
    stablecoin_id: string;
    chain_id: string;
    amount: number;
    timestamp: number;
  }> = [],
): D1Database {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        all: async () => ({ results: nullEvents }),
      }),
    }),
  } as unknown as D1Database;
}

describe("healNullPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns healed=0 when no NULL events exist", async () => {
    const db = mockDb([]);
    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(0);
    expect(result.affectedHours.size).toBe(0);
  });

  it("resolves prices from getPriceCache and returns correct healed count", async () => {
    const events = [
      { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
      { id: "e2", stablecoin_id: "usdt-tether", chain_id: "ethereum", amount: 2000, timestamp: NOW - 7200 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(
      new Map([
        ["usdc-circle", { price: 1.0, updatedAt: NOW }],
        ["usdt-tether", { price: 0.999, updatedAt: NOW }],
      ]),
    );
    vi.mocked(batchExecute).mockResolvedValueOnce(2);

    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(2);
    expect(batchExecute).toHaveBeenCalledTimes(1);
  });

  it("skips events whose stablecoin has no price in price_cache", async () => {
    const events = [
      { id: "e1", stablecoin_id: "unknown-coin", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(new Map());

    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(0);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("collects correct affected hours for re-aggregation", async () => {
    const events = [
      { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: 3605 },
      { id: "e2", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 2000, timestamp: 3610 },
      { id: "e3", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 500, timestamp: 7205 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(
      new Map([["usdc-circle", { price: 1.0, updatedAt: NOW }]]),
    );
    vi.mocked(batchExecute).mockResolvedValueOnce(3);

    const result = await healNullPrices(db, NOW);
    expect(result.affectedHours.size).toBe(2);
  });
});
