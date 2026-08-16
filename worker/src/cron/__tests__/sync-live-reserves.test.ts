import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { mockD1 as createMockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildChainRpcs } from "../../lib/chain-registry";
import { LIVE_RESERVE_RUN_CURSOR_CACHE_KEY } from "../../lib/operational-cache-keys";
import { LIVE_RESERVE_QUEUE_HASH, SYNC_ORDERED_CONFIGURED_COINS } from "../sync-live-reserves-shared";
import type { ReserveAdapterDefinition } from "../reserve-adapters/index";

const DEFAULT_LIVE_RESERVE_D1_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "FROM reserve_sync_state", rows: [] },
  { match: "FROM reserve_composition", rows: [] },
  { match: "FROM reserve_sync_attempts", rows: [] },
  { match: "INSERT INTO reserve_sync_state", rows: [] },
  { match: "UPDATE reserve_sync_state", rows: [] },
  { match: "INSERT INTO reserve_composition", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [] },
  { match: "INSERT INTO reserve_sync_attempts", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [] },
  { match: "SELECT key, value FROM cache WHERE key IN", rows: [] },
  { match: "SELECT key, value FROM cache WHERE key LIKE 'circuit:%'", rows: [] },
  { match: "SELECT key FROM cache WHERE key LIKE", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
  { match: "DELETE FROM cache", rows: [] },
  { match: "DELETE FROM reserve_composition_history", rows: [] },
  { match: "DELETE FROM reserve_sync_attempt_history", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_LIVE_RESERVE_D1_TABLES]);
}

const getReserveAdapterMock = vi.fn();
const shouldAttemptFetchMock = vi.fn();
const recordOutcomeSafeMock = vi.fn();
const recoverNoCandidateMock = vi.fn();

vi.mock("../reserve-adapters/index", () => ({
  getReserveAdapter: getReserveAdapterMock,
}));

vi.mock("../../lib/circuit-breaker", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/circuit-breaker")>();
  return {
    ...original,
    shouldAttemptFetch: shouldAttemptFetchMock,
    recordOutcomeSafe: recordOutcomeSafeMock,
    recoverBreakerOnNoCandidate: recoverNoCandidateMock,
  };
});

describe("syncLiveReserves", () => {
  type ConfiguredCoin = (typeof ACTIVE_STABLECOINS)[number] & {
    liveReservesConfig: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>;
  };

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

  function getIndependentConfiguredCoin(): ConfiguredCoin {
    const coin = ACTIVE_STABLECOINS.find((candidate) => {
      const config = candidate.liveReservesConfig;
      if (!config) return false;
      return LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter]?.evidenceClass === "independent";
    });
    expect(coin).toBeDefined();
    return coin as ConfiguredCoin;
  }

  function adapterForCoin(coin: ConfiguredCoin): ReserveAdapterDefinition {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[coin.liveReservesConfig.adapter];
    const validation = "validation" in definition ? definition.validation : undefined;
    return {
      key: coin.liveReservesConfig.adapter,
      fetch: vi.fn(),
      sourceModel: definition.sourceModel,
      evidenceClass: definition.evidenceClass,
      sharedSourceMode: definition.sharedSourceMode,
      ...(validation ? { validation } : {}),
    };
  }

  function buildPreviousLiveReserveRows(args: {
    coin: ConfiguredCoin;
    lastStatus: "ok" | "degraded" | "error" | "skipped";
    lastAttemptedAt: number;
    lastSuccessAt: number;
    lastError?: string | null;
    failureCategory?: string;
  }) {
    const adapterDefinition = LIVE_RESERVE_ADAPTER_DEFINITIONS[args.coin.liveReservesConfig.adapter];
    const lastSuccessAttemptId = `${args.coin.id}:previous-success`;
    return {
      syncState: {
        stablecoin_id: args.coin.id,
        adapter_key: args.coin.liveReservesConfig.adapter,
        breaker_key: `live-reserves:${args.coin.liveReservesConfig.breakerScope ?? args.coin.liveReservesConfig.adapter}`,
        last_attempted_at: args.lastAttemptedAt,
        last_success_at: args.lastSuccessAt,
        last_status: args.lastStatus,
        warning_count: 0,
        warnings: null,
        last_error: args.lastError ?? null,
        metadata: JSON.stringify(args.failureCategory ? { failureCategory: args.failureCategory } : {}),
        last_attempt_id: `${args.coin.id}:latest-attempt`,
        pending_attempt_id: null,
        last_success_attempt_id: lastSuccessAttemptId,
      },
      composition: {
        stablecoin_id: args.coin.id,
        slices: JSON.stringify([{ name: "Prior verified reserves", pct: 100, risk: "low" }]),
        fetched_at: args.lastSuccessAt,
        source: args.coin.liveReservesConfig.adapter,
        attempt_id: lastSuccessAttemptId,
        metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
        warning_count: 0,
        warnings: null,
        adapter_source_model: adapterDefinition.sourceModel,
        adapter_evidence_class: adapterDefinition.evidenceClass,
      },
    };
  }

  function dbWithPreviousLiveReserveRows(rows: ReturnType<typeof buildPreviousLiveReserveRows>) {
    return mockD1([
      {
        match: "FROM reserve_sync_state",
        rows: [rows.syncState],
        first: rows.syncState,
      },
      {
        match: "FROM reserve_composition",
        rows: [rows.composition],
        first: rows.composition,
      },
    ]);
  }

  async function expectFailureAttemptDoesNotRewriteLastSuccess(args: {
    coin: ConfiguredCoin;
    error: Error;
    previousLastSuccessAt: number;
    previousLastSuccessAttemptId: string;
  }) {
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockD1();
    const result = await syncReserveCoin({
      db,
      coin: args.coin,
      signal: new AbortController().signal,
      adapter: adapterForCoin(args.coin),
      runAdapter: async () => {
        throw args.error;
      },
      breakerCanFetch: new Map([[`live-reserves:${args.coin.liveReservesConfig.breakerScope ?? args.coin.liveReservesConfig.adapter}`, true]]),
      d1FinalizeTimeoutMs: 30_000,
      previousState: {
        stablecoinId: args.coin.id,
        adapterKey: args.coin.liveReservesConfig.adapter,
        breakerKey: `live-reserves:${args.coin.liveReservesConfig.breakerScope ?? args.coin.liveReservesConfig.adapter}`,
        lastAttemptedAt: args.previousLastSuccessAt,
        lastSuccessAt: args.previousLastSuccessAt,
        lastStatus: "ok",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: {},
        lastAttemptId: args.previousLastSuccessAttemptId,
        pendingAttemptId: null,
        lastSuccessAttemptId: args.previousLastSuccessAttemptId,
      },
    });

    expect(result.status).toBe("failed");
    const finalizeFailure = db.getHistory().find((entry) => (
      entry.sql.includes("UPDATE reserve_sync_state")
      && entry.sql.includes("last_status = ?")
      && entry.binds.includes("error")
    ));
    expect(finalizeFailure).toBeDefined();
    expect(finalizeFailure!.sql).not.toMatch(/last_success_at\s*=/);
    expect(finalizeFailure!.sql).not.toMatch(/last_success_attempt_id\s*=/);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.doUnmock("../../lib/live-reserves-store");
    vi.resetModules();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
    recoverNoCandidateMock.mockClear();
  });

  it("keeps public RPC live-reserve inputs resolvable", () => {
    const chainRpcs = buildChainRpcs();
    const missingRpc = ACTIVE_STABLECOINS
      .filter((coin) => {
        const primary = coin.liveReservesConfig?.inputs.primary;
        return primary?.kind === "onchain-evm" && primary.rpcMode === "public-rpc";
      })
      .filter((coin) => {
        const config = coin.liveReservesConfig!;
        const primary = config.inputs.primary;
        if (primary.kind !== "onchain-evm") return false;

        const params = config.params;
        const explicitRpcUrl = typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as { rpcUrl?: unknown }).rpcUrl
          : undefined;

        return !chainRpcs.has(primary.chain)
          && !(typeof explicitRpcUrl === "string" && explicitRpcUrl.length > 0);
      })
      .map((coin) => {
        const primary = coin.liveReservesConfig!.inputs.primary;
        return primary.kind === "onchain-evm" ? `${coin.id}:${primary.chain}` : coin.id;
      });

    expect(missingRpc).toEqual([]);
  });

  it("refuses a recovery suffix when the configured queue hash changed", async () => {
    const checkpointIdentity = {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      job: "sync-live-reserves",
      attemptNo: 2,
      executionGeneration: 2,
      invocationId: "recovery-owner",
    };
    const db = mockD1([{
      match: "FROM worker_scheduled_checkpoints",
      rows: [{
        schedule_key: checkpointIdentity.scheduleKey,
        slot_started_at: checkpointIdentity.slotStartedAt,
        job: checkpointIdentity.job,
        attempt_no: checkpointIdentity.attemptNo,
        execution_generation: checkpointIdentity.executionGeneration,
        invocation_id: checkpointIdentity.invocationId,
        worker_version: "version-a",
        queue_hash: "stale-queue-hash",
        state: "recovering",
        next_item_key: SYNC_ORDERED_CONFIGURED_COINS[0]?.id ?? null,
        current_item_key: null,
        current_domain_attempt_id: null,
        items_done: 0,
        items_total: SYNC_ORDERED_CONFIGURED_COINS.length,
        child_dispositions_json: "{}",
        recovery_owner: checkpointIdentity.invocationId,
        recovery_lease_until: 2_000,
        source_attempt_no: 1,
        error: null,
        created_at: 1_000,
        updated_at: 1_100,
        completed_at: null,
      }],
    }]);
    const { syncLiveReserves } = await import("../sync-live-reserves");

    await expect(syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      undefined,
      checkpointIdentity,
    )).rejects.toThrow("refusing unsafe suffix replay");
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it("repairs crash-omitted history before advancing an authoritative item on retry", async () => {
    const lastCoin = SYNC_ORDERED_CONFIGURED_COINS[SYNC_ORDERED_CONFIGURED_COINS.length - 1];
    expect(lastCoin).toBeDefined();
    const checkpointIdentity = {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 2_000,
      job: "sync-live-reserves",
      attemptNo: 2,
      executionGeneration: 2,
      invocationId: "recovery-owner",
    };
    const checkpointAdvanceError = new Error("checkpoint advance interrupted");
    const checkpointAdvanceConfig: MockTableConfig = {
      match: "items_done = ?",
      rows: [],
      throwError: checkpointAdvanceError,
    };
    const db = mockD1([
      {
        match: "FROM worker_scheduled_checkpoints",
        rows: [{
          schedule_key: checkpointIdentity.scheduleKey,
          slot_started_at: checkpointIdentity.slotStartedAt,
          job: checkpointIdentity.job,
          attempt_no: checkpointIdentity.attemptNo,
          execution_generation: checkpointIdentity.executionGeneration,
          invocation_id: checkpointIdentity.invocationId,
          worker_version: "version-a",
          queue_hash: LIVE_RESERVE_QUEUE_HASH,
          state: "recovering",
          next_item_key: lastCoin!.id,
          current_item_key: lastCoin!.id,
          current_domain_attempt_id: "authoritative-attempt",
          items_done: SYNC_ORDERED_CONFIGURED_COINS.length - 1,
          items_total: SYNC_ORDERED_CONFIGURED_COINS.length,
          child_dispositions_json: "{}",
          recovery_owner: checkpointIdentity.invocationId,
          recovery_lease_until: 3_000,
          source_attempt_no: 1,
          error: null,
          created_at: 2_000,
          updated_at: 2_100,
          completed_at: null,
        }],
      },
      {
        match: "FROM reserve_composition c",
        rows: [{ finalized: 1, repaired: 1 }],
      },
      checkpointAdvanceConfig,
    ]);
    const { syncLiveReserves } = await import("../sync-live-reserves");

    await expect(syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      undefined,
      checkpointIdentity,
    )).rejects.toBe(checkpointAdvanceError);

    delete checkpointAdvanceConfig.throwError;
    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      undefined,
      checkpointIdentity,
    );

    expect(getReserveAdapterMock).not.toHaveBeenCalled();
    expect(result?.itemCount).toBe(0);
    const history = db.getHistory();
    const checkpointAdvances = history.filter((entry) => (
      entry.sql.includes("UPDATE worker_scheduled_checkpoints")
      && entry.sql.includes("items_done = ?")
    ));
    expect(checkpointAdvances).toHaveLength(2);
    expect(checkpointAdvances[1]?.binds.slice(0, 2)).toEqual([
      null,
      SYNC_ORDERED_CONFIGURED_COINS.length,
    ]);
    const compositionRepairs = history.filter((entry) => (
      entry.sql.includes("INSERT OR IGNORE INTO reserve_composition_history")
      && entry.sql.includes("SELECT c.stablecoin_id")
    ));
    const attemptRepairs = history.filter((entry) => (
      entry.sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history")
      && entry.sql.includes("SELECT s.stablecoin_id")
    ));
    expect(compositionRepairs).toHaveLength(2);
    expect(attemptRepairs).toHaveLength(2);
    for (let index = 0; index < checkpointAdvances.length; index += 1) {
      const advanceIndex = history.indexOf(checkpointAdvances[index]!);
      expect(history.indexOf(compositionRepairs[index]!)).toBeLessThan(advanceIndex);
      expect(history.indexOf(attemptRepairs[index]!)).toBeLessThan(advanceIndex);
    }
  });

  it("persists reserve snapshot + sync state and returns ok on a clean run", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      artifactCleanup?: {
        syncStateDeleted?: number;
        compositionDeleted?: number;
        breakerCacheDeleted?: number;
      } | null;
      artifactCleanupWarningCount?: number;
    };

    expect(result?.status).toBe("ok");
    expect(result?.itemCount).toBe(configuredCoinCount);
    expect(metadata.artifactCleanup).toEqual({
      syncStateDeleted: 0,
      compositionDeleted: 0,
      breakerCacheDeleted: 0,
    });
    expect(metadata.artifactCleanupWarningCount).toBe(0);
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

  it("keeps cursor cleanup best-effort and records a durable warning event", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "DELETE FROM cache WHERE key = ?",
        matchBinds: [LIVE_RESERVE_RUN_CURSOR_CACHE_KEY],
        rows: [],
        throwError: new Error("cursor delete unavailable"),
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      cursorPersistFailed?: boolean;
      cursorPersistError?: string;
    };

    expect(result?.status).toBe("ok");
    expect(metadata).toMatchObject({
      cursorPersistFailed: true,
      cursorPersistError: "cursor delete unavailable",
    });
    const cursorEvent = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-cursor-finalize-failed"
    ));
    expect(cursorEvent).toBeDefined();
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

  it("records a skipped sync state and reports degraded (not error) when the circuit holds every coin", async () => {
    shouldAttemptFetchMock.mockResolvedValue(false);
    mockAdapterRegistry(async () => {
      throw new Error("adapter should not run when circuit is open");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    // An all-circuit-open run synced nothing but had no genuine failures and no
    // budget-deferred tail; this is healthy recovery behavior, surfaced as
    // "degraded" rather than masked as "error".
    expect(result?.status).toBe("degraded");
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

  it("skips closed success breaker heartbeats but still records failed outcomes", async () => {
    const firstQueuedCoin = SYNC_ORDERED_CONFIGURED_COINS[0]!;
    const failedBreakerKey = `live-reserves:${
      firstQueuedCoin.liveReservesConfig!.breakerScope ?? firstQueuedCoin.liveReservesConfig!.adapter
    }`;
    mockAdapterRegistry(async (coin) => {
      if (coin?.id === firstQueuedCoin.id) {
        throw new Error("forced reserve source outage");
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );
    const closedBreakerRows = Array.from(uniqueBreakerKeys, (key) => ({
      key: `circuit:${key}`,
      value: JSON.stringify({
        state: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: 1_700_000_000,
        openedAt: null,
      }),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT key, value FROM cache WHERE key IN",
        rows: closedBreakerRows,
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomesSkippedClosedSuccess?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(1);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, failedBreakerKey, false);
    expect(metadata.breakerOutcomesRecorded).toBe(1);
    expect(metadata.breakerOutcomesSkippedClosedSuccess).toBe(uniqueBreakerKeys.size - 1);
  });

  it("records success breaker outcomes that still need state recovery", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const uniqueBreakerKeys = Array.from(new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    ));
    const keysNeedingRecovery = new Set(uniqueBreakerKeys.slice(0, 4));
    const [halfOpenKey, failureDebtKey, missingSuccessKey, lingeringOpenedKey] = uniqueBreakerKeys;
    const closedBreakerRows = uniqueBreakerKeys.map((key) => {
      let record = {
        state: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null as number | null,
        lastSuccessAt: 1_700_000_000 as number | null,
        openedAt: null as number | null,
      };
      if (key === halfOpenKey) {
        record = { ...record, state: "half-open", consecutiveFailures: 2, lastFailureAt: 1_699_999_990, openedAt: 1_699_999_990 };
      } else if (key === failureDebtKey) {
        record = { ...record, consecutiveFailures: 2, lastFailureAt: 1_699_999_990 };
      } else if (key === missingSuccessKey) {
        record = { ...record, lastSuccessAt: null };
      } else if (key === lingeringOpenedKey) {
        record = { ...record, openedAt: 1_699_999_990 };
      }
      return {
        key: `circuit:${key}`,
        value: JSON.stringify(record),
      };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT key, value FROM cache WHERE key IN",
        rows: closedBreakerRows,
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomesSkippedClosedSuccess?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(keysNeedingRecovery.size);
    for (const key of keysNeedingRecovery) {
      expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, key, true);
    }
    expect(metadata.breakerOutcomesRecorded).toBe(keysNeedingRecovery.size);
    expect(metadata.breakerOutcomesSkippedClosedSuccess).toBe(uniqueBreakerKeys.length - keysNeedingRecovery.size);
  });

  it("falls back to per-outcome breaker writes when the bulk breaker read fails", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT key, value FROM cache WHERE key IN",
        rows: [],
        throwError: new Error("bulk breaker read unavailable"),
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomesSkippedClosedSuccess?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeys.size);
    expect(metadata.breakerOutcomesRecorded).toBe(uniqueBreakerKeys.size);
    expect(metadata.breakerOutcomesSkippedClosedSuccess).toBe(0);
    expect(db.getHistory().some((entry) => (
      entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-breaker-bulk-read-failed"
    ))).toBe(true);
  });

  it("skips breaker outcome writes when finalization tail budget is exhausted", async () => {
    let nowMs = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockAdapterRegistry(async () => {
      nowMs += 10_000;
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    try {
      const { syncLiveReserves } = await import("../sync-live-reserves");
      const db = mockD1();
      const result = await syncLiveReserves(
        db,
        new AbortController().signal,
        {},
        undefined,
        {
          runBudgetMs: 5_000,
          adapterTimeoutMs: 1,
          d1FinalizeTimeoutMs: 1,
          finalizationMarginMs: 1,
        },
      );
      const metadata = JSON.parse(result?.metadata ?? "{}") as {
        breakerOutcomeBudgetExhausted?: boolean;
        breakerOutcomesRecorded?: number;
        breakerOutcomesSkippedBudget?: number;
        staleBreakerRecoveriesSkipped?: number;
      };

      expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
      expect(metadata.breakerOutcomeBudgetExhausted).toBe(true);
      expect(metadata.breakerOutcomesRecorded).toBe(0);
      expect(metadata.breakerOutcomesSkippedBudget).toBe(1);
      expect(metadata.staleBreakerRecoveriesSkipped).toBe(1);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("cleans stale reserve artifacts by deleting only rows outside the active keep-list", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT stablecoin_id FROM reserve_sync_state",
        rows: [
          { stablecoin_id: "stale-sync-state" },
          { stablecoin_id: ACTIVE_STABLECOINS.find((coin) => coin.liveReservesConfig)?.id },
        ],
      },
      {
        match: "SELECT stablecoin_id FROM reserve_composition",
        rows: [
          { stablecoin_id: "stale-composition" },
          { stablecoin_id: ACTIVE_STABLECOINS.find((coin) => coin.liveReservesConfig)?.id },
        ],
      },
      {
        match: "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'",
        rows: [
          { key: "circuit:live-reserves:stale-breaker" },
          { key: "circuit:live-reserves:infinifi" },
        ],
      },
    ]);

    await syncLiveReserves(db, new AbortController().signal, {});

    const deleteStateRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM reserve_sync_state WHERE stablecoin_id IN")
    ));
    expect(deleteStateRows).toHaveLength(1);
    expect(deleteStateRows[0]?.binds).toEqual(["stale-sync-state"]);

    const deleteCompositionRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM reserve_composition WHERE stablecoin_id IN")
    ));
    expect(deleteCompositionRows).toHaveLength(1);
    expect(deleteCompositionRows[0]?.binds).toEqual(["stale-composition"]);

    const deleteCacheRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM cache WHERE key IN")
    ));
    expect(deleteCacheRows).toHaveLength(1);
    expect(deleteCacheRows[0]?.binds).toEqual(["circuit:live-reserves:stale-breaker"]);

    // Per-row DELETE FROM reserve_sync_state WHERE stablecoin_id = ? must be gone.
    expect(
      db.getHistory().some((entry) => (
        entry.sql.includes("DELETE FROM reserve_sync_state WHERE stablecoin_id = ?")
      )),
    ).toBe(false);
  });

  it("keeps stale artifact cleanup best-effort and records warning metadata", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const actualStore = await vi.importActual<typeof import("../../lib/live-reserves-store")>("../../lib/live-reserves-store");
    vi.doMock("../../lib/live-reserves-store", async () => ({
      ...actualStore,
      cleanupStaleLiveReserveArtifacts: vi.fn(async () => {
        throw new Error("artifact cleanup unavailable");
      }),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      artifactCleanup?: unknown;
      artifactCleanupWarningCount?: number;
      artifactCleanupWarnings?: Array<{ eventType?: string; message?: string; error?: string }>;
    };

    expect(result?.status).toBe("ok");
    expect(metadata.artifactCleanup).toBeNull();
    expect(metadata.artifactCleanupWarningCount).toBe(1);
    expect(metadata.artifactCleanupWarnings).toEqual([
      {
        eventType: "live-reserve-artifact-cleanup-failed",
        message: "Ghost live-reserve artifact cleanup failed.",
        error: "artifact cleanup unavailable",
      },
    ]);
    const cleanupEvent = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-artifact-cleanup-failed"
    ));
    expect(cleanupEvent).toBeDefined();
  });

  it("persists a deferred cursor on budget exhaustion and resumes from that coin on the next run", async () => {
    // The sync queue is evidence-class ordered, so expectations follow the
    // ordered queue rather than raw registry order.
    const configuredIds = SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id);
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
      cursorTailState?: string | null;
      cursorRecordedAt?: number | null;
      cursorTailCompletedAt?: number | null;
      runBudgetTruncationCount?: number;
    };
    const cursorWrites = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === LIVE_RESERVE_RUN_CURSOR_CACHE_KEY
    );

    expect(firstRunMetadata).toMatchObject({
      deferredCoins: configuredCoinCount - 1,
      nextCursorStablecoinId: configuredIds[1],
      cursorTailState: "complete",
      runBudgetTruncationCount: 1,
    });
    expect(typeof firstRunMetadata.cursorRecordedAt).toBe("number");
    expect(typeof firstRunMetadata.cursorTailCompletedAt).toBe("number");
    expect(cursorWrites).toHaveLength(2);
    expect(JSON.parse(cursorWrites[0]?.binds[1] as string)).toMatchObject({
      nextStablecoinId: configuredIds[1],
      deferredCount: configuredCoinCount - 1,
      tailState: "recording",
    });
    expect(JSON.parse(cursorWrites[1]?.binds[1] as string)).toMatchObject({
      nextStablecoinId: configuredIds[1],
      deferredCount: configuredCoinCount - 1,
      tailState: "complete",
    });

    activeRun = 2;
    nowMs = 0;
    const cursorValue = cursorWrites[1]?.binds[1];
    const resumedDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [LIVE_RESERVE_RUN_CURSOR_CACHE_KEY],
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

  it("recovers stale live-reserve circuit breakers with no configured candidates", async () => {
    const staleBreakerKey = "live-reserves:removed-adapter-key";
    const configuredBreakerKey = `live-reserves:${
      SYNC_ORDERED_CONFIGURED_COINS[0]!.liveReservesConfig!.breakerScope
      ?? SYNC_ORDERED_CONFIGURED_COINS[0]!.liveReservesConfig!.adapter
    }`;
    const staleState = JSON.stringify({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: Math.floor(Date.now() / 1000) - 30,
      lastSuccessAt: null,
      openedAt: Math.floor(Date.now() / 1000) - 30,
    });
    const configuredState = JSON.stringify({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: Math.floor(Date.now() / 1000) - 30,
      lastSuccessAt: null,
      openedAt: Math.floor(Date.now() / 1000) - 30,
    });
    mockAdapterRegistry(async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "key LIKE 'circuit:%'",
        rows: [
          { key: `circuit:${staleBreakerKey}`, value: staleState },
          { key: `circuit:${configuredBreakerKey}`, value: configuredState },
        ],
      },
    ]);

    await syncLiveReserves(db, new AbortController().signal, {});

    const staleRecoveryCalls = recoverNoCandidateMock.mock.calls.filter((call) => call[1] === staleBreakerKey);
    expect(staleRecoveryCalls).toHaveLength(1);
    const configuredRecoveryCalls = recoverNoCandidateMock.mock.calls.filter((call) => call[1] === configuredBreakerKey);
    expect(configuredRecoveryCalls).toHaveLength(0);
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
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds[0] === timedOutCoinId
    ));
    expect(attemptsForTimedOutCoin).toHaveLength(1);
    const duplicateFinalizeRejected = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds[0] === timedOutCoinId
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("success-finalize-rejected"))
    ));
    expect(duplicateFinalizeRejected).toBeUndefined();
  });

  it("accepts a timed out write finalization when authoritative readback proves success", async () => {
    vi.useFakeTimers();
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const actualStore = await vi.importActual<typeof import("../../lib/live-reserves-store")>("../../lib/live-reserves-store");
    vi.doMock("../../lib/live-reserves-store", async () => ({
      ...actualStore,
      finalizeReserveSyncSuccess: vi.fn(async () => (
        await new Promise<Awaited<ReturnType<typeof actualStore.finalizeReserveSyncSuccess>>>(() => undefined)
      )),
      didReserveSyncSuccessBecomeAuthoritative: vi.fn(async () => true),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const runPromise = syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      {
        runBudgetMs: 12,
        adapterTimeoutMs: 1,
        d1FinalizeTimeoutMs: 10,
        finalizationMarginMs: 1,
      },
    );

    await vi.advanceTimersByTimeAsync(11);
    const result = await runPromise;
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      synced?: number;
      failed?: number;
      warningCount?: number;
      warnings?: string[];
      historyWriteFailedCoins?: string[];
    };

    // The tiny budget admits exactly one coin: the head of the ordered queue.
    const firstQueuedCoinId = SYNC_ORDERED_CONFIGURED_COINS[0]!.id;
    expect(result?.itemCount).toBe(1);
    // warningCount is deliberately not pinned: the head-of-queue coin's
    // adapter policy can add informational warnings (e.g. freshness) that are
    // orthogonal to the timed-out-write semantics under test.
    expect(metadata).toMatchObject({
      synced: 1,
      failed: 0,
      historyWriteFailedCoins: [firstQueuedCoinId],
    });
    expect(metadata.warnings).toContain(`${firstQueuedCoinId}:history-write-failed`);
    const historyWriteEvent = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-history-write-failed"
    ));
    expect(historyWriteEvent).toBeDefined();
    const storageTimeoutAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("storage-write-timeout"))
    ));
    expect(storageTimeoutAttempt).toBeUndefined();
  });

  it("hard-times out a non-cooperative adapter attempt", async () => {
    vi.useFakeTimers();
    const adapterFetch = mockAdapterRegistry(
      async () => await new Promise<never>(() => undefined),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const runPromise = syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      {
        runBudgetMs: 20,
        adapterTimeoutMs: 10,
        d1FinalizeTimeoutMs: 1,
        finalizationMarginMs: 1,
      },
    );

    await vi.advanceTimersByTimeAsync(11);
    const result = await runPromise;
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      failed?: number;
      deferredCoins?: number;
      runBudgetTruncated?: boolean;
    };

    expect(adapterFetch).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe("error");
    expect(metadata).toMatchObject({
      failed: 1,
      deferredCoins: configuredCoinCount - 1,
      runBudgetTruncated: true,
    });
    const timeoutAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("adapter-timeout"))
    ));
    expect(timeoutAttempt).toBeDefined();
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
    const syncingCalls = progressCalls.filter(([update]) => update.stage === "syncing");
    expect(syncingCalls.length).toBeLessThanOrEqual(Math.ceil(configuredCoinCount / 10));
    expect(progressCalls.length).toBeLessThanOrEqual(Math.ceil(configuredCoinCount / 10) + 2);
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

  it("defers the full queue safely when configured run budget is below adapter timeout", async () => {
    const adapterFetch = mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      { runBudgetMs: 1, adapterTimeoutMs: 20_000 },
    );
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      synced?: number;
      skipped?: number;
      deferredCoins?: number;
      runBudgetTruncated?: boolean;
    };

    expect(adapterFetch).not.toHaveBeenCalled();
    expect(result?.status).toBe("error");
    expect(metadata).toMatchObject({
      synced: 0,
      skipped: configuredCoinCount,
      deferredCoins: configuredCoinCount,
      runBudgetTruncated: true,
    });
  });

  it("defers when remaining budget covers the adapter timeout but not finalize margin", async () => {
    const adapterFetch = mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      {
        runBudgetMs: 1_699,
        adapterTimeoutMs: 1_000,
        d1FinalizeTimeoutMs: 500,
        finalizationMarginMs: 200,
      },
    );
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      synced?: number;
      skipped?: number;
      deferredCoins?: number;
      runBudgetTruncated?: boolean;
      finalizationMarginMs?: number;
    };

    expect(adapterFetch).not.toHaveBeenCalled();
    expect(metadata).toMatchObject({
      synced: 0,
      skipped: configuredCoinCount,
      deferredCoins: configuredCoinCount,
      runBudgetTruncated: true,
      finalizationMarginMs: 200,
    });
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
      entry.sql.includes("reserve_composition_history")
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
    const result = await syncLiveReserves(db, new AbortController().signal, {});

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

    const runMetadata = JSON.parse(result?.metadata ?? "{}") as {
      attemptFailureSummaries?: Array<{
        stablecoinId?: string;
        adapter?: string;
        attempts?: Array<{ source?: string; label?: string; message?: string }>;
      }>;
    };
    expect(runMetadata.attemptFailureSummaries).toContainEqual({
      stablecoinId: fallbackCoin!.id,
      adapter: fallbackCoin!.liveReservesConfig!.adapter,
      attempts: [
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

  it("keeps recent prior reserve detail visible after a network failure while marking current sync error", async () => {
    const now = 1_900_000_000;
    const coin = getIndependentConfiguredCoin();
    const lastSuccessAt = now - 60 * 60;
    await expectFailureAttemptDoesNotRewriteLastSuccess({
      coin,
      error: new Error("fetch failed: network unreachable"),
      previousLastSuccessAt: lastSuccessAt,
      previousLastSuccessAttemptId: `${coin.id}:previous-success`,
    });

    const rows = buildPreviousLiveReserveRows({
      coin,
      lastStatus: "error",
      lastAttemptedAt: now,
      lastSuccessAt,
      lastError: "fetch failed: network unreachable",
      failureCategory: "network",
    });
    const { resolveReserveResult } = await import("../../lib/live-reserves-store");
    const resolved = await resolveReserveResult(dbWithPreviousLiveReserveRows(rows), coin.id, now);

    expect(resolved?.mode).toBe("live");
    expect(resolved?.reserves).toEqual([{ name: "Prior verified reserves", pct: 100, risk: "low" }]);
    expect(resolved?.sync).toMatchObject({
      enabled: true,
      status: "error",
      stale: false,
      lastSuccessAt,
      lastError: "fetch failed: network unreachable",
      failureCategory: "network",
    });
  });

  it("keeps recent prior reserve detail visible after an upstream HTTP failure while marking current sync error", async () => {
    const now = 1_900_000_000;
    const coin = getIndependentConfiguredCoin();
    const lastSuccessAt = now - 90 * 60;
    await expectFailureAttemptDoesNotRewriteLastSuccess({
      coin,
      error: new Error("HTTP 503 from reserve source"),
      previousLastSuccessAt: lastSuccessAt,
      previousLastSuccessAttemptId: `${coin.id}:previous-success`,
    });

    const rows = buildPreviousLiveReserveRows({
      coin,
      lastStatus: "error",
      lastAttemptedAt: now,
      lastSuccessAt,
      lastError: "HTTP 503 from reserve source",
      failureCategory: "upstream-http",
    });
    const { resolveReserveResult } = await import("../../lib/live-reserves-store");
    const resolved = await resolveReserveResult(dbWithPreviousLiveReserveRows(rows), coin.id, now);

    expect(resolved?.mode).toBe("live");
    expect(resolved?.reserves).toEqual([{ name: "Prior verified reserves", pct: 100, risk: "low" }]);
    expect(resolved?.sync).toMatchObject({
      enabled: true,
      status: "error",
      stale: false,
      lastSuccessAt,
      lastError: "HTTP 503 from reserve source",
      failureCategory: "upstream-http",
    });
  });

  it("fails closed for scoring after parser or validation failure even when prior detail remains visible", async () => {
    const now = 1_900_000_000;
    const coin = getIndependentConfiguredCoin();
    const lastSuccessAt = now - 30 * 60;
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const writeDb = mockD1();
    const previousLastSuccessAttemptId = `${coin.id}:previous-success`;
    const result = await syncReserveCoin({
      db: writeDb,
      coin,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin),
      runAdapter: async () => ({
        slices: [{ name: "Broken parser output", pct: 80, risk: "low" as const }],
        metadata: { freshnessMode: "not-applicable" as const },
      }),
      breakerCanFetch: new Map([[`live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`, true]]),
      d1FinalizeTimeoutMs: 30_000,
      previousState: {
        stablecoinId: coin.id,
        adapterKey: coin.liveReservesConfig.adapter,
        breakerKey: `live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`,
        lastAttemptedAt: lastSuccessAt,
        lastSuccessAt,
        lastStatus: "ok",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: {},
        lastAttemptId: previousLastSuccessAttemptId,
        pendingAttemptId: null,
        lastSuccessAttemptId: previousLastSuccessAttemptId,
      },
    });
    expect(result.status).toBe("failed");

    const rows = buildPreviousLiveReserveRows({
      coin,
      lastStatus: "error",
      lastAttemptedAt: now,
      lastSuccessAt,
      lastError: "Validation failed: Slice percentages sum to 80.0%",
      failureCategory: "validation",
    });
    const db = dbWithPreviousLiveReserveRows(rows);
    const { resolveReserveResult, loadFreshIndependentLiveReserveMap } = await import("../../lib/live-reserves-store");
    const resolved = await resolveReserveResult(db, coin.id, now);
    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now);

    expect(resolved?.mode).toBe("live");
    expect(resolved?.sync?.status).toBe("error");
    expect(scoringMap.has(coin.id)).toBe(false);
  });

  it("does not let scoring source-age overrides weaken adapter freshness policy", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) =>
      candidate.liveReservesConfig?.adapter === "mento"
      && candidate.liveReservesConfig.scoring?.maxSourceAgeSec === 4_000_000
    ) as ConfiguredCoin | undefined;
    expect(coin).toBeDefined();
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockD1();
    const result = await syncReserveCoin({
      db,
      coin: coin!,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin!),
      runAdapter: async () => ({
        slices: [{ name: "Mento reserve", pct: 100, risk: "low" as const }],
        metadata: {
          freshnessMode: "verified" as const,
          sourceTimestamp: Math.floor(Date.now() / 1000) - 35 * 24 * 60 * 60,
        },
      }),
      breakerCanFetch: new Map([[`live-reserves:${coin!.liveReservesConfig.breakerScope ?? coin!.liveReservesConfig.adapter}`, true]]),
      d1FinalizeTimeoutMs: 30_000,
      previousState: null,
    });

    expect(result.status).toBe("synced");
    const finalizeSuccess = db.getHistory().find((entry) => (
      entry.sql.includes("UPDATE reserve_sync_state")
      && entry.sql.includes("last_success_at = ?")
    ));
    expect(finalizeSuccess?.binds).toContain("degraded");
    expect(finalizeSuccess?.binds.some((bind) =>
      typeof bind === "string" && bind.includes("stale-source-data")
    )).toBe(true);
  });

  it("keeps unverified reserve freshness unscoreable and degraded warnings degrading", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) =>
      candidate.liveReservesConfig?.adapter === "reservoir"
      && candidate.liveReservesConfig.scoring?.allowedDegradedWarningCodes?.includes("unknown-position")
    ) as ConfiguredCoin | undefined;
    expect(coin).toBeDefined();
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockD1();
    const result = await syncReserveCoin({
      db,
      coin: coin!,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin!),
      runAdapter: async () => ({
        slices: [{ name: "Reservoir reserve", pct: 100, risk: "low" as const }],
        metadata: { freshnessMode: "unverified" as const },
        warnings: [{
          code: "unknown-position",
          message: "Unmapped reserve position: new-farm",
          severity: "warning" as const,
          effect: "degraded" as const,
        }],
      }),
      breakerCanFetch: new Map([[`live-reserves:${coin!.liveReservesConfig.breakerScope ?? coin!.liveReservesConfig.adapter}`, true]]),
      d1FinalizeTimeoutMs: 30_000,
      previousState: null,
    });

    expect(result.status).toBe("synced");
    const finalizeSuccess = db.getHistory().find((entry) => (
      entry.sql.includes("UPDATE reserve_sync_state")
      && entry.sql.includes("last_success_at = ?")
    ));
    expect(finalizeSuccess?.binds).toContain("degraded");
    expect(finalizeSuccess?.binds.some((bind) =>
      typeof bind === "string" && bind.includes("unknown-position")
    )).toBe(true);
  });

  it("keeps expired prior reserve detail stale and unscoreable after a transient failure", async () => {
    const now = 1_900_000_000;
    const coin = getIndependentConfiguredCoin();
    const lastSuccessAt = now - 3 * 24 * 60 * 60;
    const rows = buildPreviousLiveReserveRows({
      coin,
      lastStatus: "error",
      lastAttemptedAt: now,
      lastSuccessAt,
      lastError: "fetch failed: network timeout",
      failureCategory: "network",
    });
    const db = dbWithPreviousLiveReserveRows(rows);
    const { resolveReserveResult, loadFreshIndependentLiveReserveMap } = await import("../../lib/live-reserves-store");
    const resolved = await resolveReserveResult(db, coin.id, now);
    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now);

    expect(resolved?.mode).toBe("live-stale");
    expect(resolved?.sync).toMatchObject({
      status: "error",
      stale: true,
      lastSuccessAt,
    });
    expect(scoringMap.has(coin.id)).toBe(false);
  });

  class AbruptTermination extends Error {}

  function abruptFault(killPoint: "after_pending_begin" | "after_authoritative_write", targetItemKey: string) {
    return new AbruptTermination(`abrupt termination at ${killPoint} for ${targetItemKey}`);
  }

  it("leaves the exact domain attempt pending when injection fires after pending begin", async () => {
    const coin = getIndependentConfiguredCoin();
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockD1();

    await expect(syncReserveCoin({
      db,
      coin,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin),
      runAdapter: vi.fn(),
      breakerCanFetch: new Map(),
      d1FinalizeTimeoutMs: 30_000,
      previousState: null,
      onAttemptPending: async () => {
        throw abruptFault("after_pending_begin", coin.id);
      },
    })).rejects.toBeInstanceOf(AbruptTermination);

    expect(db.getHistory().some((entry) => entry.sql.includes("pending_attempt_id = excluded.pending_attempt_id"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("pending_attempt_id = NULL"))).toBe(false);
  });

  it("leaves the authoritative write intact and skips history finalization when the write hook throws", async () => {
    const coin = getIndependentConfiguredCoin();
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockD1();

    const result = await syncReserveCoin({
      db,
      coin,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin),
      runAdapter: async () => ({
        slices: [{ name: "Preview reserve", pct: 100, risk: "low" as const }],
        metadata: { freshnessMode: "not-applicable" as const },
      }),
      breakerCanFetch: new Map([[
        `live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`,
        true,
      ]]),
      d1FinalizeTimeoutMs: 30_000,
      previousState: null,
      onAuthoritativeWrite: async () => {
        throw abruptFault("after_authoritative_write", coin.id);
      },
    });

    expect(result.status).toBe("failed");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO reserve_composition ("))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_composition_history"))).toBe(false);
  });

  it("preserves prior reserve detail and skips scoring when the circuit is open", async () => {
    const now = 1_900_000_000;
    const coin = getIndependentConfiguredCoin();
    const lastSuccessAt = now - 45 * 60;
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const runAdapter = vi.fn(async () => ({
      slices: [{ name: "Should not run", pct: 100, risk: "low" as const }],
      metadata: { freshnessMode: "not-applicable" as const },
    }));

    const result = await syncReserveCoin({
      db: mockD1(),
      coin,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin),
      runAdapter,
      breakerCanFetch: new Map([[`live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`, false]]),
      d1FinalizeTimeoutMs: 30_000,
      previousState: {
        stablecoinId: coin.id,
        adapterKey: coin.liveReservesConfig.adapter,
        breakerKey: `live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`,
        lastAttemptedAt: lastSuccessAt,
        lastSuccessAt,
        lastStatus: "ok",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: {},
        lastAttemptId: `${coin.id}:previous-success`,
        pendingAttemptId: null,
        lastSuccessAttemptId: `${coin.id}:previous-success`,
      },
    });
    expect(result.status).toBe("skipped");
    expect(runAdapter).not.toHaveBeenCalled();

    const rows = buildPreviousLiveReserveRows({
      coin,
      lastStatus: "skipped",
      lastAttemptedAt: now,
      lastSuccessAt,
      lastError: null,
    });
    const db = dbWithPreviousLiveReserveRows(rows);
    const { resolveReserveResult, loadFreshIndependentLiveReserveMap } = await import("../../lib/live-reserves-store");
    const resolved = await resolveReserveResult(db, coin.id, now);
    const scoringMap = await loadFreshIndependentLiveReserveMap(db, now);

    expect(resolved?.mode).toBe("live");
    expect(resolved?.reserves).toEqual([{ name: "Prior verified reserves", pct: 100, risk: "low" }]);
    expect(resolved?.sync).toMatchObject({
      status: "skipped",
      stale: false,
      lastSuccessAt,
    });
    expect(scoringMap.has(coin.id)).toBe(false);
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

  it("keeps same-URL shared sources separate when parser params differ", async () => {
    const { buildSharedSourceCacheKey } = await import("../sync-live-reserves-shared");

    const adapter = {
      key: "circle-transparency",
      fetch: async () => ({ slices: [] }),
      sourceModel: "dynamic-mix",
      evidenceClass: "independent",
      sharedSourceMode: "source-invariant",
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[1];

    const baseConfig = {
      adapter: "circle-transparency",
      version: 1,
      semantics: "attestation-mix",
      inputs: {
        primary: { kind: "http-html", url: "https://www.circle.com/transparency" },
      },
    };
    const usdcConfig = {
      ...baseConfig,
      params: { coinType: "usdc" },
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];
    const eurcConfig = {
      ...baseConfig,
      params: { coinType: "eurc" },
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];

    expect(buildSharedSourceCacheKey(usdcConfig, adapter)).not.toEqual(
      buildSharedSourceCacheKey(eurcConfig, adapter),
    );
  });
});
