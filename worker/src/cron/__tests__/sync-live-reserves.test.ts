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
    fetchImpl: (
      coin?: (typeof ACTIVE_STABLECOINS)[number],
      config?: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>,
    ) => Promise<
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
    const fetch = vi.fn(async (coin, config) => {
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

  it("issues a single atomic batch of NOT IN DELETEs covering state, composition, and cache", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();

    await syncLiveReserves(db, new AbortController().signal, {});

    const deleteStateRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM reserve_sync_state WHERE stablecoin_id NOT IN")
    ));
    expect(deleteStateRows).toHaveLength(1);
    expect(deleteStateRows[0]?.binds.length).toBe(configuredCoinCount);

    const deleteCompositionRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM reserve_composition WHERE stablecoin_id NOT IN")
    ));
    expect(deleteCompositionRows).toHaveLength(1);
    expect(deleteCompositionRows[0]?.binds.length).toBe(configuredCoinCount);

    const deleteCacheRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM cache WHERE key LIKE 'circuit:live-reserves:%' AND key NOT IN")
    ));
    expect(deleteCacheRows).toHaveLength(1);

    // Per-row DELETE FROM reserve_sync_state WHERE stablecoin_id = ? must be gone.
    expect(
      db.getHistory().some((entry) => (
        entry.sql.includes("DELETE FROM reserve_sync_state WHERE stablecoin_id = ?")
      )),
    ).toBe(false);
  });

  it("persists a deferred cursor on budget exhaustion and resumes from that coin on the next run", async () => {
    const configuredIds = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).map((coin) => coin.id);
    let nowMs = 0;
    let activeRun = 1;
    const visitedByRun = new Map<number, string[]>();

    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockAdapterRegistry(async (coin) => {
      const visited = visitedByRun.get(activeRun) ?? [];
      visited.push(coin?.id ?? "unknown");
      visitedByRun.set(activeRun, visited);
      if (activeRun === 1 && visited.length === 1) {
        nowMs = 11 * 60 * 1000;
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();

    const firstRun = await syncLiveReserves(db, new AbortController().signal, {});
    const firstRunMetadata = JSON.parse(firstRun?.metadata ?? "{}") as {
      deferredCoins?: number;
      nextCursorStablecoinId?: string | null;
    };
    const cursorWrite = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "live-reserves:run-cursor"
    );

    expect(firstRunMetadata).toMatchObject({
      deferredCoins: configuredCoinCount - 1,
      nextCursorStablecoinId: configuredIds[1],
    });
    expect(cursorWrite).toBeDefined();

    activeRun = 2;
    nowMs = 0;
    const cursorValue = cursorWrite?.binds[1];
    const resumedDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["live-reserves:run-cursor"],
        rows: [],
        first: {
          value: cursorValue,
          updated_at: 0,
        },
      },
    ]);
    await syncLiveReserves(resumedDb, new AbortController().signal, {});

    expect(visitedByRun.get(1)?.[0]).toBe(configuredIds[0]);
    expect(visitedByRun.get(2)?.[0]).toBe(firstRunMetadata.nextCursorStablecoinId);
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

    // Regression: a storage-write-timeout must produce exactly ONE attempt-history row
    // for the timed-out coin, not a second success-finalize-rejected row on top.
    const timedOutCoinId = timeoutAttempt!.binds[0];
    const attemptsForTimedOutCoin = db.getHistory().filter((entry) => (
      entry.sql.includes("INSERT INTO reserve_sync_attempt_history")
      && entry.binds[0] === timedOutCoinId
    ));
    expect(attemptsForTimedOutCoin).toHaveLength(1);
    const duplicateFinalizeRejected = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT INTO reserve_sync_attempt_history")
      && entry.binds[0] === timedOutCoinId
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("success-finalize-rejected"))
    ));
    expect(duplicateFinalizeRejected).toBeUndefined();
  });

  it("emits durationMs in reserve_composition metadata for successful syncs", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const compositionInsert = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT INTO reserve_composition (")
    ));
    expect(compositionInsert).toBeDefined();
    // metadata is the 6th bound column per buildReserveCompositionUpsertStatement (0-indexed 5).
    const metadataJson = compositionInsert!.binds[5] as string;
    const metadata = JSON.parse(metadataJson) as { durationMs?: number };
    expect(typeof metadata.durationMs).toBe("number");
    expect(metadata.durationMs!).toBeGreaterThanOrEqual(0);
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

  it("defers remaining coins when the per-run budget is exhausted", async () => {
    vi.useFakeTimers();
    const nowBase = Date.now();
    vi.setSystemTime(nowBase);

    // Each adapter invocation advances the clock by 6 minutes so that after 2
    // coins (>= 12min > 11min budget), the budget guard kicks in.
    mockAdapterRegistry(async () => {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const resultPromise = syncLiveReserves(db, new AbortController().signal, {});
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const metadata = JSON.parse(result?.metadata ?? "{}") as { skipped?: number; synced?: number };
    expect(metadata.skipped).toBeGreaterThan(0);
    expect(metadata.synced).toBeLessThan(configuredCoinCount);

    const deferredInserts = db.getHistory().filter((entry) => (
      entry.sql.includes("INSERT INTO reserve_sync_state")
      && entry.binds.some(
        (bind) => typeof bind === "string" && bind === "run-budget-exhausted",
      )
    ));
    expect(deferredInserts.length).toBeGreaterThan(0);

    // The deferred statement must never set pending_attempt_id — it binds its
    // values in positional order (stablecoinId, adapterKey, breakerKey,
    // attemptedAt, reason, metadata) and the SQL pins pending_attempt_id to NULL.
    for (const entry of deferredInserts) {
      expect(entry.sql).toMatch(/pending_attempt_id\s*=\s*NULL/);
    }
  });

  it("retains shared source-cache failures for the run so a single fetch satisfies every sharing coin", async () => {
    // m0 has >=2 coins sharing the same source-invariant primary URL.
    const m0Coins = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig?.adapter === "m0");
    expect(m0Coins.length).toBeGreaterThanOrEqual(2);
    const sharedM0Primary = m0Coins[0]!.liveReservesConfig!.inputs.primary;
    expect(sharedM0Primary.kind).toMatch(/^http-json|http-html$/);

    const adapterFetch = mockAdapterRegistry(async (_coin, config) => {
      const primary = config?.inputs.primary;
      if (
        config?.adapter === "m0"
        && primary
        && (primary.kind === "http-json" || primary.kind === "http-html")
        && "url" in primary
        && "url" in sharedM0Primary
        && primary.url === sharedM0Primary.url
      ) {
        throw new Error("m0 upstream boom");
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const m0FetchCalls = adapterFetch.mock.calls.filter((call) => {
      const config = call[1] as NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]> | undefined;
      const primary = config?.inputs.primary;
      return (
        config?.adapter === "m0"
        && primary
        && (primary.kind === "http-json" || primary.kind === "http-html")
        && "url" in primary
        && "url" in sharedM0Primary
        && primary.url === sharedM0Primary.url
      );
    });
    expect(m0FetchCalls.length).toBe(1);
  });

  it("emits a primary-fallback-used info warning when the fallback succeeds", async () => {
    const fallbackCoin = ACTIVE_STABLECOINS.find((coin) => (
      (coin.liveReservesConfig?.inputs.fallbacks?.length ?? 0) > 0
      && coin.liveReservesConfig?.inputs.primary.kind === "http-json"
      && coin.liveReservesConfig.inputs.primary.url.includes("chain=tron")
    ));
    expect(fallbackCoin).toBeDefined();

    mockAdapterRegistry(async (_coin, config) => {
      const currentInput = config?.inputs.primary;
      if (!currentInput || (currentInput.kind !== "http-json" && currentInput.kind !== "http-html")) {
        throw new Error("unexpected input kind");
      }
      if (currentInput.url.includes("chain=tron")) {
        throw new Error("primary source down");
      }
      return { slices: [{ name: "Tracked vaults", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const successAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT INTO reserve_composition_history")
      && entry.binds[0] === fallbackCoin!.id
    ));
    expect(successAttempt).toBeDefined();

    const warningsJson = successAttempt!.binds[6] as string | null;
    expect(typeof warningsJson).toBe("string");
    const parsed = JSON.parse(warningsJson!) as Array<{ code?: string; effect?: string; severity?: string }>;
    const fallbackInfo = parsed.find((w) => w.code === "primary-fallback-used");
    expect(fallbackInfo).toBeDefined();
    expect(fallbackInfo!.effect).toBe("info");
    expect(fallbackInfo!.severity).toBe("info");
  });

  it("persists full primary-plus-fallback failure context for reserve source chains", async () => {
    const fallbackCoin = ACTIVE_STABLECOINS.find((coin) => (
      (coin.liveReservesConfig?.inputs.fallbacks?.length ?? 0) > 0
      && coin.liveReservesConfig?.inputs.primary.kind === "http-json"
      && coin.liveReservesConfig.inputs.primary.url.includes("chain=tron")
    ));
    expect(fallbackCoin).toBeDefined();

    mockAdapterRegistry(async (_coin, config) => {
      const currentInput = config?.inputs.primary;
      if (!currentInput || (currentInput.kind !== "http-json" && currentInput.kind !== "http-html")) {
        throw new Error("unexpected input kind");
      }
      if (currentInput.url.includes("chain=tron")) {
        throw new Error("primary reserve source failed");
      }
      throw new Error("fallback reserve source failed");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const fallbackAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.includes(fallbackCoin!.id)
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("\"attemptSummaries\""))
    ));
    expect(fallbackAttempt).toBeDefined();

    const metadataJson = fallbackAttempt!.binds.find((bind): bind is string => (
      typeof bind === "string" && bind.includes("\"attemptSummaries\"")
    ));
    expect(metadataJson).toBeDefined();
    expect(JSON.parse(metadataJson!)).toMatchObject({
      reason: "adapter-exception",
      attemptSummaries: [
        {
          source: "primary",
          label: "primary:http-json",
          message: "primary reserve source failed",
        },
        {
          source: "fallback",
          label: "fallback#1:http-json",
          message: "fallback reserve source failed",
        },
      ],
    });
  });

});

describe("buildSharedSourceCacheKey", () => {
  it("produces the same key regardless of key insertion order", async () => {
    const { buildSharedSourceCacheKey } = await import("../sync-live-reserves-shared");

    const adapter = {
      key: "mento",
      fetch: async () => ({ slices: [] }),
      sourceModel: "dynamic-mix",
      evidenceClass: "independent",
      sharedSourceMode: "source-invariant",
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[1];

    const configA = {
      adapter: "mento",
      version: 1,
      semantics: "bucketed-collateral-mix",
      inputs: {
        primary: { kind: "http-json", url: "https://example.com/api" },
        fallbacks: [{ kind: "http-json", url: "https://example.com/backup" }],
      },
      params: { chain: "celo", foo: "bar" },
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];

    const configB = {
      params: { foo: "bar", chain: "celo" },
      inputs: {
        fallbacks: [{ url: "https://example.com/backup", kind: "http-json" }],
        primary: { url: "https://example.com/api", kind: "http-json" },
      },
      semantics: "bucketed-collateral-mix",
      version: 1,
      adapter: "mento",
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];

    const keyA = buildSharedSourceCacheKey(configA, adapter);
    const keyB = buildSharedSourceCacheKey(configB, adapter);

    expect(keyA).toBeDefined();
    expect(keyA).toEqual(keyB);
  });
});
