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

  it("filters out malformed slices from D1 data during resolution", async () => {
    const now = Math.floor(Date.now() / 1000);
    const corruptSlices = [
      { name: "Valid Farm", pct: 60, risk: "low" },
      { name: "Missing Risk", pct: 20 },
      { pct: 10, risk: "medium" },
      { name: "Bad Pct", pct: "fifty", risk: "low" },
      { name: "Valid Too", pct: 10, risk: "high" },
    ];

    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(corruptSlices),
          fetched_at: now,
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
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.reserves).toHaveLength(2);
    expect(result?.reserves[0].name).toBe("Valid Farm");
    expect(result?.reserves[1].name).toBe("Valid Too");
  });

  it("separates error coins from degraded coins in the overview", async () => {
    const now = 2_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            adapter_key: "infinifi",
            breaker_key: "live-reserves:infinifi",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "error",
            warning_count: 0,
            warnings: null,
            last_error: "HTTP 503",
            metadata: "{}",
          },
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "infinifi",
          },
        ],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now + 100);
    // errorCoins must exist on the type and be a number
    expect(typeof overview.errorCoins).toBe("number");
    // The error coin should be counted, not in degraded
    expect(overview.errorCoins).toBeGreaterThanOrEqual(1);
  });

  it("includes lastError in sync view when sync state has an error", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: null,
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: 1_000,
          last_success_at: null,
          last_status: "error",
          warning_count: 0,
          warnings: null,
          last_error: "HTTP 503 for https://api.example.com",
          metadata: "{}",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);
    expect(result?.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
  });

  it("filters slices with invalid risk enum values during resolution", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify([
            { name: "Good", pct: 60, risk: "low" },
            { name: "Bad", pct: 40, risk: "bogus" },
          ]),
          fetched_at: now,
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
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result!.reserves).toHaveLength(1);
    expect(result!.reserves[0].name).toBe("Good");
  });

  it("filters slices with negative pct during resolution", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify([
            { name: "Valid", pct: 80, risk: "medium" },
            { name: "Negative", pct: -10, risk: "low" },
            { name: "Zero", pct: 0, risk: "high" },
          ]),
          fetched_at: now,
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
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result!.reserves).toHaveLength(1);
    expect(result!.reserves[0].name).toBe("Valid");
  });

  it("ignores malformed warning and metadata JSON in sync state rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(LIVE_SLICES),
          fetched_at: now,
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
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 1,
          warnings: "{bad json",
          last_error: null,
          metadata: "{bad json",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 60);

    expect(result).toMatchObject({
      mode: "live",
      sync: {
        status: "ok",
        bootstrap: false,
        stale: false,
      },
    });
    expect(result?.sync).not.toHaveProperty("warnings");
  });
});
