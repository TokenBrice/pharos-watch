import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const getReserveAdapterMock = vi.fn();
const shouldAttemptFetchMock = vi.fn();
const recordOutcomeSafeMock = vi.fn();
const GATE_LOAD_TIMEOUT_MS = 15_000;

vi.mock("../reserve-adapters/index", () => ({
  getReserveAdapter: getReserveAdapterMock,
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: shouldAttemptFetchMock,
  recordOutcomeSafe: recordOutcomeSafeMock,
}));

const configuredCoins = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig);

function reserveDb() {
  return mockD1([
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'", rows: [] },
    { match: "DELETE FROM cache WHERE key", rows: [] },
    { match: "DELETE FROM reserve_sync_state WHERE stablecoin_id", rows: [] },
    { match: "DELETE FROM reserve_composition WHERE stablecoin_id", rows: [] },
    { match: "DELETE FROM reserve_composition_history WHERE rowid IN", rows: [] },
    { match: "DELETE FROM reserve_sync_attempt_history WHERE rowid IN", rows: [] },
    { match: "FROM reserve_sync_state", rows: [] },
    { match: "FROM reserve_composition", rows: [] },
    { match: "INSERT INTO reserve_sync_state", rows: [] },
    { match: "UPDATE reserve_sync_state", rows: [] },
    { match: "INSERT INTO reserve_composition", rows: [] },
    { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [] },
    { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [] },
  ]);
}

function mockAdapterRegistry(
  fetchImpl: (
    coin?: (typeof ACTIVE_STABLECOINS)[number],
    config?: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>,
  ) => Promise<{
    slices: Array<{ name: string; pct: number; risk: "low" }>;
    metadata?: Record<string, unknown>;
    warnings?: Array<{ code: string; message: string; severity: "warning" | "info"; effect?: string }>;
  }>,
) {
  const fetch = vi.fn(async (coin: (typeof ACTIVE_STABLECOINS)[number], config: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>) => {
    const result = await fetchImpl(coin, config);
    return {
      ...result,
      metadata: result.metadata ?? { freshnessMode: "not-applicable" as const },
    };
  });
  getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
    const validation = "validation" in definition ? definition.validation : undefined;
    return {
      key: adapterKey,
      fetch,
      sourceModel: definition.sourceModel,
      evidenceClass: definition.evidenceClass,
      sharedSourceMode: definition.sharedSourceMode,
      ...(validation ? { validation } : {}),
    };
  });
  return fetch;
}

describe("reserve sync → API integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
  });

  describe("happy path: adapter → D1 → API resolution", () => {
    it("stores valid slices in D1 and records success in sync_state", async () => {
      const slices = [{ name: "US Treasuries", pct: 80, risk: "low" as const }, { name: "Cash", pct: 20, risk: "low" as const }];
      mockAdapterRegistry(async () => ({ slices }));

      const { syncLiveReserves } = await import("../sync-live-reserves");
      const db = reserveDb();
      const result = await syncLiveReserves(db, new AbortController().signal, {});

      // Sync completes successfully
      expect(result?.status).toBe("ok");
      expect(result?.itemCount).toBe(configuredCoins.length);

      // Composition data was written to D1
      const compositionWrites = db.getHistory().filter((e) => e.sql.includes("reserve_composition"));
      expect(compositionWrites.length).toBeGreaterThan(0);

      // Sync state was written to D1
      const syncStateWrites = db.getHistory().filter((e) => e.sql.includes("reserve_sync_state"));
      expect(syncStateWrites.length).toBeGreaterThan(0);

      // History pruning ran
      expect(db.getHistory().some((e) => e.sql.includes("DELETE FROM reserve_composition_history"))).toBe(true);

      // Breaker outcomes were recorded
      expect(recordOutcomeSafeMock).toHaveBeenCalled();
      for (const call of recordOutcomeSafeMock.mock.calls) {
        expect(call[2]).toBe(true); // success outcome
      }
    }, GATE_LOAD_TIMEOUT_MS);
  });

  describe("adapter failure → sync_state records error", () => {
    it("records adapter exception with failure details in sync attempt history", async () => {
      mockAdapterRegistry(async () => {
        throw new Error("HTTP 503 upstream unavailable");
      });

      const { syncLiveReserves } = await import("../sync-live-reserves");
      const db = reserveDb();
      const result = await syncLiveReserves(db, new AbortController().signal, {});

      // All coins failed
      expect(result?.status).toBe("error");
      expect(result?.itemCount).toBe(0);

      // Sync attempt history was written with error details
      const attemptWrites = db.getHistory().filter((e) => e.sql.includes("reserve_sync_attempt_history"));
      expect(attemptWrites.length).toBeGreaterThan(0);

      // Check that at least one attempt records the error message
      const hasErrorMetadata = attemptWrites.some((e) =>
        e.binds.some(
          (bind) => typeof bind === "string" && bind.includes("adapter-exception"),
        ),
      );
      expect(hasErrorMetadata).toBe(true);

      // Breaker outcomes record failure
      expect(recordOutcomeSafeMock).toHaveBeenCalled();
      for (const call of recordOutcomeSafeMock.mock.calls) {
        expect(call[2]).toBe(false); // failure outcome
      }
    });
  });

  describe("validation rejection: invalid adapter output not stored", () => {
    it("rejects slices with pct sum > 102 and does not write composition", async () => {
      // PCT_SUM_ERROR_TOLERANCE is 2, so sum > 102 is rejected
      mockAdapterRegistry(async () => ({
        slices: [
          { name: "Asset A", pct: 80, risk: "low" as const },
          { name: "Asset B", pct: 25, risk: "low" as const },
        ],
      }));

      const { syncLiveReserves } = await import("../sync-live-reserves");
      const db = reserveDb();
      const result = await syncLiveReserves(db, new AbortController().signal, {});

      expect(result?.status).toBe("error");
      expect(result?.itemCount).toBe(0);

      // Sync attempt history should mention validation-failed
      const attemptWrites = db.getHistory().filter((e) => e.sql.includes("reserve_sync_attempt_history"));
      const hasValidationFailure = attemptWrites.some((e) =>
        e.binds.some(
          (bind) => typeof bind === "string" && bind.includes("validation-failed"),
        ),
      );
      expect(hasValidationFailure).toBe(true);

      // No composition data should have been written for a validated insert
      // (beginReserveSyncAttempt writes to sync tables, but finalizeReserveSyncSuccess should NOT have been called)
      // The reserve_composition inserts only come from finalizeReserveSyncSuccess,
      // so we check that none of the composition writes contain actual slice data
      const compositionInserts = db.getHistory().filter(
        (e) => e.sql.includes("reserve_composition") && e.sql.includes("INSERT"),
      );
      // No INSERT into reserve_composition should contain our invalid slices
      const hasInvalidSlices = compositionInserts.some((e) =>
        e.binds.some((bind) => typeof bind === "string" && bind.includes("Asset A")),
      );
      expect(hasInvalidSlices).toBe(false);
    });
  });

  describe("shared-source cache: independent retry after failure", () => {
    it("retries source-invariant adapter independently after first failure", async () => {
      // Find a source-invariant adapter to test with
      const sourceInvariantAdapters = Object.entries(LIVE_RESERVE_ADAPTER_DEFINITIONS)
        .filter(([, def]) => def.sharedSourceMode === "source-invariant")
        .map(([key]) => key);

      // If no source-invariant adapters exist in config, skip
      if (sourceInvariantAdapters.length === 0) return;

      // Find coins using source-invariant adapters
      const sourceInvariantCoins = configuredCoins.filter(
        (coin) => coin.liveReservesConfig && sourceInvariantAdapters.includes(coin.liveReservesConfig.adapter),
      );

      if (sourceInvariantCoins.length < 2) return;

      // Track call count. The first call should fail, subsequent calls should succeed.
      // Because the .catch() cleanup deletes the cached promise on failure,
      // the second coin using the same source should retry independently.
      let callCount = 0;
      const adapterFetch = mockAdapterRegistry(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient network failure");
        }
        return { slices: [{ name: "Reserve", pct: 100, risk: "low" as const }] };
      });

      const { syncLiveReserves } = await import("../sync-live-reserves");
      const db = reserveDb();
      await syncLiveReserves(db, new AbortController().signal, {});

      // The adapter should have been called more than once — the cache eviction
      // on failure means subsequent coins retry the fetch independently.
      expect(adapterFetch).toHaveBeenCalledTimes(callCount);
      expect(callCount).toBeGreaterThan(1);
    });
  });
});
