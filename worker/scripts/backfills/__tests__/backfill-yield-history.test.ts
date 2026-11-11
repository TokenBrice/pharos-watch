import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, readJsonResponse, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";

import { registerStablecoinParameterContract } from "../../../src/test-helpers/__shared/endpoint-contracts";
import { handleBackfillYieldHistory } from "../backfill-yield-history";
import type { ResolvedYield } from "../../../src/cron/yield-sync/types";

stubCryptoForAuth();
const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

function yieldDb(sourceKey: string) {
  const fixture = fixtures.open();
  fixture.sqlite.prepare(`INSERT INTO yield_data
    (stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d, yield_source, yield_type, data_source, updated_at)
    VALUES ('zys-zephyr-protocol', ?, 'ZYS', 4.5, 4.5, 4.5, 'Zephyr', 'nav-appreciation', 'protocol-api', 1730000000)`).run(sourceKey);
  return fixture;
}

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

vi.mock("../../../src/lib/yield-source-adapters/zephyr", () => ({
  fetchZephyrZysSource: vi.fn(async () => mockSource),
}));

import { fetchZephyrZysSource } from "../../../src/lib/yield-source-adapters/zephyr";

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

  it("inserts Zephyr yield history row", async () => {
    const { db, sqlite } = yieldDb("protocol-api:zys-zephyr-protocol");

    const res = await handleBackfillYieldHistory({ db, url: makeApiUrl("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol"), trustedAdmin: true, request: makeApiRequest("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol", { adminKey: "secret" }) });

    expect(await readJsonResponse(res, 200)).toEqual({
      coinsProcessed: 1, rowsInserted: 1,
      coinResults: [{ id: "zys-zephyr-protocol", symbol: "ZYS", inserted: true }],
    });

    expect(sqlite.prepare("SELECT stablecoin_id, source_key, recorded_at, source_observed_at, apy, apy_base, apy_reward, source_tvl_usd, data_source, is_best, warning_signals FROM yield_history").get()).toEqual({
      stablecoin_id: "zys-zephyr-protocol", source_key: "protocol-api:zys-zephyr-protocol",
      recorded_at: 1_730_000_000, source_observed_at: 1_730_000_000,
      apy: 4.5, apy_base: 4.5, apy_reward: null, source_tvl_usd: null,
      data_source: "protocol-api", is_best: 1, warning_signals: "[]",
    });

    expect(fetchZephyrZysSource).toHaveBeenCalledTimes(1);
  });

  it("reports per-row inserted from D1 changes and mirrors real arbitration", async () => {
    const { db, sqlite } = yieldDb("pool-other");
    const url = makeApiUrl("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol");
    const invoke = () => handleBackfillYieldHistory({
      db, url, trustedAdmin: true, request: makeApiRequest(url.toString(), { adminKey: "secret" }),
    });
    expect(await readJsonResponse(await invoke(), 200)).toMatchObject({ rowsInserted: 1 });
    const stored = sqlite.prepare("SELECT * FROM yield_history").all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ is_best: 0, apy: 4.5, data_source: "protocol-api" });
    const res = await invoke();

    expect(await readJsonResponse(res, 200)).toEqual({
      coinsProcessed: 1, rowsInserted: 0,
      coinResults: [{ id: "zys-zephyr-protocol", symbol: "ZYS", inserted: false }],
    });

    expect(sqlite.prepare("SELECT * FROM yield_history").all()).toEqual(stored);
  });

  it("skips unavailable protocol observations without writing history", async () => {
    vi.mocked(fetchZephyrZysSource).mockResolvedValueOnce(null);
    const db = mockD1([]);
    const url = makeApiUrl("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol");
    const res = await handleBackfillYieldHistory({
      db, url, trustedAdmin: true, request: makeApiRequest(url.toString(), { adminKey: "secret" }),
    });
    expect(await readJsonResponse(res, 200)).toEqual({
      coinsProcessed: 1, rowsInserted: 0,
      coinResults: [{ id: "zys-zephyr-protocol", symbol: "ZYS", inserted: false }],
      skipped: ["ZYS: missing protocol response"],
    });
    expect(db.getHistory()).toEqual([]);
  });
});
