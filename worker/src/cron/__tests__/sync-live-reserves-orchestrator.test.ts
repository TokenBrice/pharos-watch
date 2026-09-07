import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapter-descriptors";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  CONFIGURED_COINS,
  LIVE_RESERVE_QUEUE_HASH,
  SYNC_ORDERED_CONFIGURED_COINS,
  orderConfiguredCoinsForSync,
  type ConfiguredCoin,
} from "../sync-live-reserves-shared";
import { resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";
import {
  mockLiveReserveAdapterRegistry,
  mockLiveReserveD1,
  recordOutcomeSafeMock,
  shouldAttemptFetchMock,
} from "./live-reserves.test-support";

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


function checkpointTable(input: {
  attemptNo: number;
  invocationId: string;
  nextItemKey: string | null;
  itemsDone: number;
  state?: "running" | "recovering";
  sourceAttemptNo?: number | null;
  slotStartedAt?: number;
  currentItemKey?: string | null;
  currentDomainAttemptId?: string | null;
}): MockTableConfig {
  const slotStartedAt = input.slotStartedAt ?? 1_000;
  return {
    match: "FROM worker_scheduled_checkpoints",
    rows: [{
      schedule_key: "fourHourlyReserveSync",
      slot_started_at: slotStartedAt,
      job: "sync-live-reserves",
      attempt_no: input.attemptNo,
      execution_generation: input.attemptNo,
      invocation_id: input.invocationId,
      worker_version: "version-a",
      queue_hash: LIVE_RESERVE_QUEUE_HASH,
      state: input.state ?? "recovering",
      next_item_key: input.nextItemKey,
      current_item_key: input.currentItemKey ?? null,
      current_domain_attempt_id: input.currentDomainAttemptId ?? null,
      items_done: input.itemsDone,
      items_total: CONFIGURED_COIN_COUNT,
      child_dispositions_json: JSON.stringify({ "sync-live-reserves": "not_started" }),
      recovery_owner: input.invocationId,
      recovery_lease_until: 2_000,
      source_attempt_no: input.sourceAttemptNo === undefined
        ? input.attemptNo - 1
        : input.sourceAttemptNo,
      error: null,
      created_at: slotStartedAt,
      updated_at: slotStartedAt + 100,
      completed_at: null,
    }],
  };
}

function checkpointIdentity(attemptNo: number, invocationId: string, slotStartedAt = 1_000) {
  return {
    scheduleKey: "fourHourlyReserveSync",
    slotStartedAt,
    job: "sync-live-reserves",
    attemptNo,
    executionGeneration: attemptNo,
    invocationId,
  };
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
    })).toBe("degraded");
  });

  it("uses one checkpoint update per attempted coin plus one terminal boundary write", async () => {
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
    expect(boundaryWrites[0]?.binds.slice(0, 2)).toEqual([null, CONFIGURED_COIN_COUNT]);
    for (const begin of domainAttemptBegins) {
      const checkpointStart = itemStarts.find((entry) => entry.binds[2] === begin.binds[4]);
      expect(checkpointStart).toBeDefined();
      expect(history.indexOf(checkpointStart!)).toBe(history.indexOf(begin) - 1);
    }
  });

  it("advances an authoritative crash item once, then completes only its remaining suffix", async () => {
    const visited: string[] = [];
    mockAdapterRegistry(async (coin) => {
      visited.push(coin?.id ?? "unknown");
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    const crashedCoin = SYNC_ORDERED_CONFIGURED_COINS[0]!;
    const suffixCoin = SYNC_ORDERED_CONFIGURED_COINS[1]!;
    const identity = checkpointIdentity(2, "recovery-owner");
    const db = mockD1([
      checkpointTable({
        attemptNo: 2,
        invocationId: identity.invocationId,
        nextItemKey: crashedCoin.id,
        currentItemKey: crashedCoin.id,
        currentDomainAttemptId: "crashed-authoritative-attempt",
        itemsDone: 0,
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
    const historyRepair = history.find((entry) => (
      entry.sql.includes("INSERT OR IGNORE INTO reserve_composition_history")
      && entry.sql.includes("SELECT c.stablecoin_id")
    ));

    expect(itemStarts).toHaveLength(CONFIGURED_COIN_COUNT - 1);
    expect(boundaryWrites).toHaveLength(2);
    expect(checkpointUpdates).toHaveLength(CONFIGURED_COIN_COUNT + 1);
    expect(authoritativeAdvance).toBeDefined();
    expect(terminalAdvance).toBeDefined();
    expect(history.indexOf(historyRepair!)).toBeLessThan(history.indexOf(authoritativeAdvance!));
  });


  it("skips optional finalization cleanup when the D1 tail budget is exhausted", async () => {
    let fetches = 0;
    mockAdapterRegistry(async () => {
      fetches += 1;
      if (fetches === 1) {
        nowMs += TIGHT_BUDGET.runBudgetMs + TIGHT_BUDGET.d1FinalizeTimeoutMs;
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {}, undefined, TIGHT_BUDGET);
    const metadata = parseMetadata(result?.metadata);

    expect(metadata.runBudgetTruncated).toBe(true);
    expect(metadata.finalizationTailBudgetExhausted).toBe(true);
    expect(metadata.artifactCleanupSkipped).toBe(true);
    expect(metadata.historyPruneSkipped).toBe(true);
    expect(metadata.artifactCleanup).toBeNull();
    expect(db.getHistory().some((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-history-prune-skipped"
    ))).toBe(true);
  });


  it("records deferred rows without a cache cursor", async () => {
    let fetches = 0;
    mockAdapterRegistry(async () => {
      fetches += 1;
      if (fetches === 2) nowMs += TIGHT_BUDGET.runBudgetMs;
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {}, undefined, TIGHT_BUDGET);
    const metadata = parseMetadata(result?.metadata);

    expect(metadata.runBudgetTruncated).toBe(true);
    expect(metadata.deferredCoins).toBeGreaterThan(0);
    expect(metadata.cursorTailState).toBe("complete");
    expect(db.getHistory().some((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "live-reserve:run-cursor"
    ))).toBe(false);
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
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["m0"].sharedSourceMode).toBe("source-invariant");

    const ordered = orderConfiguredCoinsForSync([
      makeQueueCoin("w1", "single-asset"),
      makeQueueCoin("i1", "liquity-v1"),
      makeQueueCoin("s1", "curated-validated"),
      makeQueueCoin("m1", "m0"),
      makeQueueCoin("i2", "gho"),
      makeQueueCoin("m2", "m0"),
    ]);

    // m2 joins its source-invariant group at m1's anchor position; everything
    // else keeps the original deterministic order within its class segment.
    expect(ordered.map((coin) => coin.id)).toEqual(["i1", "m1", "m2", "i2", "s1", "w1"]);
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
    expect(sourceInvariantAdapters).toContain("m0");

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

  it("defaults the internal run budget to 9 minutes", () => {
    expect(resolveLiveReserveSyncBudgetConfig().runBudgetMs).toBe(9 * 60 * 1000);
  });

  it("keeps default budget + finalize + margin under the 12-minute lease with headroom", () => {
    const config = resolveLiveReserveSyncBudgetConfig();
    const worstCaseMs = config.runBudgetMs + config.d1FinalizeTimeoutMs + config.finalizationMarginMs;
    // Leave at least 120s of lease headroom for the untimed pre-loop D1 load,
    // deferred-tail writes, run finalization, and cron logging. The watchdog
    // still saw cap hits with the earlier 60s assertion.
    expect(worstCaseMs).toBeLessThanOrEqual(TWELVE_MINUTE_LEASE_MS - 120_000);
  });
});
