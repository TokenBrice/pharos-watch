import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  beginReserveSyncAttempt,
  computeReserveCompositionOverview,
  finalizeReserveSyncSuccess,
  loadFreshIndependentLiveReserveMap,
  pruneLiveReserveHistory,
  resolveReserveResult,
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
      displayBadge: {
        kind: "live",
        label: "Live",
      },
      provenance: {
        evidenceClass: "independent",
        sourceModel: "dynamic-mix",
        scoringEligible: false,
      },
      sync: {
        status: "ok",
        bootstrap: false,
        stale: false,
      },
    });
  });

  it("maps curated-validated adapters to a curated-validated badge", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "frax-frax",
          slices: JSON.stringify([{ name: "Reviewed baseline", pct: 100, risk: "low" }]),
          fetched_at: 1_000,
          source: "frax",
          metadata: JSON.stringify({ freshnessMode: "unverified" }),
          adapter_source_model: "validated-static",
          adapter_evidence_class: "static-validated",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "frax-frax",
          adapter_key: "frax",
          breaker_key: "live-reserves:frax",
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

    const result = await resolveReserveResult(db, "frax-frax", 1_200);

    expect(result).toMatchObject({
      mode: "live",
      displayBadge: {
        kind: "curated-validated",
        label: "Curated-Validated",
      },
      provenance: {
        evidenceClass: "static-validated",
        sourceModel: "validated-static",
      },
    });
  });

  it("keeps live badge semantics for live-fed adapters even when evidence class is static-validated", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "usdd-tron-dao-reserve",
          slices: JSON.stringify([{ name: "Tracked vaults", pct: 100, risk: "medium" }]),
          fetched_at: 1_000,
          source: "usdd-data-platform",
          metadata: JSON.stringify({ freshnessMode: "verified", sourceTimestamp: 1_000 }),
          adapter_source_model: "dynamic-mix",
          adapter_evidence_class: "static-validated",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "usdd-tron-dao-reserve",
          adapter_key: "usdd-data-platform",
          breaker_key: "live-reserves:usdd-data-platform",
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

    const result = await resolveReserveResult(db, "usdd-tron-dao-reserve", 1_200);

    expect(result).toMatchObject({
      mode: "live",
      displayBadge: {
        kind: "live",
        label: "Live",
      },
      provenance: {
        evidenceClass: "static-validated",
        sourceModel: "dynamic-mix",
      },
    });
  });

  it("maps single-asset adapters to a proof badge", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "pyusd-paypal",
          slices: JSON.stringify([{ name: "Issuer reserves", pct: 100, risk: "very-low" }]),
          fetched_at: 1_000,
          source: "single-asset",
          metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
          adapter_source_model: "single-bucket",
          adapter_evidence_class: "weak-live-probe",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "pyusd-paypal",
          adapter_key: "single-asset",
          breaker_key: "live-reserves:single-asset",
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

    const result = await resolveReserveResult(db, "pyusd-paypal", 1_200);

    expect(result).toMatchObject({
      mode: "live",
      displayBadge: {
        kind: "proof",
        label: "Proof",
      },
      provenance: {
        evidenceClass: "weak-live-probe",
        sourceModel: "single-bucket",
      },
    });
  });

  it("maps Liquity v1 system collateral adapters to a live badge", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "lusd-liquity",
          slices: JSON.stringify([{ name: "ETH", pct: 100, risk: "very-low" }]),
          fetched_at: 1_000,
          source: "liquity-v1",
          metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
          adapter_source_model: "single-bucket",
          adapter_evidence_class: "independent",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "lusd-liquity",
          adapter_key: "liquity-v1",
          breaker_key: "live-reserves:lusd-liquity",
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

    const result = await resolveReserveResult(db, "lusd-liquity", 1_200);

    expect(result).toMatchObject({
      mode: "live",
      displayBadge: {
        kind: "live",
        label: "Live",
      },
      provenance: {
        evidenceClass: "independent",
        sourceModel: "single-bucket",
        freshnessMode: "not-applicable",
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
    const attemptId = "attempt-1";

    await beginReserveSyncAttempt(db, {
      stablecoinId: "iusd-infinifi",
      adapterKey: "infinifi",
      breakerKey: "live-reserves:infinifi",
      attemptedAt: 1_000,
      attemptId,
    });

    const { finalized } = await finalizeReserveSyncSuccess(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
        attemptId,
        metadata: {},
        warningCount: 0,
        warnings: [],
        adapterSourceModel: "dynamic-mix",
        adapterEvidenceClass: "independent",
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
        lastAttemptId: attemptId,
        pendingAttemptId: attemptId,
        lastSuccessAttemptId: attemptId,
      },
      Date.now() + 30_000,
    );

    expect(finalized).toBe(true);
    const history = db.getHistory().map((entry) => entry.sql);
    expect(history.some((sql) => sql.includes("INSERT INTO reserve_composition ("))).toBe(true);
    expect(history.some((sql) => sql.includes("INSERT INTO reserve_composition_history"))).toBe(true);
    expect(history.some((sql) => sql.includes("UPDATE reserve_sync_state"))).toBe(true);
    expect(history.some((sql) => sql.includes("INSERT INTO reserve_sync_attempt_history"))).toBe(true);
  });

  it("fences the composition upsert so a late attempt cannot overwrite a newer row", async () => {
    const db = mockD1();
    const attemptId = "attempt-late";

    await finalizeReserveSyncSuccess(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
        attemptId,
        metadata: {},
        warningCount: 0,
        warnings: [],
        adapterSourceModel: "dynamic-mix",
        adapterEvidenceClass: "independent",
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
        lastAttemptId: attemptId,
        pendingAttemptId: attemptId,
        lastSuccessAttemptId: attemptId,
      },
      Date.now() + 30_000,
    );

    const upsert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO reserve_composition ("));
    expect(upsert).toBeDefined();
    // Fence must reject strictly older fetchedAt, and same fetchedAt only when the stored row has no attempt_id.
    expect(upsert!.sql).toMatch(/reserve_composition\.fetched_at\s*<\s*excluded\.fetched_at/);
    expect(upsert!.sql).toMatch(/reserve_composition\.attempt_id\s+IS\s+NULL/);
  });

  it("returns finalized=false and writes no history rows when the composition upsert no-ops", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO reserve_composition (",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);
    const attemptId = "attempt-no-op";

    const result = await finalizeReserveSyncSuccess(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
        attemptId,
        metadata: {},
        warningCount: 0,
        warnings: [],
        adapterSourceModel: "dynamic-mix",
        adapterEvidenceClass: "independent",
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
        lastAttemptId: attemptId,
        pendingAttemptId: attemptId,
        lastSuccessAttemptId: attemptId,
      },
      Date.now() + 30_000,
    );

    expect(result.finalized).toBe(false);
    const history = db.getHistory().map((entry) => entry.sql);
    expect(history.some((sql) => sql.includes("INSERT INTO reserve_composition_history"))).toBe(false);
    expect(history.some((sql) => sql.includes("INSERT INTO reserve_sync_attempt_history"))).toBe(false);
  });

  it("inserts both history rows only when composition and finalize both apply", async () => {
    const db = mockD1();
    const attemptId = "attempt-both";

    const result = await finalizeReserveSyncSuccess(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
        attemptId,
        metadata: {},
        warningCount: 0,
        warnings: [],
        adapterSourceModel: "dynamic-mix",
        adapterEvidenceClass: "independent",
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
        lastAttemptId: attemptId,
        pendingAttemptId: attemptId,
        lastSuccessAttemptId: attemptId,
      },
      Date.now() + 30_000,
    );

    expect(result.finalized).toBe(true);
    const historySqls = db.getHistory().map((entry) => entry.sql);
    expect(historySqls.some((sql) => sql.includes("INSERT INTO reserve_composition_history"))).toBe(true);
    expect(historySqls.some((sql) => sql.includes("INSERT INTO reserve_sync_attempt_history"))).toBe(true);
  });

  it("prunes reserve history tables by retention cutoff", async () => {
    const db = mockD1([
      {
        match: "DELETE FROM reserve_composition_history",
        rows: [],
        runMeta: { changes: 3 },
      },
      {
        match: "DELETE FROM reserve_sync_attempt_history",
        rows: [],
        runMeta: { changes: 7 },
      },
    ]);

    const result = await pruneLiveReserveHistory(db, 10_000, 1_000);
    expect(result).toEqual({
      cutoff: 9_000,
      compositionHistoryDeleted: 3,
      attemptHistoryDeleted: 7,
    });

    // Each DELETE is paginated; single iteration when deleted < batchSize.
    const history = db.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.binds).toEqual([9_000, 5000]);
    expect(history[1]?.binds).toEqual([9_000, 5000]);
  });

  it("paginates large prunes into multiple capped DELETE statements", async () => {
    // Each DELETE call returns `batchSize` until the table drains, then a final
    // partial batch signals completion. Total 650 composition rows + 230 attempt rows.
    const compositionCounts = [100, 100, 100, 100, 100, 100, 50];
    const attemptCounts = [100, 100, 30];
    let compositionIdx = 0;
    let attemptIdx = 0;
    const history: Array<{ sql: string; binds: unknown[] }> = [];

    const db = {
      prepare: (sql: string) => ({
        sql,
        bind: (...binds: unknown[]) => ({
          run: async () => {
            history.push({ sql, binds });
            if (sql.includes("reserve_composition_history")) {
              const changes = compositionCounts[compositionIdx++] ?? 0;
              return { success: true, meta: { changes } };
            }
            if (sql.includes("reserve_sync_attempt_history")) {
              const changes = attemptCounts[attemptIdx++] ?? 0;
              return { success: true, meta: { changes } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        }),
      }),
    } as unknown as D1Database;

    const result = await pruneLiveReserveHistory(db, 10_000, 1_000, 100);
    expect(result.compositionHistoryDeleted).toBe(650);
    expect(result.attemptHistoryDeleted).toBe(230);
    expect(history.length).toBe(compositionCounts.length + attemptCounts.length);
    for (const entry of history) {
      expect(entry.binds[1]).toBe(100);
    }
  });

  it("rejects attempt-stamped snapshots when sync state points to a different successful attempt", async () => {
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(LIVE_SLICES),
          fetched_at: 1_000,
          source: "infinifi",
          attempt_id: "attempt-a",
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
          last_attempt_id: "attempt-b",
          pending_attempt_id: null,
          last_success_attempt_id: "attempt-b",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.liveAt).toBeUndefined();
  });

  it("fails closed on malformed stored slices and falls back instead of serving them as live", async () => {
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
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("treats an unknown stored adapter key as corrupt data instead of crashing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(LIVE_SLICES),
          fetched_at: now,
          source: "removed-adapter-key",
          attempt_id: "attempt-1",
          metadata: "{}",
          warning_count: 0,
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "removed-adapter-key",
          breaker_key: "live-reserves:removed-adapter-key",
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
          last_attempt_id: "attempt-1",
          pending_attempt_id: null,
          last_success_attempt_id: "attempt-1",
        },
      },
    ]);

    const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
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

  it("counts pre-bootstrap adapter failures as error coins instead of missing coins", async () => {
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), 2_000);
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            adapter_key: "infinifi",
            breaker_key: "live-reserves:infinifi",
            last_attempted_at: 2_000,
            last_success_at: null,
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
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, 2_100);
    expect(overview.errorCoins).toBe(emptyOverview.errorCoins + 1);
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins - 1);
  });

  it("prioritizes active sync errors over stale classification in the overview", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            adapter_key: "infinifi",
            breaker_key: "live-reserves:infinifi",
            last_attempted_at: now,
            last_success_at: 1_000,
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
            slices: JSON.stringify(LIVE_SLICES),
            fetched_at: 1_000,
            source: "infinifi",
          },
        ],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);
    expect(overview.errorCoins).toBeGreaterThanOrEqual(1);
    expect(overview.staleCoins).toBe(0);
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

  it("rejects stored snapshots with invalid risk enum values during resolution", async () => {
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
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
  });

  it("rejects stored snapshots with negative pct during resolution", async () => {
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
    expect(result?.mode).toBe("curated-fallback");
    expect(result?.sync?.status).toBe("degraded");
    expect(result?.sync?.lastError).toContain("Stored live reserve snapshot rejected");
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

  it("uses only independent ok-status live reserve snapshots for scoring passthrough", async () => {
    const now = 10_000;
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
            last_status: "degraded",
            warning_count: 1,
            warnings: JSON.stringify([{ code: "unknown-position", message: "warn", severity: "warning" }]),
            last_error: null,
            metadata: "{}",
          },
          {
            stablecoin_id: "pyusd-paypal",
            adapter_key: "single-asset",
            breaker_key: "live-reserves:single-asset",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
          {
            stablecoin_id: "lusd-liquity",
            adapter_key: "liquity-v1",
            breaker_key: "live-reserves:lusd-liquity",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "infinifi",
          },
          {
            stablecoin_id: "pyusd-paypal",
            slices: JSON.stringify([{ name: "Issuer reserves", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "single-asset",
          },
          {
            stablecoin_id: "lusd-liquity",
            slices: JSON.stringify([{ name: "ETH", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "liquity-v1",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "single-bucket",
            adapter_evidence_class: "independent",
          },
        ],
      },
    ]);

    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now + 100);
    expect(scoringMap.has("iusd-infinifi")).toBe(false);
    expect(scoringMap.has("pyusd-paypal")).toBe(false);
    expect(scoringMap.get("lusd-liquity")).toEqual([{ name: "ETH", pct: 100, risk: "very-low" }]);
  });

  it("requires timestamp-backed or explicitly on-chain freshness metadata for scoring passthrough", async () => {
    const now = 10_000;
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
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
          {
            stablecoin_id: "gho-aave",
            adapter_key: "gho",
            breaker_key: "live-reserves:gho",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
          {
            stablecoin_id: "usds-sky",
            adapter_key: "sky-makercore",
            breaker_key: "live-reserves:sky-makercore",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          {
            stablecoin_id: "iusd-infinifi",
            slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "infinifi",
            metadata: JSON.stringify({ freshnessMode: "unverified" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          },
          {
            stablecoin_id: "gho-aave",
            slices: JSON.stringify([{ name: "Tracked GSM", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "gho",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          },
          {
            stablecoin_id: "usds-sky",
            slices: JSON.stringify([{ name: "PSM USDC", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "sky-makercore",
            metadata: JSON.stringify({ sourceTimestamp: now }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          },
        ],
      },
    ]);

    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now + 100);
    expect(scoringMap.has("iusd-infinifi")).toBe(false);
    expect(scoringMap.get("gho-aave")).toEqual([{ name: "Tracked GSM", pct: 100, risk: "low" }]);
    expect(scoringMap.get("usds-sky")).toEqual([{ name: "PSM USDC", pct: 100, risk: "low" }]);
  });

  it("rolls up fresh evidence quality and uncertain write states separately", async () => {
    const now = 10_000;
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "frax-frax",
            adapter_key: "frax",
            breaker_key: "live-reserves:frax",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
          {
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
          {
            stablecoin_id: "gho-aave",
            adapter_key: "gho",
            breaker_key: "live-reserves:gho",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
          {
            stablecoin_id: "pyusd-paypal",
            adapter_key: "single-asset",
            breaker_key: "live-reserves:single-asset",
            last_attempted_at: now,
            last_success_at: now,
            last_status: "ok",
            warning_count: 0,
            warnings: null,
            last_error: null,
            metadata: "{}",
          },
          {
            stablecoin_id: "usdo-openeden",
            adapter_key: "openeden-usdo",
            breaker_key: "live-reserves:openeden-usdo",
            last_attempted_at: now,
            last_success_at: null,
            last_status: "error",
            warning_count: 0,
            warnings: null,
            last_error: "D1 write timeout for usdo-openeden",
            metadata: JSON.stringify({ uncertainWrite: true, reason: "storage-write-timeout" }),
          },
        ],
      },
      {
        match: "reserve_composition",
        rows: [
          {
            stablecoin_id: "frax-frax",
            slices: JSON.stringify([{ name: "Reviewed baseline", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "frax",
            metadata: JSON.stringify({ freshnessMode: "unverified" }),
            adapter_source_model: "validated-static",
            adapter_evidence_class: "static-validated",
          },
          {
            stablecoin_id: "iusd-infinifi",
            slices: JSON.stringify([{ name: "Known Farm", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "infinifi",
            metadata: JSON.stringify({ freshnessMode: "unverified" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          },
          {
            stablecoin_id: "gho-aave",
            slices: JSON.stringify([{ name: "Tracked GSM", pct: 100, risk: "low" }]),
            fetched_at: now,
            source: "gho",
            metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
            adapter_source_model: "dynamic-mix",
            adapter_evidence_class: "independent",
          },
          {
            stablecoin_id: "pyusd-paypal",
            slices: JSON.stringify([{ name: "Issuer reserves", pct: 100, risk: "very-low" }]),
            fetched_at: now,
            source: "single-asset",
            metadata: JSON.stringify({}),
            adapter_source_model: "single-bucket",
            adapter_evidence_class: "weak-live-probe",
          },
        ],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now + 100);
    expect(overview.freshCoins).toBeGreaterThanOrEqual(4);
    expect(overview.independentFreshEligible).toBe(1);
    expect(overview.independentFreshUnverified).toBe(1);
    expect(overview.staticValidatedFresh).toBe(1);
    expect(overview.weakProbeFresh).toBe(1);
    expect(overview.writeTimeoutUncertain).toBe(1);
  });

  it("counts an uncertainWrite coin with no composition in a single primary bucket", async () => {
    const now = 10_000;
    const emptyOverview = await computeReserveCompositionOverview(mockD1(), now);
    const db = mockD1([
      {
        match: "reserve_sync_state",
        rows: [
          {
            stablecoin_id: "usdo-openeden",
            adapter_key: "openeden-usdo",
            breaker_key: "live-reserves:openeden-usdo",
            last_attempted_at: now,
            last_success_at: null,
            last_status: "error",
            warning_count: 0,
            warnings: null,
            last_error: "D1 write timeout",
            metadata: JSON.stringify({ uncertainWrite: true, reason: "storage-write-timeout" }),
          },
        ],
      },
      {
        match: "reserve_composition",
        rows: [],
      },
    ]);

    const overview = await computeReserveCompositionOverview(db, now);

    // Primary bucket increments by exactly 1 (errorCoins, because lastStatus=error + no composition).
    expect(overview.errorCoins).toBe(emptyOverview.errorCoins + 1);
    expect(overview.missingCoins).toBe(emptyOverview.missingCoins - 1);
    expect(overview.writeTimeoutUncertain).toBe(1);

    // Sum of primary buckets equals configured coins (no cross-counting).
    const primarySum = overview.freshCoins
      + overview.staleCoins
      + overview.missingCoins
      + overview.degradedCoins
      + overview.errorCoins
      + overview.corruptCoins;
    expect(primarySum).toBe(overview.configuredCoins);
  });
});
