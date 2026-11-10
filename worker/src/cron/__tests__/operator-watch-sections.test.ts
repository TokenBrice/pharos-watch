import { describe, expect, it } from "vitest";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { BluechipRating } from "@shared/types/market";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { ACTIVE_CANARY_CHECK_IDS } from "../../lib/canary-checks";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-contract-identity";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";
import { BLACKLIST_CONFIG_STALE_AGE_SEC, loadBlacklistConfigWatchConditions } from "../operator-watch-blacklist";
import { loadCanaryOperatorWatch } from "../operator-watch-canary";
import {
  loadDexYieldWatchConditions,
  loadMeasuredExecutionChainWatch,
  loadYieldDataCoverageWatch,
} from "../operator-watch-dex-yield";
import {
  MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY,
  loadMintBurnStuckConfigWatchConditions,
} from "../operator-watch-mintburn";
import {
  DAILY_LANE_COMPLETION_GRACE_SEC,
  buildPricingOperatorConditions,
  pricingOperatorRuleIds,
} from "../operator-watch-pricing";
import { loadProbeOperatorWatch } from "../operator-watch-probe";

describe("loadProbeOperatorWatch", () => {
  const NOW = 1_750_000_000;

  function probeDb(details: Record<string, unknown> | null): D1Database {
    return {
      prepare: () => ({
        bind: () => ({
          first: async () => (details == null ? null : {
            created_at: NOW,
            details_json: JSON.stringify(details),
          }),
        }),
      }),
    } as unknown as D1Database;
  }

  function persistentFailure(path: string) {
    return {
      plane: "external", lane: "external", origin: "https://api.pharos.watch",
      path, failStreak: 2, lastProbedAt: NOW,
    };
  }

  it("turns a persistent probe failure into an operator condition", async () => {
    const evidence = await loadProbeOperatorWatch(probeDb({
      persistentProbeFailures: [persistentFailure("/api/mint-burn-flows")],
    }), NOW);
    expect(evidence.unknown).toBe(false);
    expect(evidence.conditions).toEqual([expect.objectContaining({
      id: "external:/api/mint-burn-flows",
      active: true,
    })]);
  });

  it("keeps every reserve, live-reserve and redemption probe path status-level only", async () => {
    const evidence = await loadProbeOperatorWatch(probeDb({
      persistentProbeFailures: [
        persistentFailure("/api/stablecoin-reserves/iusd-infinifi"),
        persistentFailure("/api/reserve-attempt-history?coin=usdc-circle&limit=10"),
        persistentFailure("/api/redemption-backstops"),
        persistentFailure("/api/redemption-backstop-coin?stablecoin=usdc-circle"),
        persistentFailure("/api/mint-burn-flows"),
      ],
    }), NOW);
    expect(evidence.unknown).toBe(false);
    expect(evidence.conditions.map((condition) => condition.id)).toEqual([
      "external:/api/mint-burn-flows",
    ]);
  });
});

describe("blacklist config watch conditions", () => {
  const NOW = 1_775_900_000;
  const config = CONTRACT_CONFIGS.find((candidate) => WORKER_ACTIVE_IDS.has(candidate.stablecoinId))!;

  function syncStateRow(lastSucceededAt: number | null, lastAttemptedAt: number | null) {
    return {
      config_key: config.configKey,
      last_block: 100,
      cursor_value: null,
      attempt_generation: 1,
      last_attempted_at: lastAttemptedAt,
      last_succeeded_at: lastSucceededAt,
      last_skipped_at: null,
      last_failed_at: null,
      consecutive_skips: 0,
      consecutive_failures: 0,
      last_outcome: "attempted",
    };
  }

  it("raises the config that has not succeeded for two producer intervals", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      rows: [syncStateRow(NOW - BLACKLIST_CONFIG_STALE_AGE_SEC - 1, NOW - 60)],
    }]);

    const result = await loadBlacklistConfigWatchConditions(db, NOW);

    expect(result.readFailed).toBe(false);
    expect(result.conditions.find((condition) => condition.id === config.configKey))
      .toMatchObject({
        section: "blacklist-config",
        active: true,
        label: expect.stringContaining(config.stablecoin),
      });
  });

  it("leaves a config that succeeded inside the budget recoverable", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      rows: [syncStateRow(NOW - 60, NOW - 60)],
    }]);

    const result = await loadBlacklistConfigWatchConditions(db, NOW);

    expect(result.conditions.find((condition) => condition.id === config.configKey))
      .toMatchObject({ active: false });
  });

  it("raises a config that has never succeeded once it has been attempted", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      rows: [syncStateRow(null, NOW - 60)],
    }]);

    const result = await loadBlacklistConfigWatchConditions(db, NOW);

    expect(result.conditions.find((condition) => condition.id === config.configKey))
      .toMatchObject({
        active: true,
        label: expect.stringContaining("never succeeded"),
      });
  });

  it("does not treat a future last-success clock as fresh evidence", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      rows: [syncStateRow(NOW + 10 * 86_400, NOW - 60)],
    }]);

    const result = await loadBlacklistConfigWatchConditions(db, NOW);

    expect(result.conditions.find((condition) => condition.id === config.configKey))
      .toMatchObject({
        active: true,
        label: expect.stringContaining("in the future"),
      });
  });

  it("reports a failed config-state read instead of healthy conditions", async () => {
    const db = mockD1([{
      match: "FROM blacklist_sync_state",
      throwError: new Error("D1 unavailable"),
      rows: [],
    }]);

    await expect(loadBlacklistConfigWatchConditions(db, NOW)).resolves.toEqual({
      conditions: [],
      readFailed: true,
    });
  });
});

describe("loadCanaryOperatorWatch", () => {
  const NOW = 1_750_000_000;
  const [ERROR_ID, FAILED_ID, HEALTHY_ID, LEGACY_ID] = ACTIVE_CANARY_CHECK_IDS;

  function unreadableDb(): D1Database {
    return {
      prepare: () => {
        throw new Error("worker_canary_runs unavailable");
      },
    } as unknown as D1Database;
  }

  /** Persist one fresh row per active check, then override the cases under test. */
  function seedCanaryChecks() {
    const { db, sqlite } = createLatestSchemaSqlite();
    const insert = sqlite.prepare(`INSERT INTO worker_canary_runs
      (id, check_id, idempotency_key, status, severity, observed_at, duration_ms, metadata_json, error, mode)
      VALUES (?, ?, ?, 'ok', 'info', ?, 1, ?, NULL, 'status')`);
    for (const checkId of ACTIVE_CANARY_CHECK_IDS) {
      insert.run(`canary:${checkId}:${NOW}`, checkId, `${checkId}:${NOW}`, NOW,
        JSON.stringify({ executionStatus: "completed" }));
    }
    const update = sqlite.prepare(
      "UPDATE worker_canary_runs SET status = ?, severity = ?, metadata_json = ?, error = ? WHERE check_id = ?",
    );
    update.run("error", "error", JSON.stringify({ executionStatus: "completed" }), "e".repeat(800), ERROR_ID);
    update.run("error", "error",
      JSON.stringify({ executionStatus: "failed", executionFailureReason: "canary-source-unavailable" }),
      "D1 read failed", FAILED_ID);
    update.run("ok", "info", "{}", null, LEGACY_ID);
    return { db, sqlite };
  }

  it.each([undefined, "off", "shadow"] as const)(
    "keeps a disabled canary unknown instead of reporting recovery (%s)",
    async (mode) => {
      // A disabled canary evaluates nothing: prior findings must hold their
      // state rather than being reported as recovered (R2).
      expect(await loadCanaryOperatorWatch(unreadableDb(), NOW, mode)).toEqual({
        conditions: [], unknown: true,
      });
    },
  );
  it("keeps an unreadable canary status unknown", async () => {
    expect(await loadCanaryOperatorWatch(unreadableDb(), NOW, "status")).toEqual({
      conditions: [], unknown: true,
    });
  });
  it("raises only a completed error finding and holds failed or unknown measurements", async () => {
    const { db, sqlite } = seedCanaryChecks();
    try {
      const evidence = await loadCanaryOperatorWatch(db, NOW + 60, "status");
      expect(evidence.unknown).toBe(false);
      expect(evidence.conditions.find((condition) => condition.id === "cohort")).toBeUndefined();
      expect(evidence.conditions.find((condition) => condition.id === ERROR_ID)).toMatchObject({ active: true });
      expect(evidence.conditions.find((condition) => condition.id === FAILED_ID)).toEqual({
        id: FAILED_ID, active: false, unknown: true,
      });
      expect(evidence.conditions.find((condition) => condition.id === LEGACY_ID)).toEqual({
        id: LEGACY_ID, active: false, unknown: true,
      });
      expect(evidence.conditions.find((condition) => condition.id === HEALTHY_ID)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
  it("keeps a whole missing cohort visible instead of overflowing the section line", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const cohort = (await loadCanaryOperatorWatch(db, NOW, "status"))
        .conditions.find((condition) => condition.id === "cohort");
      expect(cohort?.active).toBe(true);
      expect(cohort?.label?.startsWith("missing checks:")).toBe(true);
      expect((cohort?.label ?? "").length).toBeLessThanOrEqual(83);
    } finally {
      sqlite.close();
    }
  });
  it("keeps the check id and truncates an over-long error detail", async () => {
    const { db, sqlite } = seedCanaryChecks();
    try {
      const condition = (await loadCanaryOperatorWatch(db, NOW + 60, "status"))
        .conditions.find((entry) => entry.id === ERROR_ID);
      const label = condition?.label ?? "";
      // The section helper drops any label too long for its line budget, so the
      // id must survive truncation.
      expect(label.startsWith(ERROR_ID)).toBe(true);
      expect(label).toContain("...");
      expect(label.length).toBeLessThanOrEqual(100);
    } finally {
      sqlite.close();
    }
  });
});

describe("mint/burn stuck config watch conditions", () => {
  const NOW = 1_775_900_000;
  const config = MINT_BURN_CONFIGS.find(
    (candidate) => candidate.enabled !== false && WORKER_ACTIVE_IDS.has(candidate.stablecoinId),
  )!;
  const configKey = mintBurnConfigKey(config);

  function attemptState(consecutiveIncomplete: number) {
    return JSON.stringify({
      version: 1,
      updatedAt: NOW - 60,
      entries: {
        [configKey]: {
          firstObservedAt: NOW - 86_400,
          lastAttemptedAt: NOW - 60,
          lastDisposition: "attempted",
          providerDeferredUntil: null,
          consecutiveIncomplete,
        },
      },
    });
  }

  function cacheRow(value: string) {
    return {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY],
      rows: [{ key: MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY, value, updated_at: NOW - 60 }],
    };
  }

  it("raises a config attempted twice without advancing", async () => {
    const db = mockD1([cacheRow(attemptState(2))]);

    const result = await loadMintBurnStuckConfigWatchConditions(db);

    expect(result.readFailed).toBe(false);
    expect(result.conditions).toEqual([{
      // A dedicated section lets the absent condition report a recovery.
      section: "mint-burn-config",
      id: configKey,
      label: expect.stringContaining("2 incomplete attempts"),
      active: true,
    }]);
  });

  it("does not raise a single incomplete attempt", async () => {
    const db = mockD1([cacheRow(attemptState(1))]);

    const result = await loadMintBurnStuckConfigWatchConditions(db);

    expect(result).toMatchObject({ conditions: [], readFailed: false });
  });

  it("reports a missing or unreadable attempt state instead of healthy configs", async () => {
    await expect(loadMintBurnStuckConfigWatchConditions(mockD1([]))).resolves.toEqual({
      conditions: [],
      readFailed: true,
    });
    const unreadable = mockD1([cacheRow("{not-json")]);
    await expect(loadMintBurnStuckConfigWatchConditions(unreadable)).resolves.toEqual({
      conditions: [],
      readFailed: true,
    });
  });
});

describe("pricing operator conditions", () => {
  const NOW = Date.UTC(2026, 7, 22, 12, 0, 0) / 1000;
  const SLOT_START = Date.UTC(2026, 7, 22, 8, 0, 0) / 1000;
  const EXPECTED_BLUECHIP_IDS = includeActiveTrackedIds(
    Object.entries(BLUECHIP_SLUG_MAP),
    ([, pharosId]) => pharosId,
  ).map(([, pharosId]) => pharosId);

  function rating(slug: string, lastObservedAt: number): BluechipRating {
    return {
      grade: "A",
      slug,
      lastObservedAt,
      observationState: "current",
      observationReason: null,
      collateralization: null,
      smartContractAudit: null,
      dateOfRating: null,
      dateLastChange: null,
      smidge: {
        stability: null,
        management: null,
        implementation: null,
        decentralization: null,
        governance: null,
        externals: null,
      },
    };
  }

  function bluechipRatings(overrides: Record<string, Partial<BluechipRating>> = {}) {
    const ratings: Record<string, BluechipRating> = {};
    for (const [slug, pharosId] of Object.entries(BLUECHIP_SLUG_MAP)) {
      if (!EXPECTED_BLUECHIP_IDS.includes(pharosId)) continue;
      ratings[pharosId] = rating(slug, NOW - 3600);
    }
    for (const [pharosId, patch] of Object.entries(overrides)) {
      ratings[pharosId] = { ...ratings[pharosId], ...patch } as BluechipRating;
    }
    return ratings;
  }

  function bluechipDb(ratings: Record<string, unknown> | null) {
    return mockD1([{
      match: "FROM cache WHERE key = ?",
      rows: ratings == null
        ? []
        : [{ key: "bluechip-ratings", value: JSON.stringify(ratings), updated_at: NOW - 3600 }],
    }]);
  }

  function conditionsFor(
    caches: Parameters<typeof buildPricingOperatorConditions>[1]["caches"],
    ratings: Record<string, unknown> | null = bluechipRatings(),
  ) {
    return buildPricingOperatorConditions(bluechipDb(ratings), { caches, nowSec: NOW });
  }

  it("stays quiet for a healthy FX cache and completed daily lanes", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.fxRates.cacheKey]: { publishedAt: NOW - 60, mode: "live", sourceStatus: "fresh", consecutiveFallbackRuns: 0 },
      [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: SLOT_START + 60 },
      [CACHE_FRESHNESS_LANES.bluechipRatings.cacheKey]: { publishedAt: SLOT_START + 5 * 60 },
    });
    expect(conditions.every((condition) => !condition.active)).toBe(true);
    expect(conditions.map((condition) => condition.id)).toEqual(expect.arrayContaining([
      "source-stale",
      "cached-fallback",
      "sync-usds-status-slot",
      "sync-bluechip-slot",
      "bluechip-ratings-coverage",
    ]));
    expect(pricingOperatorRuleIds(conditions)).toEqual([]);
  });

  it("raises the FX source and cached-fallback conditions with the producer detail", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.fxRates.cacheKey]: {
        publishedAt: NOW - 60,
        mode: "cached-fallback",
        sourceStatus: "stale",
        consecutiveFallbackRuns: 3,
        warning: "peggedEUR business-daily reference is 2 publishes behind (latest 2026-08-18, expected 2026-08-21)",
      },
    });
    const fx = conditions.filter((condition) => condition.section === "fx-rates");
    expect(fx).toEqual([
      expect.objectContaining({
        id: "source-stale",
        active: true,
        label: expect.stringContaining("peggedEUR business-daily reference is 2 publishes behind"),
      }),
      expect.objectContaining({
        id: "cached-fallback",
        active: true,
        label: expect.stringContaining("3 consecutive runs"),
      }),
    ]);
    expect(pricingOperatorRuleIds(conditions)).toEqual(
      expect.arrayContaining(["fx-source-stale", "fx-cached-fallback"]),
    );
  });

  it("only alerts a stale source, not a degraded one", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.fxRates.cacheKey]: {
        publishedAt: NOW - 60,
        mode: "live",
        sourceStatus: "degraded",
        consecutiveFallbackRuns: 0,
        warning: "peggedCHF intraday reference is 8h old",
      },
    });
    expect(conditions.filter((condition) => condition.section === "fx-rates").map((condition) => condition.active))
      .toEqual([false, false]);
  });

  it("raises a daily lane that has not published since its slot, after the grace period", async () => {
    const missed = await conditionsFor({
      [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: SLOT_START - 86_400 + 60 },
      [CACHE_FRESHNESS_LANES.bluechipRatings.cacheKey]: { publishedAt: SLOT_START + 300 },
    });
    const usds = missed.find((condition) => condition.id === "sync-usds-status-slot");
    expect(usds).toMatchObject({ section: "daily-lane", active: true, unknown: false });
    expect(usds?.label).toContain("sync-usds-status");
    expect(pricingOperatorRuleIds(missed)).toContain("daily-lane-completion");

    const early = await buildPricingOperatorConditions(bluechipDb(bluechipRatings()), {
      caches: { [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: SLOT_START - 86_400 + 60 } },
      nowSec: SLOT_START + DAILY_LANE_COMPLETION_GRACE_SEC,
    });
    expect(early.find((condition) => condition.id === "sync-usds-status-slot")?.active).toBe(false);
  });

  it("does not page for a missing publication clock", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.usdsStatus.cacheKey]: { publishedAt: null },
    });
    expect(conditions.find((condition) => condition.id === "sync-usds-status-slot")).toMatchObject({
      active: false,
      unknown: true,
    });
  });

  it("keeps both FX conditions unknown when the cache carries no parsed state", async () => {
    const conditions = await conditionsFor({
      [CACHE_FRESHNESS_LANES.fxRates.cacheKey]: { publishedAt: null },
    });
    expect(conditions.filter((condition) => condition.section === "fx-rates")).toEqual([
      expect.objectContaining({ id: "source-stale", active: false, unknown: true }),
      expect.objectContaining({ id: "cached-fallback", active: false, unknown: true }),
    ]);
    expect(pricingOperatorRuleIds(conditions)).toEqual([]);
  });

  it("raises bluechip coverage gaps at the shared 48-hour observation budget", async () => {
    const [staleId, freshId] = EXPECTED_BLUECHIP_IDS;
    const conditions = await conditionsFor(
      { [CACHE_FRESHNESS_LANES.bluechipRatings.cacheKey]: { publishedAt: NOW - 3_600 } },
      bluechipRatings({
        [staleId]: { observationState: "retained", observationReason: "http-404", lastObservedAt: NOW - 3 * 86_400 },
      }),
    );
    const coverage = conditions.find((condition) => condition.id === "bluechip-ratings-coverage");
    expect(coverage).toMatchObject({ section: "daily-lane", active: true, unknown: false });
    expect(coverage?.label).toContain(`${staleId}:http-404`);
    expect(coverage?.label).not.toContain(freshId);
    expect(pricingOperatorRuleIds(conditions)).toContain("bluechip-coverage");
  });

  it("keeps a missing or unusable bluechip cache unknown instead of claiming it failed", async () => {
    for (const ratings of [null, {}]) {
      const conditions = await conditionsFor({}, ratings);
      expect(conditions.find((condition) => condition.id === "bluechip-ratings-coverage")).toMatchObject({
        active: false,
        unknown: true,
      });
      expect(pricingOperatorRuleIds(conditions)).not.toContain("bluechip-coverage");
    }
  });

  it("keeps a partially unreadable bluechip cache unknown instead of reporting dropped constituents missing", async () => {
    const [droppedId] = EXPECTED_BLUECHIP_IDS;
    const ratings: Record<string, unknown> = { ...bluechipRatings() };
    ratings[droppedId] = { grade: "not-a-grade" };
    const conditions = await conditionsFor({}, ratings);
    expect(conditions.find((condition) => condition.id === "bluechip-ratings-coverage")).toMatchObject({
      active: false,
      unknown: true,
    });
    expect(pricingOperatorRuleIds(conditions)).not.toContain("bluechip-coverage");
  });
});

describe("dex/yield operator watch", () => {
  interface CacheRow {
    value: string;
    updated_at: number;
  }

  function fakeDb(options: {
    yieldRuns?: Record<string, unknown>[];
    measuredRuns?: Record<string, unknown>[];
    cache?: Record<string, CacheRow>;
    failQuery?: string;
  }): { db: D1Database; cache: Map<string, CacheRow> } {
    const cache = new Map(Object.entries(options.cache ?? {}));
    const firstFor = async (sql: string, args: unknown[]) => {
      if (sql.includes("FROM cache WHERE key = ?")) {
        const row = cache.get(args[0] as string);
        return row ? { value: row.value, updated_at: row.updated_at } : null;
      }
      return null;
    };
    const allFor = async (sql: string) => {
      if (options.failQuery && sql.includes(options.failQuery)) throw new Error("d1 down");
      if (sql.includes("'sync-yield-data'")) return { results: options.yieldRuns ?? [] };
      if (sql.includes("'sync-cl-exit-depth'")) {
        const rows = options.measuredRuns ?? [];
        // The production query keeps only active-lane generations; apply the same
        // predicate only when the query actually asks for the lane.
        return {
          results: sql.includes("$.lane")
            ? rows.filter((row) => (row as { lane?: string }).lane !== "shadow")
            : rows,
        };
      }
      return { results: [] };
    };
    const runFor = async (sql: string, args: unknown[]) => {
      if (sql.startsWith("INSERT INTO cache")) {
        cache.set(args[0] as string, { value: args[1] as string, updated_at: args[2] as number });
      }
      return { meta: { changes: 1 } };
    };
    const db = {
      prepare(sql: string) {
        return {
          bind: (...args: unknown[]) => ({
            first: () => firstFor(sql, args),
            all: () => allFor(sql),
            run: () => runFor(sql, args),
          }),
          first: () => firstFor(sql, []),
          all: () => allFor(sql),
          run: () => runFor(sql, []),
        };
      },
    } as unknown as D1Database;
    return { db, cache };
  }

  function yieldRow(counts: {
    rankings: number | null;
    tracked?: number | null;
    opportunity?: number | null;
    reasons?: string[];
    metadataValid?: number;
  }) {
    return {
      started_at: 1_700_000_000,
      published_ranking_count: counts.rankings,
      published_tracked_count: counts.tracked ?? 200,
      published_opportunity_count: counts.opportunity ?? 40,
      quality_reasons: counts.reasons ? JSON.stringify(counts.reasons) : null,
      metadata_valid: counts.metadataValid ?? 1,
    };
  }

  it("activates yield coverage only after two consecutive generations below the pre-event baseline", async () => {
    const options = {
      yieldRuns: [yieldRow({ rankings: 86 }), yieldRow({ rankings: 100 })],
    };
    const { db } = fakeDb(options);
    const first = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    expect(first.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: false,
    });

    options.yieldRuns = [yieldRow({ rankings: 80 }), yieldRow({ rankings: 86 })];
    const second = await loadYieldDataCoverageWatch(db, 1_700_000_900);
    const coverage = second.conditions.find((condition) => condition.id === "yield-data-coverage");
    expect(coverage).toMatchObject({ active: true });
    expect(coverage?.label).toContain("rankings 80 vs 100");
    expect(coverage?.label).toContain("budget 90%");

    options.yieldRuns = [yieldRow({ rankings: 95 }), yieldRow({ rankings: 80 })];
    const recovered = await loadYieldDataCoverageWatch(db, 1_700_001_800);
    expect(recovered.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: false,
    });
  });

  it("keeps a confirmed coverage loss active until the level recovers", async () => {
    const state = {
      version: 1,
      series: { rankings: { baseline: 100, active: true } },
    };
    const { db } = fakeDb({
      cache: {
        "operator-watch:yield-data-coverage:v1": { value: JSON.stringify(state), updated_at: 1_700_000_000 },
      },
      yieldRuns: [yieldRow({ rankings: 70 }), yieldRow({ rankings: 72 })],
    });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_900);
    expect(result.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: true,
    });
  });

  it("reports unknown when a yield coverage count cannot be read", async () => {
    const { db } = fakeDb({
      yieldRuns: [yieldRow({ rankings: null }), yieldRow({ rankings: 100 })],
    });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    expect(result.conditions.find((condition) => condition.id === "yield-data-coverage")).toMatchObject({
      active: false,
      unknown: true,
    });
  });

  it("names a degraded supplemental family from the latest successful yield publication", async () => {
    const { db } = fakeDb({
      yieldRuns: [
        yieldRow({ rankings: 90, reasons: ["yield-supplemental:family-degraded:morpho:family-count-drop"] }),
        yieldRow({ rankings: 90 }),
      ],
    });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    const family = result.conditions.find((condition) => condition.id === "yield-supplemental-family-degraded");
    expect(family).toMatchObject({ active: true });
    expect(family?.label).toContain("morpho:family-count-drop");
  });

  it("reports unknown when the yield history read fails", async () => {
    const { db } = fakeDb({ failQuery: "'sync-yield-data'" });
    const result = await loadDexYieldWatchConditions(db, 1_700_000_000);
    expect(result.conditions.find((condition) => condition.id === "yield-data-coverage")?.unknown).toBe(true);
    expect(result.conditions.find((condition) => condition.id === "yield-supplemental-family-degraded")?.unknown)
      .toBe(true);
    // A sibling detector whose own read succeeded keeps its own evidence.
    expect(result.conditions.find((condition) => condition.id === "measured-execution-chain-coverage"))
      .toMatchObject({ active: false, unknown: true });
  });

  it("reports the supplemental family unknown when no successful yield generation exists", async () => {
    const { db } = fakeDb({ yieldRuns: [] });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    expect(result.conditions.find((condition) => condition.id === "yield-supplemental-family-degraded"))
      .toMatchObject({ active: false, unknown: true });
  });

  it("reports the supplemental family unknown when the latest metadata is unreadable", async () => {
    const { db } = fakeDb({
      yieldRuns: [{ ...yieldRow({ rankings: 90 }), metadata_valid: 0 }],
    });
    const result = await loadYieldDataCoverageWatch(db, 1_700_000_000);
    expect(result.conditions.find((condition) => condition.id === "yield-supplemental-family-degraded"))
      .toMatchObject({ active: false, unknown: true });
  });

  it("flags a chain with score-eligible targets and no measured quote across two generations", async () => {
    const chains = { base: { scoreEligibleTargets: 4, measured: 0, failed: 4, deferred: 0 } };
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, chains_json: JSON.stringify(chains) },
        { started_at: 1, chains_json: JSON.stringify(chains) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    const condition = result.conditions[0];
    expect(condition).toMatchObject({ active: true });
    expect(condition.label).toContain("base 0/4");
  });

  it("does not flag a chain that measured in either generation", async () => {
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, chains_json: JSON.stringify({ base: { scoreEligibleTargets: 4, measured: 0, failed: 4, deferred: 0 } }) },
        { started_at: 1, chains_json: JSON.stringify({ base: { scoreEligibleTargets: 4, measured: 2, failed: 2, deferred: 0 } }) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false });
  });

  it("does not flag chains whose targets were budget-deferred at production scale", async () => {
    const deferredChains = Object.fromEntries(
      ["base", "ethereum", "arbitrum", "polygon", "bsc", "optimism"].map((chain) => [
        chain,
        { scoreEligibleTargets: 60, measured: 0, failed: 0, deferred: 60 },
      ]),
    );
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, lane: "active", chains_json: JSON.stringify(deferredChains) },
        { started_at: 1, lane: "active", chains_json: JSON.stringify(deferredChains) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false });
    expect(result.conditions[0].unknown).toBeUndefined();
  });

  it("does not flag a chain whose zero is partly explained by budget deferrals", async () => {
    const chains = { base: { scoreEligibleTargets: 10, measured: 0, failed: 2, deferred: 8 } };
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, lane: "active", chains_json: JSON.stringify(chains) },
        { started_at: 1, lane: "active", chains_json: JSON.stringify(chains) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false });
  });

  it("reports unknown when chain evidence is missing from a generation", async () => {
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, chains_json: null },
        { started_at: 1, chains_json: JSON.stringify({ base: { scoreEligibleTargets: 4, measured: 2, failed: 2, deferred: 0 } }) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false, unknown: true });
  });

  it("reports unknown when a generation carries no chain evidence", async () => {
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 2, chains_json: "{}" },
        { started_at: 1, chains_json: "{}" },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false, unknown: true });
  });

  it("reports unknown until two active generations exist", async () => {
    const chains = { base: { scoreEligibleTargets: 4, measured: 2, failed: 2, deferred: 0 } };
    const { db } = fakeDb({
      measuredRuns: [{ started_at: 1, lane: "active", chains_json: JSON.stringify(chains) }],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: false, unknown: true });
  });

  it("pairs active generations instead of the daily shadow generation", async () => {
    const starved = { base: { scoreEligibleTargets: 4, measured: 0, failed: 4, deferred: 0 } };
    const { db } = fakeDb({
      measuredRuns: [
        { started_at: 3, lane: "shadow", chains_json: "{}" },
        { started_at: 2, lane: "active", chains_json: JSON.stringify(starved) },
        { started_at: 1, lane: "active", chains_json: JSON.stringify(starved) },
      ],
    });
    const result = await loadMeasuredExecutionChainWatch(db);
    expect(result.conditions[0]).toMatchObject({ active: true });
    expect(result.conditions[0].label).toContain("base 0/4");
  });
});

describe("includeActiveTrackedIds", () => {
  it("keeps only IDs in the active producer universe", () => {
    const items = [
      { stablecoinId: "usdt-tether", status: "active" },
      { stablecoinId: "benji-franklin-templeton", status: "quarantined" },
      { stablecoinId: "bfusd-binance", status: "delisted" },
      { stablecoinId: "bd-basedollar", status: "frozen" },
    ];

    expect(includeActiveTrackedIds(
      items,
      (item) => item.stablecoinId,
      new Set(["usdt-tether"]),
    )).toEqual([{ stablecoinId: "usdt-tether", status: "active" }]);
  });
});
