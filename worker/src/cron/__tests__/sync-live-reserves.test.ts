import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { type MockTableConfig } from "@shared/test-utils/mock-d1";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildChainRpcs } from "../../lib/chain-registry";
import { LIVE_RESERVE_RUN_CURSOR_CACHE_KEY } from "../../lib/operational-cache-keys";
import { buildSharedSourceCacheKey, LIVE_RESERVE_QUEUE_HASH, SYNC_ORDERED_CONFIGURED_COINS } from "../sync-live-reserves-shared";
import {
  getReserveAdapterMock,
  mockLiveReserveAdapterRegistry,
  mockLiveReserveD1,
  recordOutcomeSafeMock,
  recoverNoCandidateMock,
  shouldAttemptFetchMock,
} from "./live-reserves.test-support";

const mockD1 = mockLiveReserveD1;
const mockAdapterRegistry = mockLiveReserveAdapterRegistry;

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
        match: "SELECT key, value, updated_at FROM cache WHERE key IN",
        rows: closedBreakerRows.map((row) => ({ ...row, updated_at: 1_700_000_000 })),
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
        match: "SELECT key, value, updated_at FROM cache WHERE key IN",
        rows: closedBreakerRows.map((row) => ({ ...row, updated_at: 1_700_000_000 })),
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
        match: "SELECT key, value, updated_at FROM cache WHERE key IN",
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

  it("reports breaker outcome write failures without counting them as recorded", async () => {
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
    recordOutcomeSafeMock.mockImplementation(async (_db, key) => (
      key === failedBreakerKey ? null : undefined
    ));

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomeWriteFailures?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, failedBreakerKey, false);
    expect(metadata.breakerOutcomesRecorded).toBe(uniqueBreakerKeys.size - 1);
    expect(metadata.breakerOutcomeWriteFailures).toBe(1);
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
    // metadata is the 6th bound column in reserve_composition (0-indexed 5).
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
    // Derive a fixture from any active source-invariant adapter with >=2 coins
    // sharing the same primary URL, so the test survives individual adapter
    // suspensions (m0, the original fixture, was suspended 2026-08-19).
    const sharedGroups = new Map<string, { cacheKey: string; coinIds: string[] }>();
    for (const coin of ACTIVE_STABLECOINS) {
      const config = coin.liveReservesConfig;
      if (!config) continue;
      const cacheKey = buildSharedSourceCacheKey(config, LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter]);
      if (!cacheKey) continue;
      const group = sharedGroups.get(cacheKey) ?? { cacheKey, coinIds: [] };
      group.coinIds.push(coin.id);
      sharedGroups.set(cacheKey, group);
    }
    const shared = [...sharedGroups.values()].find((group) => group.coinIds.length >= 2);
    expect(shared, "an active source-invariant adapter with a shared source cache key").toBeDefined();

    const matchesSharedSource = (
      config: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]> | undefined,
    ): boolean =>
      config != null
      && buildSharedSourceCacheKey(config, LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter]) === shared!.cacheKey;

    const adapterFetch = mockAdapterRegistry(async (_coin, config) => {
      if (matchesSharedSource(config ?? undefined)) {
        throw new Error("shared upstream boom");
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const sharedFetchCalls = adapterFetch.mock.calls.filter((call) =>
      matchesSharedSource(
        call[1] as NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]> | undefined,
      ),
    );
    expect(sharedFetchCalls.length).toBe(1);
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
    const result = await syncLiveReserves(db, new AbortController().signal, {});

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
    const runMetadata = JSON.parse(result.metadata ?? "{}") as {
      adapterLatency?: {
        groups?: Array<{ adapterKey?: string; stage?: string; attemptCount?: number }>;
        total?: { attemptCount?: number };
        overflow?: boolean;
      };
    };
    const fallbackGroup = runMetadata.adapterLatency?.groups?.find((group) => (
      group.adapterKey === fallbackCoin!.liveReservesConfig!.adapter
      && group.stage === "fallback"
    ));
    expect(
      fallbackGroup?.attemptCount === 1
      || (
        runMetadata.adapterLatency?.overflow === true
        && (runMetadata.adapterLatency.total?.attemptCount ?? 0) > configuredCoinCount
      ),
    ).toBe(true);
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
