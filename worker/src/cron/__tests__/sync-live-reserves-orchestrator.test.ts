import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapter-descriptors";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { MockD1Database, MockPreparedStatement, MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  CONFIGURED_COINS,
  SYNC_ORDERED_CONFIGURED_COINS,
  orderConfiguredCoinsForSync,
  type ConfiguredCoin,
} from "../sync-live-reserves-shared";
import { LIVE_RESERVE_CONTINUATION_BUDGETS, resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";
import {
  checkpointIdentity,
  checkpointTable,
  mockLiveReserveAdapterRegistry,
  mockLiveReserveD1,
  recordOutcomeSafeMock,
  shouldAttemptFetchMock,
} from "./live-reserves.test-support";
import { sealAcceptedReserveGeneration } from "../../lib/accepted-reserve-generation";

// Cohort sealing and atomic fencing are covered by accepted-reserve-generation.test.
vi.mock("../../lib/accepted-reserve-generation", () => ({ sealAcceptedReserveGeneration: vi.fn(async () => null) }));

function mockD1(tables: MockTableConfig[] = []): MockD1Database {
  return mockLiveReserveD1(tables, [
    { match: "SELECT key, value FROM cache WHERE key IN", rows: [] },
    { match: "UPDATE worker_scheduled_checkpoints", rows: [] },
  ]);
}

const mockAdapterRegistry = mockLiveReserveAdapterRegistry;

const CONFIGURED_COIN_COUNT = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).length;

// Tight budget seam values so the queue loop defers without real timers:
// minimumAttemptBudgetMs = 1000 + 1000 + 500 = 2500.
const TIGHT_BUDGET = {
  runBudgetMs: 60_000,
  adapterTimeoutMs: 1_000,
  d1FinalizeTimeoutMs: 1_000,
  finalizationMarginMs: 500,
};

interface RunMetadata {
  synced?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  runBudgetTruncated?: boolean;
  deferredCoins?: number;
  nextCursorStablecoinId?: string | null;
  cursorTailState?: string | null;
  cursorRecordedAt?: number | null;
  cursorTailCompletedAt?: number | null;
  runBudgetTruncationCount?: number;
  artifactCleanup?: { breakerCacheDeleted?: number };
  finalizationTailBudgetExhausted?: boolean;
  artifactCleanupSkipped?: boolean;
  historyPruneSkipped?: boolean;
  breakerKeys?: string[];
  attemptedCoins?: number;
}

function parseMetadata(metadata: string | undefined): RunMetadata {
  return JSON.parse(metadata ?? "{}") as RunMetadata;
}

describe("syncLiveReserves orchestrator run-budget behavior", () => {
  let nowMs = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.resetModules();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
    nowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["D1_ERROR: internal error", "storage-write", undefined],
    ["hive-hbd-protocol: nodes disagree", "corroboration-mismatch", undefined],
    ["Accountable dashboard returned an invalid response", "schema-shape", undefined],
    ["HTTP 503 unavailable", "upstream-http", false],
  ] as const)("classifies %s without penalizing unrelated source health", async (message, category, breakerOutcome) => {
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const { classifyFailure } = await import("../sync-live-reserves-shared");
    expect(classifyFailure("adapter-exception", message)).toBe(category);
    const coin = SYNC_ORDERED_CONFIGURED_COINS[0]!;
    const stages = { checkpoint: 0, breakerRead: 0, beginWrite: 0, failureWrite: 0, authoritativeWrite: 0, progress: 0 };
    shouldAttemptFetchMock.mockImplementation(async () => { nowMs += 11; return true; });
    const result = await syncReserveCoin({
      db: mockD1(), coin, signal: new AbortController().signal,
      adapter: { ...LIVE_RESERVE_ADAPTER_DEFINITIONS[coin.liveReservesConfig!.adapter], key: coin.liveReservesConfig!.adapter, fetch: async () => { throw new Error(message); } },
      runAdapter: async () => { nowMs += 13; throw new Error(message); },
      breakerCanFetch: new Map(), previousState: null, d1FinalizeTimeoutMs: 1000,
      deadlineMs: nowMs + 5000, stageTimings: stages,
      onAttemptStarted: async () => { nowMs += 7; },
    });
    expect(result).toMatchObject({ status: "failed", adapterDurationMs: 13 });
    expect(result.breakerOutcome).toBe(breakerOutcome);
    expect(stages.checkpoint).toBe(7);
    expect(stages.breakerRead).toBe(11);
  });

  it("stops at an expired checkpoint deadline without beginning an unfenced domain attempt", async () => {
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockD1();
    const runAdapter = vi.fn();
    await expect(syncReserveCoin({
      db, coin: SYNC_ORDERED_CONFIGURED_COINS[0]!, signal: new AbortController().signal,
      adapter: null, runAdapter, breakerCanFetch: new Map(), previousState: null,
      d1FinalizeTimeoutMs: 1000, deadlineMs: nowMs + 100,
      onAttemptStarted: async () => { nowMs += 101; },
    })).rejects.toThrow("run-budget-exhausted");
    expect(runAdapter).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO reserve_sync_state"))).toBe(false);
  });

  it("shares the remaining run deadline across the entire fallback chain", async () => {
    const target = SYNC_ORDERED_CONFIGURED_COINS.find((coin) =>
      (coin.liveReservesConfig?.inputs.fallbacks?.length ?? 0) >= 2
      && coin.liveReservesConfig?.adapter !== "hive-hbd-protocol");
    if (!target) throw new Error("Expected a configured multi-fallback source");
    let targetAttempts = 0;
    mockAdapterRegistry(async (coin) => {
      if (coin?.id === target.id) {
        targetAttempts++;
        nowMs += targetAttempts === 1 ? 20_000 : 5_000;
        throw new Error("HTTP 503 source unavailable");
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const result = await syncLiveReserves(mockD1(), new AbortController().signal, {}, undefined, {
      runBudgetMs: 60_000, adapterTimeoutMs: 20_000, d1FinalizeTimeoutMs: 30_000, finalizationMarginMs: 5_000,
    });
    expect(targetAttempts).toBe(2);
    expect(parseMetadata(result.metadata)).toMatchObject({ runBudgetTruncated: true, failed: 1 });
  });

  it.each([
    ["one failure of two", { synced: 1, failed: 1, skipped: 0, deferredSkipped: 0, circuitSkipped: 0, deferredCoins: 0, attemptedCoins: 2 }, false, "degraded"],
    ["two failures of twenty", { synced: 18, failed: 2, skipped: 0, deferredSkipped: 0, circuitSkipped: 0, deferredCoins: 0, attemptedCoins: 20 }, false, "degraded"],
    ["one circuit-held member of a hundred", { synced: 99, failed: 0, skipped: 1, deferredSkipped: 0, circuitSkipped: 1, deferredCoins: 0, attemptedCoins: 99 }, false, "degraded"],
    ["every member failed", { synced: 0, failed: 20, skipped: 0, deferredSkipped: 0, circuitSkipped: 0, deferredCoins: 0, attemptedCoins: 20 }, false, "error"],
    ["a clean run", { synced: 20, failed: 0, skipped: 0, deferredSkipped: 0, circuitSkipped: 0, deferredCoins: 0, attemptedCoins: 20 }, false, "ok"],
    ["a clean checkpoint-owned continuation", { synced: 10, failed: 0, skipped: 0, deferredSkipped: 10, circuitSkipped: 0, deferredCoins: 10, attemptedCoins: 10 }, true, "ok"],
  ] as const)("reports %s without a percentage tolerance", async (_name, counts, checkpointOwned, status) => {
    const { resolveReserveSyncRunStatus } = await import("../sync-live-reserves-finalize");
    expect(resolveReserveSyncRunStatus({ counts, total: 20, checkpointOwned })).toBe(status);
  });

  it("classifies any productive deferred tail as degraded even below the ratio threshold", async () => {
    const { resolveReserveSyncRunStatus } = await import("../sync-live-reserves-finalize");

    expect(resolveReserveSyncRunStatus({
      counts: {
        synced: 99,
        failed: 0,
        skipped: 1,
        deferredSkipped: 1,
        circuitSkipped: 0,
        deferredCoins: 1,
        attemptedCoins: 99,
      },
      total: 100,
      checkpointOwned: false,
    })).toBe("degraded");
  });

  it("batches each checkpoint/begin pair and bulk-reads closed breakers without changing frontier order", async () => {
    mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));
    const identity = checkpointIdentity(1, "producer-owner");
    const db = mockD1([checkpointTable({
      attemptNo: 1,
      invocationId: identity.invocationId,
      nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]!.id,
      itemsDone: 0,
      state: "running",
      sourceAttemptNo: null,
    })]);
    const { syncLiveReserves } = await import("../sync-live-reserves");

    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      identity,
    );

    expect(result.status).toBe("ok");
    expect(sealAcceptedReserveGeneration).toHaveBeenCalledWith(expect.anything(), identity, expect.any(String),
      CONFIGURED_COINS.map((coin) => coin.id), expect.objectContaining({
        status: "ok", itemCount: CONFIGURED_COIN_COUNT, productivity: result.productivity,
      }));
    const sealedResult = vi.mocked(sealAcceptedReserveGeneration).mock.calls[0]![4];
    expect(JSON.parse(result.metadata!)).toEqual({
      ...JSON.parse(sealedResult.metadata!),
      d1Cost: expect.objectContaining({ bindingCalls: expect.any(Number), batchCalls: expect.any(Number) }),
      resourcePressure: expect.objectContaining({ phase: "terminal" }),
    });
    const history = db.getHistory();
    const checkpointUpdates = history.filter((entry) => (
      entry.sql.includes("UPDATE worker_scheduled_checkpoints")
      && entry.sql.includes("items_done = ?")
    ));
    const itemStarts = checkpointUpdates.filter((entry) => (
      entry.sql.includes("current_item_key = ?")
      && entry.sql.includes("current_domain_attempt_id = ?")
    ));
    const boundaryWrites = checkpointUpdates.filter((entry) => (
      entry.sql.includes("current_item_key = NULL")
    ));
    const domainAttemptBegins = history.filter((entry) => (
      entry.sql.includes("INSERT INTO reserve_sync_state")
      && entry.sql.includes("pending_attempt_id = excluded.pending_attempt_id")
    ));

    expect(itemStarts).toHaveLength(CONFIGURED_COIN_COUNT);
    expect(boundaryWrites).toHaveLength(1);
    expect(checkpointUpdates).toHaveLength(CONFIGURED_COIN_COUNT + 1);
    expect(domainAttemptBegins).toHaveLength(CONFIGURED_COIN_COUNT);
    const cost = JSON.parse(result.metadata!).d1Cost;
    expect(cost.batchCalls).toBeGreaterThanOrEqual(2 * CONFIGURED_COIN_COUNT);
    expect(cost.bindingCalls).toBeLessThan(3 * CONFIGURED_COIN_COUNT);
    expect(shouldAttemptFetchMock).not.toHaveBeenCalled();
    expect(boundaryWrites[0]?.binds.slice(0, 2)).toEqual([null, CONFIGURED_COIN_COUNT]);
    for (const begin of domainAttemptBegins) {
      const checkpointStart = itemStarts.find((entry) => entry.binds[2] === begin.binds[4]);
      expect(checkpointStart).toBeDefined();
      expect(history.indexOf(checkpointStart!)).toBe(history.indexOf(begin) - 1);
    }
  });

  it("drains one cohort across a producer and two bounded continuations without double-processing", async () => {
    const visited: string[] = [];
    mockAdapterRegistry(async () => {
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    // This suite resets the module graph before installing each adapter mock.
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const sliceSize = Math.ceil(SYNC_ORDERED_CONFIGURED_COINS.length / 3);
    let frontier = 0;
    for (let slice = 0; slice < 3; slice++) {
      // One checkpoint root/attempt; the normal handoff only replaces its owner.
      const identity = checkpointIdentity(1, `slice-${slice}`);
      const db = mockD1([checkpointTable({
        attemptNo: 1, invocationId: identity.invocationId,
        nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[frontier]?.id ?? null,
        itemsDone: frontier, state: slice === 0 ? "running" : "recovering",
      })]);
      const result = await syncLiveReserves(db, new AbortController().signal, {}, undefined,
        { ...TIGHT_BUDGET, maxCoinsPerSlice: sliceSize }, identity);
      const expectedDone = Math.min(frontier + sliceSize, SYNC_ORDERED_CONFIGURED_COINS.length);
      expect(result.status).toBe("ok");
      expect(JSON.parse(result.metadata!)).toMatchObject({
        cohortItemsDoneBeforeRun: frontier, cohortItemsDoneAfterRun: expectedDone,
        continuationPending: slice < 2, runBudgetTruncated: false,
        childDisposition: slice < 2 ? "continuation_pending" : "completed",
        maintenanceDeferredToCohortEnd: slice < 2,
      });
      // Count lifecycle admission, not adapter calls (source-invariant
      // adapters legitimately share one fetch across multiple coin lifecycles).
      for (const entry of db.getHistory()) {
        if (entry.sql.includes("UPDATE worker_scheduled_checkpoints") && entry.sql.includes("current_item_key = ?")) {
          visited.push(String(entry.binds[0]));
        }
      }
      const boundary = db.getHistory().find((entry) =>
        entry.sql.includes("UPDATE worker_scheduled_checkpoints") && entry.sql.includes("current_item_key = NULL"));
      expect(boundary?.binds.slice(0, 2)).toEqual([
        SYNC_ORDERED_CONFIGURED_COINS[expectedDone]?.id ?? null, expectedDone,
      ]);
      expect(db.getHistory().some((entry) =>
        entry.sql.includes("last_status = 'skipped'") || entry.binds.includes("run-budget-exhausted"))).toBe(false);
      expect(db.getHistory().some((entry) =>
        entry.sql.includes("DELETE FROM reserve_composition_history"))).toBe(slice === 2);
      expect(db.getHistory().some((entry) =>
        entry.sql.includes("SELECT key FROM cache WHERE key LIKE"))).toBe(slice === 2);
      frontier = expectedDone;
    }
    expect(visited).toEqual(SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id));
    expect(new Set(visited).size).toBe(visited.length);
    expect(sealAcceptedReserveGeneration).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("packs a 93-coin suffix with the unchanged admission floor (slow tail: %s)", async (slowTail) => {
    mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));
    // Reset modules above installs this test's adapter registry before import.
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const frontier = SYNC_ORDERED_CONFIGURED_COINS.length - 93;
    const identity = checkpointIdentity(1, "packed-suffix");
    const db = mockD1([checkpointTable({
      attemptNo: 1, invocationId: identity.invocationId, state: "recovering",
      nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[frontier]!.id, itemsDone: frontier,
    })]);
    let attempted = 0;
    const startedMs = nowMs;
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      if (statements.some((statement) => (statement as MockPreparedStatement).sql.includes("INSERT INTO reserve_sync_state"))) {
        attempted++;
        // Charge elapsed I/O per admitted lifecycle, not per deduplicated fetch.
        nowMs += attempted <= 88 ? 193_362 / 88 : slowTail ? 14_000 : 29_841 / 5;
      }
      return batch(statements);
    });
    const result = await syncLiveReserves(db, new AbortController().signal, {}, undefined,
      LIVE_RESERVE_CONTINUATION_BUDGETS, identity);
    const completed = slowTail ? 92 : 93;
    expect(attempted).toBe(completed);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      cohortItemsDoneAfterRun: frontier + completed,
      continuationPending: slowTail, maintenanceDeferredToCohortEnd: slowTail,
      childDisposition: slowTail ? "continuation_pending" : "completed",
    });
    const boundary = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE worker_scheduled_checkpoints") && entry.sql.includes("current_item_key = NULL"));
    expect(boundary?.binds.slice(0, 2)).toEqual([
      SYNC_ORDERED_CONFIGURED_COINS[frontier + completed]?.id ?? null, frontier + completed,
    ]);
    expect(sealAcceptedReserveGeneration).toHaveBeenCalledTimes(slowTail ? 0 : 1);
    expect(db.getHistory().filter((entry) => entry.sql.includes("DELETE FROM reserve_composition_history")))
      .toHaveLength(slowTail ? 0 : 1);
    expect(db.getHistory().some((entry) => entry.binds.includes("run-budget-exhausted"))).toBe(false);
    if (!slowTail) expect(nowMs - startedMs).toBeCloseTo(223_203, 1);
  });

  it("defers coin 126 even with the full 300-second wall allowance remaining", async () => {
    mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));
    // Reset modules above installs this test's adapter registry before import.
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const identity = checkpointIdentity(1, "cpu-capped");
    const db = mockD1([checkpointTable({
      attemptNo: 1, invocationId: identity.invocationId, state: "recovering",
      nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]!.id, itemsDone: 0,
    })]);
    const result = await syncLiveReserves(db, new AbortController().signal, {}, undefined,
      LIVE_RESERVE_CONTINUATION_BUDGETS, identity);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      attemptedCoins: 125, cohortItemsDoneAfterRun: 125, continuationPending: true,
      nextCursorStablecoinId: SYNC_ORDERED_CONFIGURED_COINS[125]!.id,
    });
    expect(db.getHistory().filter((entry) =>
      entry.sql.includes("UPDATE worker_scheduled_checkpoints") && entry.sql.includes("current_item_key = ?")))
      .toHaveLength(125);
    expect(sealAcceptedReserveGeneration).not.toHaveBeenCalled();
  });

  it.each([1, 2])("renews the claimed recovery lease while advancing an authoritative crash item once (attempt %s)", async (attemptNo) => {
    const visited: string[] = [];
    mockAdapterRegistry(async (coin) => {
      visited.push(coin?.id ?? "unknown");
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    const crashedCoin = SYNC_ORDERED_CONFIGURED_COINS[0]!;
    const suffixCoin = SYNC_ORDERED_CONFIGURED_COINS[1]!;
    const identity = checkpointIdentity(attemptNo, "recovery-owner");
    const db = mockD1([
      checkpointTable({
        attemptNo,
        state: "recovering",
        invocationId: identity.invocationId,
        nextItemKey: crashedCoin.id,
        itemsDone: 0,
        currentDomainAttemptId: "crashed-authoritative-attempt",
      }),
      {
        match: "FROM reserve_composition c",
        rows: [{ finalized: 1, repaired: 1 }],
      },
    ]);
    const { syncLiveReserves } = await import("../sync-live-reserves");

    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      identity,
    );

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(CONFIGURED_COIN_COUNT - 1);
    expect(visited[0]).toBe(suffixCoin.id);
    expect(visited).not.toContain(crashedCoin.id);
    const history = db.getHistory();
    const checkpointUpdates = history.filter((entry) => (
      entry.sql.includes("UPDATE worker_scheduled_checkpoints")
      && entry.sql.includes("items_done = ?")
    ));
    const itemStarts = checkpointUpdates.filter((entry) => entry.sql.includes("current_item_key = ?"));
    const boundaryWrites = checkpointUpdates.filter((entry) => entry.sql.includes("current_item_key = NULL"));
    const authoritativeAdvance = boundaryWrites.find((entry) => (
      entry.binds[0] === suffixCoin.id && entry.binds[1] === 1
    ));
    const terminalAdvance = boundaryWrites.find((entry) => (
      entry.binds[0] === null && entry.binds[1] === CONFIGURED_COIN_COUNT
    ));

    expect(itemStarts).toHaveLength(CONFIGURED_COIN_COUNT - 1);
    expect(boundaryWrites).toHaveLength(2);
    expect(checkpointUpdates).toHaveLength(CONFIGURED_COIN_COUNT + 1);
    expect(authoritativeAdvance).toBeDefined();
    expect(authoritativeAdvance?.binds[3]).toBe(Math.floor(nowMs / 1000) + 15 * 60);
    expect(terminalAdvance).toBeDefined();
  });


  it("skips optional finalization cleanup when the D1 tail budget is exhausted", async () => {
    mockAdapterRegistry(async () => {
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {}, async (update) => {
      if (update.stage === "finalizing") nowMs += TIGHT_BUDGET.runBudgetMs + TIGHT_BUDGET.d1FinalizeTimeoutMs;
    }, TIGHT_BUDGET);
    const metadata = parseMetadata(result?.metadata);

    expect(metadata.finalizationTailBudgetExhausted).toBe(true);
    expect(metadata.artifactCleanupSkipped).toBe(true);
    expect(metadata.historyPruneSkipped).toBe(true);
    expect(metadata.artifactCleanup).toBeNull();
    expect(db.getHistory().some((entry) => (
      entry.sql.includes("INSERT INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-history-prune-skipped"
    ))).toBe(true);
  });
});

describe("orderConfiguredCoinsForSync", () => {
  const EXPECTED_PRIORITY: Record<string, number> = {
    "independent": 0,
    "static-validated": 1,
    "weak-live-probe": 2,
  };

  function makeQueueCoin(id: string, adapter: string): ConfiguredCoin {
    return {
      id,
      liveReservesConfig: {
        adapter,
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } },
      },
    } as unknown as ConfiguredCoin;
  }

  it("orders independent before static-validated before weak-live-probe and groups source-invariant adapters", () => {
    // Guard the registry classes this synthetic queue relies on.
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["liquity-v1"].evidenceClass).toBe("independent");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["gho"].evidenceClass).toBe("independent");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["curated-validated"].evidenceClass).toBe("static-validated");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["single-asset"].evidenceClass).toBe("weak-live-probe");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["m0"].sharedSourceMode).toBe("none");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["myrc-independent-assurance"].sharedSourceMode).toBe("source-invariant");

    const ordered = orderConfiguredCoinsForSync([
      makeQueueCoin("w1", "single-asset"),
      makeQueueCoin("i1", "liquity-v1"),
      makeQueueCoin("s1", "curated-validated"),
      makeQueueCoin("m1", "myrc-independent-assurance"),
      makeQueueCoin("i2", "gho"),
      makeQueueCoin("m2", "myrc-independent-assurance"),
    ]);

    // m2 joins its source-invariant group at m1's anchor position; everything
    // else keeps the original deterministic order within its class segment.
    expect(ordered.map((coin) => coin.id)).toEqual(["i1", "m1", "m2", "i2", "s1", "w1"]);
  });

  it("does not group subject-bound M0 reads across another independent source", () => {
    const ordered = orderConfiguredCoinsForSync([
      makeQueueCoin("m1", "m0"),
      makeQueueCoin("i1", "gho"),
      makeQueueCoin("m2", "m0"),
    ]);
    expect(ordered.map((coin) => coin.id)).toEqual(["m1", "i1", "m2"]);
  });

  it("keeps the real configured queue a permutation with non-decreasing evidence-class rank", () => {
    expect(SYNC_ORDERED_CONFIGURED_COINS).toHaveLength(CONFIGURED_COINS.length);
    expect(new Set(SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id)))
      .toEqual(new Set(CONFIGURED_COINS.map((coin) => coin.id)));

    const ranks = SYNC_ORDERED_CONFIGURED_COINS.map((coin) => (
      EXPECTED_PRIORITY[LIVE_RESERVE_ADAPTER_DEFINITIONS[coin.liveReservesConfig!.adapter].evidenceClass]
    ));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!, `queue position ${i} regressed evidence-class order`).toBeGreaterThanOrEqual(ranks[i - 1]!);
    }
  });

  it("keeps every source-invariant adapter's coins contiguous in the real configured queue", () => {
    const sourceInvariantAdapters = Object.entries(LIVE_RESERVE_ADAPTER_DEFINITIONS)
      .filter(([, definition]) => definition.sharedSourceMode === "source-invariant")
      .map(([key]) => key);
    expect(sourceInvariantAdapters).toContain("myrc-independent-assurance");
    expect(sourceInvariantAdapters).not.toContain("m0");

    for (const adapter of sourceInvariantAdapters) {
      const positions = SYNC_ORDERED_CONFIGURED_COINS
        .map((coin, index) => (coin.liveReservesConfig!.adapter === adapter ? index : -1))
        .filter((index) => index >= 0);
      if (positions.length < 2) continue;
      expect(
        positions[positions.length - 1]! - positions[0]!,
        `${adapter} coins are not contiguous in the sync queue`,
      ).toBe(positions.length - 1);
    }
  });
});

describe("live reserve sync budget defaults", () => {
  const TWELVE_MINUTE_LEASE_MS = 12 * 60 * 1000;

  it("keeps default budget + finalize + margin under the 12-minute lease with headroom", () => {
    const config = resolveLiveReserveSyncBudgetConfig();
    const worstCaseMs = config.runBudgetMs + config.d1FinalizeTimeoutMs + config.finalizationMarginMs;
    // Leave at least 120s of lease headroom for the untimed pre-loop D1 load,
    // deferred-tail writes, run finalization, and cron logging. The watchdog
    // still saw cap hits with the earlier 60s assertion.
    expect(worstCaseMs).toBeLessThanOrEqual(TWELVE_MINUTE_LEASE_MS - 120_000);
  });
});
