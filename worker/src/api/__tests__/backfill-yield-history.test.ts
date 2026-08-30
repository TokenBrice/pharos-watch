import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleBackfillYieldHistory } from "../backfill-yield-history";
import type { ResolvedYield } from "../../cron/yield-sync/types";

stubCryptoForAuth();

const mockSource: ResolvedYield = {
  currentApy: 4.5,
  apyBase: 4.5,
  apyReward: null,
  sourcePool: null,
  sourceTvlUsd: null,
  dataSource: "protocol-api",
  exchangeRate: null,
  sourceKey: "protocol-api:zys-zephyr-protocol",
  yieldSource: "Zephyr Scanner ZYS returns",
  yieldType: "nav-appreciation",
  sourceObservedAt: 1_730_000_000,
  comparisonAnchorObservedAt: null,
};

vi.mock("../../lib/yield-source-adapters/zephyr", () => ({
  fetchZephyrZysSource: vi.fn(async () => mockSource),
}));

import { fetchZephyrZysSource } from "../../lib/yield-source-adapters/zephyr";

describe("handleBackfillYieldHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  registerStablecoinParameterContract({
    name: "yield history backfill",
    path: "/api/backfill-yield-history",
    invoke: (db, url) => handleBackfillYieldHistory({ db, url, trustedAdmin: true, request: makeApiRequest(url.toString(), { adminKey: "secret" }) }),
    cases: [{ kind: "unknown", stablecoin: "not-a-real-id", error: "Stablecoin not found" }],
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillYieldHistory({ db: mockD1([], { allowUnmatched: true }), url: makeApiUrl("/api/backfill-yield-history?batch=999999&batchSize=100"), trustedAdmin: true, request: makeApiRequest("/api/backfill-yield-history?batch=999999&batchSize=100", { adminKey: "secret" }) });

    expect(await readJsonResponse(res, 200)).toEqual({ message: "No coins in this batch" });
  });

  it("inserts Zephyr yield history row", async () => {
    const db = mockD1([], { allowUnmatched: true });

    const res = await handleBackfillYieldHistory({ db, url: makeApiUrl("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol"), trustedAdmin: true, request: makeApiRequest("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol", { adminKey: "secret" }) });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      coinResults: Array<{ id: string; symbol: string; inserted: boolean }>;
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(1);
    expect(body.coinResults[0]).toEqual({ id: "zys-zephyr-protocol", symbol: "ZYS", inserted: true });

    const insertStmt = db.getHistory().find((stmt) =>
      stmt.sql.includes("INSERT OR IGNORE INTO yield_history"),
    );
    expect(insertStmt?.binds).toEqual([
      "zys-zephyr-protocol",
      "protocol-api:zys-zephyr-protocol",
      1_730_000_000,
      4.5,
      4.5,
      null,
      null,
      "protocol-api-backfill",
      1,
      "[]",
    ]);

    expect(fetchZephyrZysSource).toHaveBeenCalledTimes(1);
  });
});
