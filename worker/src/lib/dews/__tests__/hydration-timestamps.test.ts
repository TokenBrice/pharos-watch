import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { hydrateDexLiquidity, hydrateDexLiquidityHistory, hydrateDexPrices, hydrateLatestPsiScore, hydrateMintBurn, hydrateYieldRankingsCache, hydrateYieldWarnings } from "../source-state/hydration";
import { DEWS_PSI_FRESHNESS_BUDGET_SEC, DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC } from "../source-state/budgets";
import { computeDEWS } from "../../dews";
import { makeDewsInput } from "../../__tests__/dews.test-support";
import { makeDexLiquidityRow } from "../../../test-helpers/__shared/fixtures";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { loadDewsSourceState } from "../source-state";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { resolveCronTimeoutBudget } from "../../cron-timeouts";
import { aggregateFlowCacheKey } from "../../mint-burn-flow-cache-keys";
import { getMintBurnConfigsForStablecoin, MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { mintBurnConfigKey } from "../../mint-burn-pipeline/sync-state";

const RUN_AT = 1_800_000_000;
const YIELD_BUDGET_SEC = CRON_INTERVALS["sync-yield-data"]
  + resolveCronTimeoutBudget("sync-yield-data").configuredTimeoutMs / 1000;
afterEach(() => vi.useRealTimers());

describe("DEWS hydration timestamp admission", () => {
  it.each(["missing", "scope-missing", "scope-missing-disabled", "scope-missing-new", "pending", "disabled", "incomplete", "wrong-window", "quiet", "eventful", "compact", "compact-missing-pairs", "materialization-debt"] as const)(
    "keeps mint/burn scan admission distinct from observed data: %s", async (state) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      const end = Math.floor(RUN_AT / 3600) * 3600;
      const configIndex = MINT_BURN_CONFIGS.findIndex((config) => config.stablecoinId === "usdt-tether");
      const originalConfig = MINT_BURN_CONFIGS[configIndex];
      try {
        if (state !== "missing") {
          const window = { complete: state !== "incomplete", unavailableReason: state === "incomplete" ? "scan-coverage-incomplete" : null };
          const value = { gauge: { score: null }, updatedAt: end,
            ...(state.startsWith("scope-missing") ? {} : { publication: {
              evaluatedAt: RUN_AT, requiredBaselineSec: 90 * 86400, freshnessBudgetSec: 7200,
              legs: [{ configKey: "synthetic", configFingerprint: "synthetic-v1", stablecoinId: "usdt-tether", chainId: "ethereum",
                status: state === "pending" ? "pending-admission" : state === "disabled" ? "disabled" : "admitted",
                reason: state === "pending" ? "baseline-incomplete" : state === "disabled" ? "operator-disabled" : null,
                admittedAt: null, baselineFrom: end - 90 * 86400, baselineTo: end, coveredSeconds: 90 * 86400, frontierAgeSec: 0 }],
              ...(state.startsWith("compact") ? { legsScope: "non-admitted", legs: [],
                ...(state === "compact" ? { admittedPairs: [["usdt-tether", "ethereum"], ["usdt-tether", "tron"]] } : {}) } : {}),
            } }),
            window: { start: end - 86400, end: state === "wrong-window" ? end - 3600 : end, semantics: "closed-utc-hours" },
            coins: [{ stablecoinId: "usdt-tether", symbol: "USDT", pressureShiftScore: null, netFlow24hUsd: null,
              coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: end - 90 * 86400,
                has24hWindow: state !== "incomplete", has30dWindow: true, has90dWindow: true, isPartial: false, status: "full",
                windows: { window24h: window, window7d: window, window30d: window, window90d: window } } }] };
          sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(aggregateFlowCacheKey(24), JSON.stringify(value), RUN_AT);
        }
        if (["eventful", "compact", "compact-missing-pairs", "missing", "incomplete", "pending", "disabled"].includes(state) || state.startsWith("scope-missing")) {
          sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
            mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
            VALUES ('usdt-tether', 'ethereum', ?, 0, 1, 0, 0, 0, 700000, -700000)`).run(end - 3600);
        }
        if (state === "materialization-debt") {
          sqlite.prepare("INSERT INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts) VALUES ('usdt-tether', 'ethereum', ?)")
            .run(end - 3600);
        }
        if (state === "scope-missing-disabled") {
          sqlite.prepare("INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)")
            .run(JSON.stringify(getMintBurnConfigsForStablecoin("usdt-tether").map(mintBurnConfigKey)), RUN_AT);
        }
        if (state === "scope-missing-new") {
          MINT_BURN_CONFIGS[configIndex] = { ...originalConfig, contractAddress: "0x9999999999999999999999999999999999999999" };
        }
        const hydrated = await hydrateMintBurn({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() });
        const snapshot = hydrated.mintBurnMap.get("usdt-tether");
        if (state === "quiet" || state === "eventful" || state === "compact" || state === "scope-missing") {
          expect(snapshot).toMatchObject({ burn24h: state === "quiet" ? 0 : 700_000, baselineDays: 30,
            burnBaseline: state === "quiet" ? 0 : 700_000 / 30 });
        } else expect(snapshot).toBeUndefined();
      } finally {
        MINT_BURN_CONFIGS[configIndex] = originalConfig;
        sqlite.close();
      }
    },
  );
  it.each([
    ["valid", RUN_AT, 0, null],
    ["inclusive budget", RUN_AT - YIELD_BUDGET_SEC, 0, null],
    ["retained last-good", RUN_AT - YIELD_BUDGET_SEC - 1, 0, null],
    ["inclusive retention budget", RUN_AT - DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC, 0, null],
    ["stale", RUN_AT - DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC - 1, 0, "exceeds"],
    ["run/read overlap", RUN_AT + 120, 120, null],
    ["inclusive read skew", RUN_AT + 180, 120, null],
    ["beyond read skew", RUN_AT + 181, 120, "future-timestamp"],
    ["one day future", RUN_AT + 86400, 0, "future-timestamp"],
    ["invalid", Number.POSITIVE_INFINITY, 0, "invalid-timestamp"],
    ["missing", null, 0, "missing-timestamp"],
  ] as const)("holds inadmissible %s yield clocks without discarding readable diagnostics", async (_label, updatedAt, readOffset, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime((RUN_AT + readOffset) * 1000);
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateYieldRankingsCache({
      db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
        updated_at: updatedAt,
        value: JSON.stringify({ rankings: [{
          id: "usdt-tether", sourceRisk: { rewardShare: 0.9 },
          rankChangeAttribution: { rankDelta: -5, primaryDriver: "source-risk" },
        }] }),
      } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.yieldSourceRisk.get("usdt-tether")?.rewardShare).toBe(0.9);
    expect(hydrated.yieldRankChangeAttribution.get("usdt-tether")).toMatchObject({
      rankDelta: -5, primaryDriver: "source-risk",
    });
    if (reason == null) {
      expect(registerSourceFailure).not.toHaveBeenCalled();
    } else {
      expect(registerSourceFailure).toHaveBeenCalledTimes(1);
      expect(registerSourceFailure).toHaveBeenCalledWith("yield-rankings-freshness", expect.stringContaining(reason));
    }
  });

  it.each([
    ["fresh", RUN_AT - YIELD_BUDGET_SEC, YIELD_BUDGET_SEC, false, null],
    ["retained", RUN_AT - YIELD_BUDGET_SEC - 1, YIELD_BUDGET_SEC + 1, true, "retained-last-good"],
    ["stale", RUN_AT - DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC - 1, null, false, "stale-generation"],
  ] as const)("names the %s yield-rankings generation, age and retention budget", async (_label, updatedAt, ageSec, retained, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT * 1000);
    const hydrated = await hydrateYieldRankingsCache({
      db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
        updated_at: updatedAt,
        value: JSON.stringify({ rankings: [{ id: "usdt-tether", sourceRisk: { rewardShare: 0.9 } }] }),
      } }]),
      nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.yieldRankingsAgeSec).toBe(ageSec);
    expect(hydrated.yieldRankingsRetained).toBe(retained);
    expect(hydrated.dependencyDiagnostics).toEqual({
      generationId: `yield-rankings:${updatedAt}`,
      updatedAt,
      ageSeconds: RUN_AT - updatedAt,
      freshnessBudgetSec: DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC,
      reason,
    });
  });

  it.each([
    ["fresh", RUN_AT, null],
    ["boundary", RUN_AT - DEWS_PSI_FRESHNESS_BUDGET_SEC, null],
    ["stale", RUN_AT - DEWS_PSI_FRESHNESS_BUDGET_SEC - 1, "stale-sample"],
    ["future", RUN_AT + 61, "future-timestamp"],
    ["invalid", Number.POSITIVE_INFINITY, "invalid-timestamp"],
    ["missing", null, "missing-sample"],
  ] as const)("admits PSI %s with the original sample clock and budget", async (_label, storedAt, reason) => {
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateLatestPsiScore({
      db: mockD1([{ match: "stability_index_samples", rows: [], first: storedAt == null ? null : { score: 0, stored_at: storedAt } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.latestPsiScore).toBe(reason == null ? 0 : null);
    expect(hydrated.dependencyDiagnostics).toMatchObject({
      updatedAt: storedAt != null && Number.isFinite(storedAt) ? storedAt : null, freshnessBudgetSec: DEWS_PSI_FRESHNESS_BUDGET_SEC, reason,
    });
    expect(registerSourceFailure).not.toHaveBeenCalled();
    const scored = computeDEWS(makeDewsInput({ dexPriceUsd: 0.99, psiScore: hydrated.latestPsiScore }));
    expect(scored?.amplifiers.psi).toBe(reason == null ? 1.3 : 1);
  });
  it("admits an overlapping publication but excludes clocks beyond read-time skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((RUN_AT + 120) * 1000);
    const row = (stablecoin_id: string, updated_at: number) => ({
      stablecoin_id, updated_at, weighted_balance_ratio: 0.9, avg_pool_stress: 0,
      top_pools_json: "[]", liquidity_score: 80, total_tvl_usd: 1_000_000,
    });
    const db = mockD1([
      { match: "SELECT stablecoin_id, weighted_balance_ratio", rows: [
        row("overlap", RUN_AT + 120), row("allowed", RUN_AT + 180), row("future", RUN_AT + 181),
      ] },
      { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
    ]);
    const hydrated = await hydrateDexLiquidity({
      db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
    });
    expect([...hydrated.dexLiqMap.keys()]).toEqual(["overlap", "allowed"]);
    expect([...hydrated.dexLiqStaleIds]).toEqual(["future"]);
  });

  it.each([
    [0.5, 100, 36 * 3600, true],
    [0.499, 100, 36 * 3600, false],
    [null, 100, 36 * 3600, false],
    [0.5, 0, 36 * 3600, false],
    [0.5, 100, 36 * 3600 + 1, false],
  ])("admits weekly history confidence=%s TVL=%s distance=%s", async (confidence, tvl, distance, admitted) => {
    const target = RUN_AT - 7 * 86400;
    const db = mockD1([{ match: "FROM dex_liquidity_history", rows: [
      { stablecoin_id: "test", snapshot_date: target - distance, liquidity_score: 73, total_tvl_usd: tvl, coverage_confidence: confidence, methodology_version: null },
      { stablecoin_id: "test", snapshot_date: target, liquidity_score: 99, total_tvl_usd: 1000, coverage_confidence: 0.49, methodology_version: null },
    ] }]);
    const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() },
      new Map([["test", makeDexLiquidityRow({ stablecoin_id: "test" })]]));
    expect(hydrated.liqHist7dMap.get("test")).toEqual(admitted ? { score: 73, tvl: 100, date: target - distance } : undefined);
    expect(db.getHistory()[0].binds).toEqual([RUN_AT - 8.5 * 86400]);
    expect(db.getHistory()[0].sql).toContain("coverage_confidence");
  });

  it("fetches the older daily bucket at the inclusive live 8.5-day bound", async () => {
    const now = 20000 * 86400 + 12 * 3600;
    const date = (20000 - 8) * 86400;
    const db = mockD1([{ match: "FROM dex_liquidity_history", rows: [
      { stablecoin_id: "daily", snapshot_date: date, liquidity_score: 80, total_tvl_usd: 100, coverage_confidence: 0.5, methodology_version: null },
    ] }]);
    const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: now, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() },
      new Map([["daily", makeDexLiquidityRow({ stablecoin_id: "daily" })]]));
    expect(db.getHistory()[0].binds).toEqual([date]);
    expect(hydrated.liqHist7dMap.get("daily")).toEqual({ score: 80, tvl: 100, date });
  });

  it.each([
    ["6.95", "6.92", null],
    ["6.95", "6.94", 100],
    ["6.92", "6.92", 100],
    ["3.2", "3.1", 100],
  ] as const)("hydrates history against the stored current version %s, not runtime (%s)", async (current, historical, tvl) => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    const date = RUN_AT - 7 * 86400;
    try {
      sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, liquidity_score, updated_at, methodology_version) VALUES ('usdt-tether', 'USDT', 200, 80, ?, ?)")
        .run(RUN_AT, current);
      sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, total_tvl_usd, liquidity_score, snapshot_date, coverage_class, coverage_confidence, methodology_version) VALUES ('usdt-tether', 100, 73, ?, 'primary', 0.9, ?)")
        .run(date, historical);
      const hydrated = await loadDewsSourceState({
        db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
      });
      expect(hydrated.dexLiqMap.get("usdt-tether")?.methodology_version).toBe(current);
      expect(hydrated.liqHist7dMap.get("usdt-tether")).toEqual({ score: 73, tvl, date });
    } finally {
      sqlite.close();
    }
  });

  it.each(["legacy", "absent-current", "omitted-current", "omitted-history"] as const)(
    "retains independent historical scores while distinguishing %s identity", async (identity) => {
      const current = { ...makeDexLiquidityRow(), methodology_version: null as string | null };
      const history = { stablecoin_id: "usdt-tether", total_tvl_usd: 100, liquidity_score: 73,
        snapshot_date: RUN_AT - 7 * 86400, coverage_class: "primary", coverage_confidence: 0.9,
        methodology_version: null };
      if (identity === "omitted-current") Reflect.deleteProperty(current, "methodology_version");
      if (identity === "omitted-history") Reflect.deleteProperty(history, "methodology_version");
      const hydrated = await hydrateDexLiquidityHistory({
        db: mockD1([{ match: "FROM dex_liquidity_history", rows: [history] }]),
        nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
      }, identity === "absent-current" ? new Map() : new Map([["usdt-tether", current]]));
      expect(hydrated.liqHist7dMap.get("usdt-tether")).toEqual({
        score: 73, tvl: identity === "legacy" ? 100 : null, date: history.snapshot_date,
      });
    },
  );

  it("hydrates only trusted fresh dex prices and never turns a failed read into a zero count", async () => {
    const hydrated = await hydrateDexPrices({
      db: mockD1([{ match: "FROM dex_prices", rows: [
        { stablecoin_id: "trusted", dex_price_usd: 1, source_total_tvl: 2_000_000, updated_at: RUN_AT - 60 },
        { stablecoin_id: "old", dex_price_usd: 1, source_total_tvl: 2_000_000, updated_at: RUN_AT - 10 * 3600 },
        { stablecoin_id: "thin", dex_price_usd: 1, source_total_tvl: 10, updated_at: RUN_AT - 60 },
      ] }]),
      nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
    });
    expect([...hydrated.dexPriceMap]).toEqual([
      ["trusted", { dexPriceUsd: 1, sourceTotalTvl: 2_000_000, updatedAt: RUN_AT - 60 }],
    ]);
    expect(hydrated.trustedCount).toBe(1);
    expect([...hydrated.dexPriceAgeSecById]).toEqual([["trusted", 60], ["old", 36_000], ["thin", 60]]);
    expect([...hydrated.dexPriceStaleIds]).toEqual(["old"]);
    expect(hydrated.staleCount).toBe(1);

    const registerSourceFailure = vi.fn();
    const failed = await hydrateDexPrices({
      db: mockD1([{ match: "FROM dex_prices", rows: [], throwError: new Error("dex_prices read failed") }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(registerSourceFailure).toHaveBeenCalledWith("dex-prices", expect.any(Error));
    expect(failed.staleCount).toBeNull();
    expect(failed.trustedCount).toBe(0);
  });

  it("reports malformed yield warning signals without dropping the valid rows", async () => {
    const registerMalformedPersistedInput = vi.fn();
    const hydrated = await hydrateYieldWarnings({
      db: mockD1([{ match: "FROM yield_data", rows: [
        { stablecoin_id: "usdt-tether", warning_signals: JSON.stringify(["depeg", "supply"]) },
        { stablecoin_id: "usdc-circle", warning_signals: "[1]" },
      ] }]),
      nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput,
    });
    expect([...hydrated.yieldWarnings]).toEqual([["usdt-tether", ["depeg", "supply"]]]);
    expect(hydrated.rowsRead).toBe(2);
    // The service, not hydration, owns the published degradesRun value.
    expect(registerMalformedPersistedInput).toHaveBeenCalledWith(expect.objectContaining({
      source: "yield_data", context: "yield_data.warning_signals", stablecoinId: "usdc-circle",
      reason: "invalid-shape",
    }));
  });

  it("records a readable but malformed yield-rankings generation as non-degrading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT * 1000);
    const registerMalformedPersistedInput = vi.fn();
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateYieldRankingsCache({
      db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
        updated_at: RUN_AT - 60,
        value: JSON.stringify({ rankings: { not: "an array" } }),
      } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput,
    });
    expect(hydrated.dependencyDiagnostics).toEqual({
      generationId: null, updatedAt: null, ageSeconds: null,
      freshnessBudgetSec: DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC, reason: "invalid-shape",
    });
    expect(registerMalformedPersistedInput).toHaveBeenCalledWith({
      source: "yield-rankings", context: "cache.yield-rankings", stablecoinId: "aggregate",
      updatedAt: RUN_AT - 60, reason: "invalid-shape", degradesRun: false,
    });
    expect(registerSourceFailure).not.toHaveBeenCalled();
  });

  it("keeps mint/burn freshness on the 30-day row when the 24-hour window has no events", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const end = Math.floor(RUN_AT / 3600) * 3600;
    try {
      insertAdmittedMintBurnGauge(sqlite, end, RUN_AT);
      sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
        mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES ('usdt-tether', 'ethereum', ?, 0, 1, 0, 0, 0, 700000, -700000)`).run(end - 25 * 3600);
      const registerSourceFailure = vi.fn();
      const hydrated = await hydrateMintBurn({
        db, nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
      });
      expect(hydrated.mintBurnMap.get("usdt-tether")).toMatchObject({
        burn24h: 0, burnBaseline: 700_000 / 30, baselineDays: 30,
      });
      expect(hydrated.mintBurnAgeSecById.get("usdt-tether")).toBe(0);
      expect(registerSourceFailure).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it("flags a stale published mint/burn window as stale evidence and a freshness failure", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const end = Math.floor(RUN_AT / 3600) * 3600 - 26 * 3600;
    try {
      insertAdmittedMintBurnGauge(sqlite, end, RUN_AT - 3600);
      sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
        mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES ('usdt-tether', 'ethereum', ?, 0, 1, 0, 0, 0, 700000, -700000)`).run(end - 3600);
      const registerSourceFailure = vi.fn();
      const hydrated = await hydrateMintBurn({
        db, nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
      });
      expect(hydrated.mintBurnMap.get("usdt-tether")).toMatchObject({ burn24h: 700_000 });
      expect([...hydrated.mintBurnStaleIds]).toEqual(["usdt-tether"]);
      expect(hydrated).toMatchObject({ freshCount: 0, staleCount: 1, freshnessAgeSec: 26 * 3600 });
      expect(hydrated.mintBurnAgeSecById.get("usdt-tether")).toBe(26 * 3600);
      expect(registerSourceFailure).toHaveBeenCalledTimes(1);
      expect(registerSourceFailure).toHaveBeenCalledWith(
        "mint-burn-hourly-freshness",
        "mint_burn_hourly age 93600s exceeds 86400s",
      );
    } finally {
      sqlite.close();
    }
  });
});

/**
 * One admitted gauge generation whose 24h/30d scan windows are both complete.
 * The payload clock is pinned to the window end so `hydrateMintBurn` reads at one pin.
 */
function insertAdmittedMintBurnGauge(
  sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"],
  end: number,
  cacheUpdatedAt: number,
): void {
  const window = { complete: true, unavailableReason: null };
  const value = {
    gauge: { score: null },
    updatedAt: end,
    publication: {
      evaluatedAt: RUN_AT, requiredBaselineSec: 90 * 86400, freshnessBudgetSec: 7200,
      legs: [{ configKey: "synthetic", configFingerprint: "synthetic-v1", stablecoinId: "usdt-tether", chainId: "ethereum",
        status: "admitted", reason: null, admittedAt: null, baselineFrom: end - 90 * 86400, baselineTo: end,
        coveredSeconds: 90 * 86400, frontierAgeSec: 0 }],
    },
    window: { start: end - 86400, end, semantics: "closed-utc-hours" },
    coins: [{ stablecoinId: "usdt-tether", symbol: "USDT", pressureShiftScore: null, netFlow24hUsd: null,
      coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: end - 90 * 86400,
        has24hWindow: true, has30dWindow: true, has90dWindow: true, isPartial: false, status: "full",
        windows: { window24h: window, window7d: window, window30d: window, window90d: window } } }],
  };
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .run(aggregateFlowCacheKey(24), JSON.stringify(value), cacheUpdatedAt);
}
