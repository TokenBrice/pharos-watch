import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ReserveAdapterDefinition } from "../reserve-adapters/index";
import {
  mockLiveReserveD1,
  recordOutcomeSafeMock,
  recoverNoCandidateMock,
  shouldAttemptFetchMock,
} from "./live-reserves.test-support";

describe("syncLiveReserves", () => {
  type ConfiguredCoin = (typeof ACTIVE_STABLECOINS)[number] & {
    liveReservesConfig: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>;
  };

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
    return mockLiveReserveD1([
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
    const db = mockLiveReserveD1();
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
    const writeDb = mockLiveReserveD1();
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

  it("keeps stale source-age warnings degrading even when the warning code is allowlisted", async () => {
    const configuredCoin = ACTIVE_STABLECOINS.find((candidate) =>
      candidate.liveReservesConfig?.adapter === "mento"
      && candidate.liveReservesConfig.scoring?.maxSourceAgeSec === 4_000_000
    ) as ConfiguredCoin | undefined;
    expect(configuredCoin).toBeDefined();
    const coin = {
      ...configuredCoin!,
      liveReservesConfig: {
        ...configuredCoin!.liveReservesConfig,
        scoring: {
          ...configuredCoin!.liveReservesConfig.scoring,
          allowedDegradedWarningCodes: [
            ...(configuredCoin!.liveReservesConfig.scoring?.allowedDegradedWarningCodes ?? []),
            "stale-source-data",
          ],
        },
      },
    } as ConfiguredCoin;
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockLiveReserveD1();
    const result = await syncReserveCoin({
      db,
      coin,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin),
      runAdapter: async () => ({
        slices: [{ name: "Mento reserve", pct: 100, risk: "low" as const }],
        metadata: {
          freshnessMode: "verified" as const,
          sourceTimestamp: Math.floor(Date.now() / 1000) - 35 * 24 * 60 * 60,
        },
      }),
      breakerCanFetch: new Map([[`live-reserves:${coin.liveReservesConfig.breakerScope ?? coin.liveReservesConfig.adapter}`, true]]),
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

  it("keeps an allowlisted degraded warning recorded while admitting the snapshot to scoring", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) =>
      candidate.liveReservesConfig?.adapter === "reservoir"
      && candidate.liveReservesConfig.scoring?.allowedDegradedWarningCodes?.includes("unknown-position")
    ) as ConfiguredCoin | undefined;
    expect(coin).toBeDefined();
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockLiveReserveD1();
    const now = Math.floor(Date.now() / 1000);
    const result = await syncReserveCoin({
      db,
      coin: coin!,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin!),
      runAdapter: async () => ({
        slices: [{ name: "Reservoir reserve", pct: 100, risk: "low" as const }],
        metadata: { freshnessMode: "verified" as const, sourceTimestamp: now },
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
    const compositionWrite = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT INTO reserve_composition (")
    ));
    expect(finalizeSuccess?.binds).toContain("ok");
    expect(finalizeSuccess?.binds.some((bind) =>
      typeof bind === "string" && bind.includes("unknown-position")
    )).toBe(true);
    expect(compositionWrite?.binds.some((bind) =>
      typeof bind === "string" && bind.includes("unknown-position")
    )).toBe(true);

    expect(finalizeSuccess).toBeDefined();
    expect(compositionWrite).toBeDefined();
    const persistedDb = mockLiveReserveD1([
      {
        match: "FROM reserve_sync_state",
        rows: [{
          stablecoin_id: coin!.id,
          adapter_key: finalizeSuccess!.binds[0],
          breaker_key: finalizeSuccess!.binds[1],
          last_attempted_at: finalizeSuccess!.binds[2],
          last_success_at: finalizeSuccess!.binds[3],
          last_status: finalizeSuccess!.binds[4],
          warning_count: finalizeSuccess!.binds[5],
          warnings: finalizeSuccess!.binds[6],
          last_error: finalizeSuccess!.binds[7],
          metadata: finalizeSuccess!.binds[8],
          last_attempt_id: finalizeSuccess!.binds[9],
          pending_attempt_id: null,
          last_success_attempt_id: finalizeSuccess!.binds[10],
        }],
      },
      {
        match: "FROM reserve_composition",
        rows: [{
          stablecoin_id: compositionWrite!.binds[0],
          slices: compositionWrite!.binds[1],
          fetched_at: compositionWrite!.binds[2],
          source: compositionWrite!.binds[3],
          attempt_id: compositionWrite!.binds[4],
          metadata: compositionWrite!.binds[5],
          warning_count: compositionWrite!.binds[6],
          warnings: compositionWrite!.binds[7],
          adapter_source_model: compositionWrite!.binds[8],
          adapter_evidence_class: compositionWrite!.binds[9],
        }],
      },
    ]);
    const { loadFreshIndependentLiveReserveMap } = await import("../../lib/live-reserves-store");
    const scoringMap = await loadFreshIndependentLiveReserveMap(persistedDb, now);
    expect(scoringMap.has(coin!.id)).toBe(true);
  });

  it("keeps the sync degraded when an allowlisted warning accompanies an unallowlisted warning", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) =>
      candidate.liveReservesConfig?.adapter === "reservoir"
      && candidate.liveReservesConfig.scoring?.allowedDegradedWarningCodes?.includes("unknown-position")
    ) as ConfiguredCoin | undefined;
    expect(coin).toBeDefined();
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockLiveReserveD1();
    const now = Math.floor(Date.now() / 1000);
    const result = await syncReserveCoin({
      db,
      coin: coin!,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin!),
      runAdapter: async () => ({
        slices: [{ name: "Reservoir reserve", pct: 100, risk: "low" as const }],
        metadata: { freshnessMode: "verified" as const, sourceTimestamp: now },
        warnings: [
          {
            code: "unknown-position",
            message: "Unmapped reserve position: reviewed-farm",
            severity: "warning" as const,
            effect: "degraded" as const,
          },
          {
            code: "unreviewed-position",
            message: "Unmapped reserve position: new-farm",
            severity: "warning" as const,
            effect: "degraded" as const,
          },
        ],
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
    expect(finalizeSuccess?.binds.some((bind) => (
      typeof bind === "string"
      && bind.includes("unknown-position")
      && bind.includes("unreviewed-position")
    ))).toBe(true);
  });

  it("fails on a fatal warning even when its code is allowlisted", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) =>
      candidate.liveReservesConfig?.adapter === "reservoir"
      && candidate.liveReservesConfig.scoring?.allowedDegradedWarningCodes?.includes("unknown-position")
    ) as ConfiguredCoin | undefined;
    expect(coin).toBeDefined();
    const { syncReserveCoin } = await import("../sync-live-reserves-core");
    const db = mockLiveReserveD1();
    const result = await syncReserveCoin({
      db,
      coin: coin!,
      signal: new AbortController().signal,
      adapter: adapterForCoin(coin!),
      runAdapter: async () => ({
        slices: [{ name: "Reservoir reserve", pct: 100, risk: "low" as const }],
        metadata: { freshnessMode: "verified" as const, sourceTimestamp: Math.floor(Date.now() / 1000) },
        warnings: [{
          code: "unknown-position",
          message: "Fatal reserve telemetry failure",
          severity: "warning" as const,
          effect: "fatal" as const,
        }],
      }),
      breakerCanFetch: new Map([[`live-reserves:${coin!.liveReservesConfig.breakerScope ?? coin!.liveReservesConfig.adapter}`, true]]),
      d1FinalizeTimeoutMs: 30_000,
      previousState: null,
    });

    expect(result.status).toBe("failed");
    const finalizeFailure = db.getHistory().find((entry) => (
      entry.sql.includes("UPDATE reserve_sync_state")
      && entry.binds.includes("error")
    ));
    expect(finalizeFailure?.binds.some((bind) =>
      typeof bind === "string" && bind.includes("unknown-position")
    )).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO reserve_composition ("))).toBe(false);
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
    const db = mockLiveReserveD1();

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
    const db = mockLiveReserveD1();

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
      db: mockLiveReserveD1(),
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
