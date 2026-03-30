import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

const getReserveAdapterMock = vi.fn();
const shouldAttemptFetchMock = vi.fn();
const recordOutcomeSafeMock = vi.fn();

vi.mock("../reserve-adapters/index", () => ({
  getReserveAdapter: getReserveAdapterMock,
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: shouldAttemptFetchMock,
  recordOutcomeSafe: recordOutcomeSafeMock,
}));

describe("syncLiveReserves", () => {
  const configuredCoinCount = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).length;
  const sharedSourceInvocationCount = ACTIVE_STABLECOINS
    .filter((coin) => coin.liveReservesConfig)
    .reduce((keys, coin) => {
      const config = coin.liveReservesConfig!;
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter];
      const primary = config.inputs.primary;
      if (
        definition.sharedSourceMode !== "source-invariant"
        || (primary.kind !== "http-json" && primary.kind !== "http-html")
      ) {
        keys.add(`coin:${coin.id}`);
        return keys;
      }

      keys.add(JSON.stringify({
        adapter: config.adapter,
        version: config.version,
        semantics: config.semantics,
        inputs: {
          primary,
          fallbacks: config.inputs.fallbacks ?? null,
        },
        params: config.params ?? null,
      }));
      return keys;
    }, new Set<string>())
    .size;

  function mockAdapterRegistry(
    fetchImpl: () => Promise<
      | {
          slices: Array<{ name: string; pct: number; risk: "low" }>;
          metadata?: Record<string, unknown>;
        }
      | {
          slices: Array<{ name: string; pct: number; risk: "low" }>;
          warnings: Array<{ code: string; message: string; severity: "warning" }>;
          metadata?: Record<string, unknown>;
        }
    >,
  ) {
    const fetch = vi.fn(async () => {
      const result = await fetchImpl();
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.doUnmock("../../lib/live-reserves-store");
    vi.resetModules();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
  });

  it("persists reserve snapshot + sync state and returns ok on a clean run", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(result?.status).toBe("ok");
    expect(result?.itemCount).toBe(configuredCoinCount);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_composition"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_sync_state"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM reserve_composition_history"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM reserve_sync_attempt_history"))).toBe(true);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, "live-reserves:infinifi", true);
    const uniqueBreakerKeyCount = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    ).size;
    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeyCount);
  });

  it("reuses identical shared HTTP reserve sources within a run", async () => {
    const adapterFetch = mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    expect(adapterFetch).toHaveBeenCalledTimes(sharedSourceInvocationCount);
    expect(sharedSourceInvocationCount).toBeLessThan(configuredCoinCount);
  });

  it("returns ok with warning metadata when the adapter yields warnings (warnings are metadata-only)", async () => {
    mockAdapterRegistry(
      async () => ({
        slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
        warnings: [{ code: "unknown-position", message: "Unmapped reserve position: new-farm", severity: "warning" as const }],
      }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as { warningCount?: number };

    // Warnings no longer affect status (only failed+skipped > 10% of total triggers degraded)
    expect(result?.status).toBe("ok");
    expect(metadata.warningCount).toBeGreaterThanOrEqual(configuredCoinCount);
  });

  it("records a skipped sync state when the circuit is open", async () => {
    shouldAttemptFetchMock.mockResolvedValue(false);
    mockAdapterRegistry(async () => {
      throw new Error("adapter should not run when circuit is open");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(result?.status).toBe("error");
    expect(result?.itemCount).toBe(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_sync_state"))).toBe(true);
    expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
  });

  it("records circuit breaker outcome only once per unique breakerKey per run", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const callsByKey = new Map<string, number>();
    for (const call of recordOutcomeSafeMock.mock.calls) {
      const key = call[1] as string;
      callsByKey.set(key, (callsByKey.get(key) ?? 0) + 1);
    }

    for (const [key, count] of callsByKey) {
      expect(count, `breakerKey "${key}" recorded ${count} times, expected 1`).toBe(1);
    }

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );
    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeys.size);
  });

  it("classifies parser drift in sync attempt metadata", async () => {
    mockAdapterRegistry(async () => {
      throw new Error("circle-transparency: layout-changed: missing reserve attributes");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const attemptInsert = db.getHistory().find((entry) => entry.sql.includes("reserve_sync_attempt_history"));
    expect(attemptInsert).toBeDefined();
    const metadataJson = attemptInsert!.binds[9] as string;
    expect(JSON.parse(metadataJson)).toMatchObject({
      reason: "adapter-exception",
      failureCategory: "parser-drift",
    });
  });

  it("records timed out write finalization as a non-authoritative storage failure", async () => {
    vi.useFakeTimers();
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const actualStore = await vi.importActual<typeof import("../../lib/live-reserves-store")>("../../lib/live-reserves-store");
    let finalizeCalls = 0;
    vi.doMock("../../lib/live-reserves-store", async () => ({
      ...actualStore,
      finalizeReserveSyncSuccess: vi.fn(async (...args: Parameters<typeof actualStore.finalizeReserveSyncSuccess>) => {
        finalizeCalls++;
        if (finalizeCalls === 1) {
          return await new Promise<Awaited<ReturnType<typeof actualStore.finalizeReserveSyncSuccess>>>(() => undefined);
        }
        return actualStore.finalizeReserveSyncSuccess(...args);
      }),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const runPromise = syncLiveReserves(db, new AbortController().signal, {});

    await vi.advanceTimersByTimeAsync(30_100);
    const result = await runPromise;

    expect(result?.itemCount).toBe(configuredCoinCount - 1);
    const timeoutAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("storage-write-timeout"))
    ));
    expect(timeoutAttempt).toBeDefined();
  });

  it("reports per-coin progress through the cron progress hook", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const reportProgress = vi.fn(async (_update: unknown) => undefined);
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {}, reportProgress as never);

    expect(reportProgress).toHaveBeenCalled();
    const progressCalls = reportProgress.mock.calls as Array<[{
      stage?: string | null;
      itemsDone?: number | null;
      itemsTotal?: number | null;
      message?: string | null;
      metadata?: Record<string, unknown> | null;
    }]>;

    expect(progressCalls[0]?.[0]).toMatchObject({
      stage: "setup",
      itemsDone: 0,
      itemsTotal: configuredCoinCount,
      message: "Loaded live reserve sync state",
    });
    expect(progressCalls.some(([update]) => (
      update.stage === "syncing"
      && typeof update.metadata?.currentCoinId === "string"
      && typeof update.metadata?.currentAdapter === "string"
      && typeof update.metadata?.currentBreakerKey === "string"
    ))).toBe(true);
    const finalUpdate = progressCalls[progressCalls.length - 1]?.[0];
    expect(finalUpdate).toMatchObject({
      stage: "finalizing",
      itemsDone: configuredCoinCount,
      itemsTotal: configuredCoinCount,
    });
  });
});
