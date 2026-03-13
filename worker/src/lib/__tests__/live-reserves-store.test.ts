import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  computeReserveCompositionOverview,
  resolveReserveResult,
  upsertReserveSnapshot,
} from "../live-reserves-store";

const LIVE_SLICES = [{ name: "Test Farm", pct: 100, risk: "low" as const }];

describe("live-reserves-store", () => {
  it("falls back when reserve composition exists without a matching successful sync state", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(LIVE_SLICES),
          fetched_at: 1_000,
          source: "infinifi",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: null,
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result?.mode).toBe("curated-fallback");
    expect(result?.liveAt).toBeUndefined();
  });

  it("returns live data only when composition and sync state agree on the last successful snapshot", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(LIVE_SLICES),
          fetched_at: 1_000,
          source: "infinifi",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: 1_000,
          last_success_at: 1_000,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

    expect(result).toMatchObject({
      mode: "live",
      liveAt: 1_000,
      reserves: LIVE_SLICES,
      sync: {
        status: "ok",
        bootstrap: false,
        stale: false,
      },
    });
  });

  it("treats inconsistent live snapshots as missing in the reserve overview", async () => {
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), 2_000);
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [{
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: 1_000,
          last_success_at: 1_000,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        }],
      },
      {
        match: "reserve_composition",
        rows: [{
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(LIVE_SLICES),
          fetched_at: 999,
          source: "infinifi",
        }],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, 2_000);

    // Inconsistent snapshot (sync.last_success_at !== composition.fetched_at) is treated as missing.
    // The coin was already counted as missing in the empty overview, so counts don't change.
    // Before the double-count fix, this coin was counted in BOTH missing AND degraded.
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins);
    expect(overview.freshCoins).toBe(0);
    expect(overview.degradedCoins).toBe(emptyOverview.degradedCoins);
  });

  it("persists reserve composition and sync state together for successful snapshots", async () => {
    const db = mockD1();

    await upsertReserveSnapshot(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
      },
      {
        stablecoinId: "iusd-infinifi",
        adapterKey: "infinifi",
        breakerKey: "live-reserves:infinifi",
        lastAttemptedAt: 1_000,
        lastSuccessAt: 1_000,
        lastStatus: "ok",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: {},
      },
    );

    const history = db.getHistory().map((entry) => entry.sql);
    expect(history.some((sql) => sql.includes("reserve_composition"))).toBe(true);
    expect(history.some((sql) => sql.includes("reserve_sync_state"))).toBe(true);
  });
});
