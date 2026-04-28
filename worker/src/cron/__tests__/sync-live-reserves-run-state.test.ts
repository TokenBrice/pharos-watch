import { describe, expect, it } from "vitest";
import type { ConfiguredCoin } from "../sync-live-reserves-shared";
import { recordDeferredTail } from "../sync-live-reserves-run-state";

function makeCoin(id: string): ConfiguredCoin {
  return {
    id,
    liveReservesConfig: {
      adapter: "test-adapter",
      version: 1,
      semantics: "dynamic-mix",
      evidence: "independent",
      inputs: {
        primary: { kind: "static-json", value: {} },
      },
    },
  } as unknown as ConfiguredCoin;
}

function makeBatchRecordingDb(batchSizes: number[]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({ sql, binds }),
    }),
    batch: async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("recordDeferredTail", () => {
  it("chunks deferred tail writes through the shared D1 batch executor", async () => {
    const batchSizes: number[] = [];
    const db = makeBatchRecordingDb(batchSizes);
    const coins = Array.from({ length: 61 }, (_value, index) => makeCoin(`coin-${index}`));

    const result = await recordDeferredTail(db, coins, new Set(), 1_700_000_000);

    expect(result).toEqual({
      deferredCoins: 61,
      nextCursorStablecoinId: "coin-0",
    });
    expect(batchSizes).toEqual([100, 23]);
  });
});
