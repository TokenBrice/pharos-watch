import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters-definitions";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { LIVE_RESERVE_RUN_CURSOR_CACHE_KEY } from "../../lib/operational-cache-keys";
import {
  CONFIGURED_COINS,
  LIVE_RESERVE_QUEUE_HASH,
  SYNC_ORDERED_CONFIGURED_COINS,
  breakerKeyForConfig,
  orderConfiguredCoinsForSync,
  type ConfiguredCoin,
} from "../sync-live-reserves-shared";
import { resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";

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

const CURSOR_CACHE_KEY = LIVE_RESERVE_RUN_CURSOR_CACHE_KEY;
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
  cursorOwnership?: "global" | "checkpoint";
  childDisposition?: "not_started" | "completed";
  cursorRetiredByRecovery?: boolean;
  cursorPreservedAfterError?: boolean;
}

type RecoveryCursorTestPhase = "producer" | "resume-producer" | "recovery" | "next-producer";

function mockAdapterRegistry(
  fetchImpl: (
    coin?: (typeof ACTIVE_STABLECOINS)[number],
    config?: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>,
  ) => Promise<{
    slices: Array<{ name: string; pct: number; risk: "low" }>;
    metadata?: Record<string, unknown>;
  }>,
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

function parseMetadata(metadata: string | undefined): RunMetadata {
  return JSON.parse(metadata ?? "{}") as RunMetadata;
}

function getCursorWrites(db: MockD1Database): Array<Record<string, unknown>> {
  return db.getHistory()
    .filter((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === CURSOR_CACHE_KEY
    ))
    .map((entry) => JSON.parse(entry.binds[1] as string) as Record<string, unknown>);
}

function cursorTable(cursorValue: string): MockTableConfig {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [CURSOR_CACHE_KEY],
    rows: [],
    first: { value: cursorValue, updated_at: 0 },
  };
}

function checkpointTable(input: {
  attemptNo: number;
  invocationId: string;
  nextItemKey: string | null;
  itemsDone: number;
  state?: "running" | "recovering";
  sourceAttemptNo?: number | null;
  slotStartedAt?: number;
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
      current_item_key: null,
      current_domain_attempt_id: null,
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

function getGlobalCursorOperations(db: MockD1Database) {
  return db.getHistory().filter((entry) => (
    entry.binds[0] === CURSOR_CACHE_KEY
    && (
      entry.sql.includes("SELECT value, updated_at FROM cache")
      || entry.sql.includes("INSERT OR REPLACE INTO cache")
      || entry.sql.includes("DELETE FROM cache")
    )
  ));
}

/** Makes the Nth read of the run-cursor cache row throw, leaving other cache reads intact. */
function failNthCursorRead(db: MockD1Database, failOnRead: number): MockD1Database {
  const originalPrepare = db.prepare.bind(db);
  let cursorReads = 0;
  (db as { prepare: D1Database["prepare"] }).prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("SELECT value, updated_at FROM cache")) return statement;
    const originalBind = statement.bind.bind(statement);
    return Object.assign(statement, {
      bind: (...binds: unknown[]) => {
        const bound = originalBind(...binds);
        if (binds[0] !== CURSOR_CACHE_KEY) return bound;
        const originalFirst = bound.first.bind(bound);
        return Object.assign(bound, {
          first: (async () => {
            cursorReads += 1;
            if (cursorReads === failOnRead) throw new Error("cursor cache read unavailable");
            return originalFirst();
          }) as typeof bound.first,
        });
      },
    });
  }) as D1Database["prepare"];
  return db;
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
      synced: 99,
      failed: 0,
      skipped: 1,
      deferredSkipped: 1,
      circuitSkipped: 0,
      deferredCoins: 1,
      total: 100,
    })).toBe("degraded");
  });

  it("preserves an adopted global cursor when the entire suffix errors", async () => {
    mockAdapterRegistry(async () => {
      throw new Error("adapter unavailable");
    });
    const cursorCoin = SYNC_ORDERED_CONFIGURED_COINS[SYNC_ORDERED_CONFIGURED_COINS.length - 1]!;
    const cursorValue = JSON.stringify({
      nextStablecoinId: cursorCoin.id,
      deferredCount: 1,
      deferredAt: 1_700_000_000,
      reason: "run-budget-exhausted",
      tailState: "complete",
      cursorRecordedAt: 1_700_000_000,
      runBudgetTruncationCount: 1,
      cursorOwner: {
        scheduleKey: "fourHourlyReserveSync",
        slotStartedAt: 1_000,
        attemptNo: 1,
        executionGeneration: 1,
        invocationId: "producer-owner-1",
        queueHash: LIVE_RESERVE_QUEUE_HASH,
      },
    });
    const identity = checkpointIdentity(1, "producer-owner-2", 2_000);
    const db = mockD1([
      cursorTable(cursorValue),
      checkpointTable({
        attemptNo: 1,
        invocationId: identity.invocationId,
        nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]!.id,
        itemsDone: 0,
        state: "running",
        sourceAttemptNo: null,
        slotStartedAt: 2_000,
      }),
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

    expect(result.status).toBe("error");
    expect(parseMetadata(result.metadata)).toMatchObject({
      cursorOwnership: "global",
      cursorPreservedAfterError: true,
    });
    expect(getGlobalCursorOperations(db).some((entry) => (
      entry.sql.includes("DELETE FROM cache WHERE key")
    ))).toBe(false);
  });

  it("truncates the queue tail on budget exhaustion, recording skipped rows and a resume cursor", async () => {
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
    expect(metadata.synced).toBeGreaterThanOrEqual(1);
    expect(metadata.deferredCoins).toBeGreaterThan(0);
    expect(metadata.cursorTailState).toBe("complete");
    expect(metadata.runBudgetTruncationCount).toBe(1);
    expect(typeof metadata.cursorRecordedAt).toBe("number");
    expect(typeof metadata.cursorTailCompletedAt).toBe("number");
    expect((metadata.synced ?? 0) + (metadata.failed ?? 0) + (metadata.skipped ?? 0)).toBe(CONFIGURED_COIN_COUNT);
    expect(typeof metadata.nextCursorStablecoinId).toBe("string");

    // Every deferred coin gets a skipped sync-state row plus an attempt-history row.
    const deferredStateRows = db.getHistory().filter((entry) => (
      entry.sql.includes("INSERT INTO reserve_sync_state")
      && entry.binds.some((bind) => bind === "run-budget-exhausted")
    ));
    expect(deferredStateRows).toHaveLength(metadata.deferredCoins!);
    const deferredAttemptRows = db.getHistory().filter((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("run-budget-exhausted"))
      && entry.binds.includes("skipped")
    ));
    expect(deferredAttemptRows).toHaveLength(metadata.deferredCoins!);

    // Cursor is persisted before the deferred rows, then marked complete.
    const cursorWrites = getCursorWrites(db);
    expect(cursorWrites).toHaveLength(2);
    expect(cursorWrites[0]).toMatchObject({
      nextStablecoinId: metadata.nextCursorStablecoinId,
      deferredCount: metadata.deferredCoins,
      reason: "run-budget-exhausted",
      tailState: "recording",
    });
    expect(cursorWrites[1]).toMatchObject({
      nextStablecoinId: metadata.nextCursorStablecoinId,
      deferredCount: metadata.deferredCoins,
      tailState: "complete",
    });
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

  it("resumes from the first deferred coin on the next run without wrapping into the priority head", async () => {
    let activeRun = 1;
    let fetches = 0;
    const visitedByRun = new Map<number, string[]>();
    mockAdapterRegistry(async (coin) => {
      const visited = visitedByRun.get(activeRun) ?? [];
      visited.push(coin?.id ?? "unknown");
      visitedByRun.set(activeRun, visited);
      if (activeRun === 1) {
        fetches += 1;
        if (fetches === 2) nowMs += TIGHT_BUDGET.runBudgetMs;
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const firstDb = mockD1();
    const firstRun = await syncLiveReserves(firstDb, new AbortController().signal, {}, undefined, TIGHT_BUDGET);
    const firstMetadata = parseMetadata(firstRun?.metadata);
    const cursorValue = JSON.stringify(getCursorWrites(firstDb)[1]);

    expect(firstMetadata.runBudgetTruncated).toBe(true);
    expect(typeof firstMetadata.nextCursorStablecoinId).toBe("string");

    activeRun = 2;
    nowMs = 1_700_100_000_000;
    const headBreakerCacheKey = `circuit:${breakerKeyForConfig(SYNC_ORDERED_CONFIGURED_COINS[0]!.liveReservesConfig!)}`;
    const staleBreakerCacheKey = "circuit:live-reserves:removed-adapter";
    const resumedDb = mockD1([
      cursorTable(cursorValue),
      {
        match: "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'",
        rows: [{ key: headBreakerCacheKey }, { key: staleBreakerCacheKey }],
      },
    ]);
    const secondRun = await syncLiveReserves(resumedDb, new AbortController().signal, {}, undefined, TIGHT_BUDGET);
    const secondMetadata = parseMetadata(secondRun?.metadata);

    // The cursored run starts at the first deferred coin and drains only that
    // deferred suffix. It does not wrap into the priority head until the next
    // clean run, so a low-priority tail resume cannot mark head coins skipped.
    const cursorIndex = SYNC_ORDERED_CONFIGURED_COINS.findIndex((coin) => coin.id === firstMetadata.nextCursorStablecoinId);
    expect(visitedByRun.get(2)?.[0]).toBe(firstMetadata.nextCursorStablecoinId);
    expect(visitedByRun.get(2)).not.toContain(visitedByRun.get(1)?.[0]);
    expect(secondMetadata.synced).toBe(CONFIGURED_COIN_COUNT - cursorIndex);
    expect(secondMetadata.total).toBe(CONFIGURED_COIN_COUNT - cursorIndex);
    expect(secondMetadata.deferredCoins).toBe(0);
    expect(secondMetadata.breakerKeys).not.toContain(headBreakerCacheKey.slice("circuit:".length));
    expect(secondMetadata.artifactCleanup?.breakerCacheDeleted).toBe(1);

    const breakerDeletes = resumedDb.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM cache WHERE key")
    ));
    expect(breakerDeletes.some((entry) => entry.binds.includes(headBreakerCacheKey))).toBe(false);
    expect(breakerDeletes.some((entry) => entry.binds.includes(staleBreakerCacheKey))).toBe(true);

    // The evidence-class ordering keeps independents at the queue head, so a
    // truncation this early defers an independent coin — and the cursored
    // run N+1 must sync that independent coin first, not skip it again.
    const cursorCoin = SYNC_ORDERED_CONFIGURED_COINS.find(
      (coin) => coin.id === firstMetadata.nextCursorStablecoinId,
    );
    expect(cursorCoin).toBeDefined();
    expect(
      LIVE_RESERVE_ADAPTER_DEFINITIONS[cursorCoin!.liveReservesConfig!.adapter].evidenceClass,
    ).toBe("independent");

    // A clean follow-up run clears the persisted cursor.
    const cursorDelete = resumedDb.getHistory().find((entry) => (
      entry.sql.includes("DELETE FROM cache WHERE key = ?")
      && entry.binds[0] === CURSOR_CACHE_KEY
    ));
    expect(cursorDelete).toBeDefined();
  });

  it("keeps truncated recovery progress checkpoint-owned and resumes its suffix without touching a newer global cursor", async () => {
    let activeAttempt = 2;
    let firstAttemptFetches = 0;
    const visitedByAttempt = new Map<number, string[]>();
    mockAdapterRegistry(async (coin) => {
      const visited = visitedByAttempt.get(activeAttempt) ?? [];
      visited.push(coin?.id ?? "unknown");
      visitedByAttempt.set(activeAttempt, visited);
      if (activeAttempt === 2) {
        firstAttemptFetches += 1;
        if (firstAttemptFetches === 1) nowMs += TIGHT_BUDGET.runBudgetMs;
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const globalCursorCoin = SYNC_ORDERED_CONFIGURED_COINS[SYNC_ORDERED_CONFIGURED_COINS.length - 1]!;
    const newerGlobalCursor = JSON.stringify({
      nextStablecoinId: globalCursorCoin.id,
      deferredCount: 1,
      deferredAt: 1_800_000_000,
      reason: "run-budget-exhausted",
      tailState: "complete",
      cursorRecordedAt: 1_800_000_000,
      runBudgetTruncationCount: 7,
      cursorOwner: {
        scheduleKey: "fourHourlyReserveSync",
        slotStartedAt: 2_000,
        attemptNo: 1,
        executionGeneration: 1,
        invocationId: "newer-producer-owner",
        queueHash: LIVE_RESERVE_QUEUE_HASH,
      },
    });
    const firstIdentity = checkpointIdentity(2, "recovery-owner-2");
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const firstDb = mockD1([
      cursorTable(newerGlobalCursor),
      checkpointTable({
        attemptNo: 2,
        invocationId: firstIdentity.invocationId,
        nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]!.id,
        itemsDone: 0,
      }),
    ]);

    const firstResult = await syncLiveReserves(
      firstDb,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      firstIdentity,
    );
    const firstMetadata = parseMetadata(firstResult.metadata);
    const firstAdvances = firstDb.getHistory().filter((entry) => (
      entry.sql.includes("UPDATE worker_scheduled_checkpoints")
      && entry.sql.includes("items_done = ?")
    ));
    const partialAdvance = firstAdvances[firstAdvances.length - 1];
    const suffixId = partialAdvance?.binds[0];
    const itemsDone = partialAdvance?.binds[1];

    expect(firstResult.status).toBe("degraded");
    expect(firstMetadata).toMatchObject({
      runBudgetTruncated: true,
      cursorOwnership: "checkpoint",
      runBudgetTruncationCount: 0,
      childDisposition: "not_started",
    });
    expect(typeof suffixId).toBe("string");
    expect(itemsDone).toBeGreaterThan(0);
    expect(itemsDone).toBeLessThan(CONFIGURED_COIN_COUNT);
    expect(getGlobalCursorOperations(firstDb)).toEqual([]);

    activeAttempt = 3;
    nowMs = 1_700_100_000_000;
    const secondIdentity = checkpointIdentity(3, "recovery-owner-3");
    const secondDb = mockD1([
      cursorTable(newerGlobalCursor),
      checkpointTable({
        attemptNo: 3,
        invocationId: secondIdentity.invocationId,
        nextItemKey: suffixId as string,
        itemsDone: itemsDone as number,
      }),
    ]);

    const secondResult = await syncLiveReserves(
      secondDb,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      secondIdentity,
    );
    const secondMetadata = parseMetadata(secondResult.metadata);
    const secondAdvances = secondDb.getHistory().filter((entry) => (
      entry.sql.includes("UPDATE worker_scheduled_checkpoints")
      && entry.sql.includes("items_done = ?")
    ));

    expect(visitedByAttempt.get(3)?.[0]).toBe(suffixId);
    expect(secondMetadata).toMatchObject({
      runBudgetTruncated: false,
      cursorOwnership: "checkpoint",
      childDisposition: "completed",
      cursorRetiredByRecovery: false,
    });
    expect(secondAdvances[secondAdvances.length - 1]?.binds.slice(0, 2)).toEqual([
      null,
      CONFIGURED_COIN_COUNT,
    ]);
    const secondCursorOperations = getGlobalCursorOperations(secondDb);
    expect(secondCursorOperations).toHaveLength(1);
    expect(secondCursorOperations[0]?.sql).toContain("SELECT value, updated_at FROM cache");
  });

  it("retires an exact producer cursor after recovery so the next normal checkpoint starts at the head", async () => {
    let phase: RecoveryCursorTestPhase = "producer";
    let fetches = 0;
    const visitedByPhase = new Map<RecoveryCursorTestPhase, string[]>();
    mockAdapterRegistry(async (coin) => {
      const visited = visitedByPhase.get(phase) ?? [];
      visited.push(coin?.id ?? "unknown");
      visitedByPhase.set(phase, visited);
      fetches += 1;
      if (phase === "producer" && fetches === 1) nowMs += TIGHT_BUDGET.runBudgetMs;
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    const identity = checkpointIdentity(1, "producer-owner-1");
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([checkpointTable({
      attemptNo: 1,
      invocationId: identity.invocationId,
      nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]!.id,
      itemsDone: 0,
      state: "running",
      sourceAttemptNo: null,
    })]);

    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      identity,
    );
    const metadata = parseMetadata(result.metadata);

    expect(metadata).toMatchObject({
      runBudgetTruncated: true,
      cursorOwnership: "global",
      childDisposition: "not_started",
    });
    const cursorWrites = getCursorWrites(db);
    expect(cursorWrites[cursorWrites.length - 1]).toMatchObject({
      cursorOwner: {
        scheduleKey: "fourHourlyReserveSync",
        slotStartedAt: 1_000,
        queueHash: LIVE_RESERVE_QUEUE_HASH,
      },
    });
    const producerAdvances = db.getHistory().filter((entry) => (
      entry.sql.includes("UPDATE worker_scheduled_checkpoints")
      && entry.sql.includes("items_done = ?")
    ));
    const producerAdvance = producerAdvances[producerAdvances.length - 1];
    const suffixId = producerAdvance?.binds[0] as string;
    const itemsDone = producerAdvance?.binds[1] as number;

    phase = "resume-producer";
    nowMs = 1_700_050_000_000;
    const resumeIdentity = checkpointIdentity(1, "producer-owner-resume", 1_500);
    const resumeDb = mockD1([
      cursorTable(JSON.stringify(cursorWrites[cursorWrites.length - 1])),
      checkpointTable({
        attemptNo: 1,
        invocationId: resumeIdentity.invocationId,
        nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]!.id,
        itemsDone: 0,
        state: "running",
        sourceAttemptNo: null,
        slotStartedAt: 1_500,
      }),
    ]);
    await syncLiveReserves(
      resumeDb,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      resumeIdentity,
    );
    expect(visitedByPhase.get("resume-producer")?.[0]).toBe(suffixId);
    const adoptedFrontier = resumeDb.getHistory().find((entry) => (
      entry.sql.includes("UPDATE worker_scheduled_checkpoints")
      && entry.binds[0] === suffixId
      && entry.binds[1] === itemsDone
    ));
    expect(adoptedFrontier).toBeDefined();

    phase = "recovery";
    nowMs = 1_700_100_000_000;
    const recoveryIdentity = checkpointIdentity(2, "recovery-owner-2");
    const recoveryDb = mockD1([
      cursorTable(JSON.stringify(cursorWrites[cursorWrites.length - 1])),
      checkpointTable({
        attemptNo: 2,
        invocationId: recoveryIdentity.invocationId,
        nextItemKey: suffixId,
        itemsDone,
      }),
    ]);
    const recoveryResult = await syncLiveReserves(
      recoveryDb,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      recoveryIdentity,
    );
    expect(parseMetadata(recoveryResult.metadata)).toMatchObject({
      cursorOwnership: "checkpoint",
      cursorRetiredByRecovery: true,
      childDisposition: "completed",
    });
    expect(getGlobalCursorOperations(recoveryDb).some((entry) => (
      entry.sql.includes("DELETE FROM cache WHERE key = ? AND value = ?")
    ))).toBe(true);

    phase = "next-producer";
    nowMs = 1_700_200_000_000;
    const nextIdentity = checkpointIdentity(1, "producer-owner-2", 2_000);
    const nextDb = mockD1([checkpointTable({
      attemptNo: 1,
      invocationId: nextIdentity.invocationId,
      nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]!.id,
      itemsDone: 0,
      state: "running",
      sourceAttemptNo: null,
      slotStartedAt: 2_000,
    })]);
    await syncLiveReserves(
      nextDb,
      new AbortController().signal,
      {},
      undefined,
      TIGHT_BUDGET,
      nextIdentity,
    );
    expect(visitedByPhase.get("next-producer")?.[0]).toBe(SYNC_ORDERED_CONFIGURED_COINS[0]!.id);
    expect(visitedByPhase.get("next-producer")?.[0]).not.toBe(suffixId);
  });


  it("does not defer the high-priority head when a resumed weak-probe tail truncates again", async () => {
    const weakTail = [...SYNC_ORDERED_CONFIGURED_COINS].reverse().find(
      (coin) => LIVE_RESERVE_ADAPTER_DEFINITIONS[coin.liveReservesConfig!.adapter].evidenceClass === "weak-live-probe",
    );
    const independentHead = SYNC_ORDERED_CONFIGURED_COINS.find(
      (coin) => LIVE_RESERVE_ADAPTER_DEFINITIONS[coin.liveReservesConfig!.adapter].evidenceClass === "independent",
    );
    expect(weakTail).toBeDefined();
    expect(independentHead).toBeDefined();

    const visited: string[] = [];
    mockAdapterRegistry(async (coin) => {
      visited.push(coin?.id ?? "unknown");
      nowMs += TIGHT_BUDGET.runBudgetMs;
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([cursorTable(JSON.stringify({
      nextStablecoinId: weakTail!.id,
      deferredCount: 1,
      deferredAt: 1_700_000_000,
      reason: "run-budget-exhausted",
      runBudgetTruncationCount: 1,
    }))]);

    const result = await syncLiveReserves(db, new AbortController().signal, {}, undefined, TIGHT_BUDGET);
    const metadata = parseMetadata(result?.metadata);

    expect(visited).toEqual([weakTail!.id]);
    expect(metadata.runBudgetTruncated).toBe(false);
    expect(metadata.deferredCoins).toBe(0);

    const deferredStateRows = db.getHistory().filter((entry) => (
      entry.sql.includes("INSERT INTO reserve_sync_state")
      && entry.binds.some((bind) => bind === "run-budget-exhausted")
    ));
    expect(deferredStateRows.some((entry) => entry.binds.includes(independentHead!.id))).toBe(false);
  });

  it("starts from the top of the queue when the persisted cursor JSON is malformed", async () => {
    let activeRun = 1;
    const visitedByRun = new Map<number, string[]>();
    mockAdapterRegistry(async (coin) => {
      const visited = visitedByRun.get(activeRun) ?? [];
      visited.push(coin?.id ?? "unknown");
      visitedByRun.set(activeRun, visited);
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const baselineDb = mockD1();
    await syncLiveReserves(baselineDb, new AbortController().signal, {});

    activeRun = 2;
    const corruptedDb = mockD1([cursorTable("{not-valid-json")]);
    const result = await syncLiveReserves(corruptedDb, new AbortController().signal, {});

    expect(result?.status).toBe("ok");
    expect(visitedByRun.get(2)?.[0]).toBe(visitedByRun.get(1)?.[0]);
    expect(parseMetadata(result?.metadata).synced).toBe(CONFIGURED_COIN_COUNT);
  });

  it("starts from the top of the ordered queue when the cursor coin is no longer configured", async () => {
    const visited: string[] = [];
    mockAdapterRegistry(async (coin) => {
      visited.push(coin?.id ?? "unknown");
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([cursorTable(JSON.stringify({
      nextStablecoinId: "ghost-coin-removed-in-deploy",
      deferredCount: 5,
      deferredAt: 1_700_000_000,
      reason: "run-budget-exhausted",
    }))]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(result?.status).toBe("ok");
    expect(visited[0]).toBe(SYNC_ORDERED_CONFIGURED_COINS[0]!.id);
    expect(parseMetadata(result?.metadata).synced).toBe(CONFIGURED_COIN_COUNT);
  });

  it("records live-reserve-cursor-read-failed and restarts the truncation count when the prior cursor read fails during deferral", async () => {
    let fetches = 0;
    mockAdapterRegistry(async () => {
      fetches += 1;
      if (fetches === 2) nowMs += TIGHT_BUDGET.runBudgetMs;
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    // Read 1 happens at run start; read 2 is recordDeferredTail's previous-cursor read.
    const db = failNthCursorRead(mockD1(), 2);
    const result = await syncLiveReserves(db, new AbortController().signal, {}, undefined, TIGHT_BUDGET);
    const metadata = parseMetadata(result?.metadata);

    expect(metadata.runBudgetTruncated).toBe(true);

    const cursorReadEvent = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-cursor-read-failed"
    ));
    expect(cursorReadEvent).toBeDefined();
    expect(JSON.parse(cursorReadEvent!.binds[1] as string)).toMatchObject({
      metadata: { error: "cursor cache read unavailable" },
    });

    const cursorWrites = getCursorWrites(db);
    expect(cursorWrites.length).toBeGreaterThan(0);
    expect(cursorWrites[cursorWrites.length - 1]).toMatchObject({
      tailState: "complete",
      runBudgetTruncationCount: 1,
    });
  });
});

describe("run-budget deferred rows and persistent-stale alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildSkippedSyncStateRow(
    coin: (typeof ACTIVE_STABLECOINS)[number],
    failureCategory: "run-budget-exhausted" | "circuit-open",
    now: number,
  ) {
    const config = coin.liveReservesConfig!;
    return {
      stablecoin_id: coin.id,
      adapter_key: config.adapter,
      breaker_key: `live-reserves:${config.breakerScope ?? config.adapter}`,
      last_attempted_at: now,
      last_success_at: now - 15 * 24 * 60 * 60,
      last_status: "skipped",
      warning_count: 0,
      warnings: null,
      last_error: failureCategory === "run-budget-exhausted" ? "run-budget-exhausted" : null,
      metadata: JSON.stringify({ failureCategory }),
      last_attempt_id: null,
      pending_attempt_id: null,
      last_success_attempt_id: `${coin.id}:previous-success`,
    };
  }

  it("excludes run-budget deferred rows from persistent-stale independent detection", async () => {
    const now = 1_900_000_000;
    const independentCoins = ACTIVE_STABLECOINS.filter((coin) => {
      const config = coin.liveReservesConfig;
      return config && LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter].evidenceClass === "independent";
    });
    expect(independentCoins.length).toBeGreaterThanOrEqual(2);
    const [deferredCoin, circuitOpenCoin] = independentCoins;

    const db = mockD1([
      {
        match: "FROM reserve_sync_state",
        rows: [
          buildSkippedSyncStateRow(deferredCoin!, "run-budget-exhausted", now),
          buildSkippedSyncStateRow(circuitOpenCoin!, "circuit-open", now),
        ],
      },
    ]);

    const { computeReserveCompositionOverview } = await import("../../lib/live-reserves-store");
    const overview = await computeReserveCompositionOverview(db, now);
    const persistentlyStaleIds = overview.persistentlyStaleIndependentCoins.map(
      (entry) => entry.stablecoinId,
    );

    // Circuit-open skips with a weeks-old last success escalate; run-budget
    // deferred rows are scheduler capacity pressure and must not alert.
    expect(persistentlyStaleIds).toContain(circuitOpenCoin!.id);
    expect(persistentlyStaleIds).not.toContain(deferredCoin!.id);
    expect(overview.deferredCoins).toBe(1);
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
