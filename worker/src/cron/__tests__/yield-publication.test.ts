import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { YieldSafetySnapshotMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  PRICE_DERIVED_STALE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
} from "../yield-helpers";
import { buildHistoryKey, type EvaluatedYieldSource } from "../yield-sync/evaluation";
import type { ParsedYieldBenchmarkMeta, ParsedYieldBenchmarkRegistry } from "../yield-sync/benchmarks";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  validateYieldRankingsPayloadForPublish,
} from "../yield-sync/publication";
import { publishYieldCoordinatorResults } from "../yield-sync/coordinator-persist";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");

const FIXED_NOW = new Date("2026-03-26T12:00:00.000Z");

function makeBenchmarkMeta(): ParsedYieldBenchmarkMeta {
  return {
    key: "USD",
    label: "USD 3M T-Bill",
    currency: "USD",
    rate: 4.2,
    recordDate: "2026-03-25",
    fetchedAt: Math.floor(FIXED_NOW.getTime() / 1000),
    ageSeconds: 0,
    source: "fred-dgs3mo",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
    lastMarketRate: 4.2,
    lastMarketRecordDate: "2026-03-25",
    lastMarketFetchedAt: Math.floor(FIXED_NOW.getTime() / 1000),
    lastMarketSource: "fred-dgs3mo",
  };
}

function makeYieldSourceMeta(): YieldSourceInputMeta {
  return {
    mode: "dex-cache",
    updatedAt: Math.floor(FIXED_NOW.getTime() / 1000),
    ageSeconds: 0,
    poolCount: 1,
    fallbackMode: null,
  };
}

function makeSafetySnapshotMeta(): YieldSafetySnapshotMeta {
  return {
    kind: "ok",
    coverageRatio: 1,
    coveredCount: 1,
    trackedCount: 1,
    reason: null,
  };
}

function makeEvaluatedSource(overrides: Partial<EvaluatedYieldSource> = {}): EvaluatedYieldSource {
  const benchmarkMeta = makeBenchmarkMeta();
  return {
    id: "test-coin",
    symbol: "TST",
    sourceKey: "defillama:test-source",
    yieldSource: "Test Source",
    yieldType: "lending-vault",
    currentApy: 4.8,
    apyBase: 4.8,
    apyReward: 0,
    sourcePool: null,
    sourceTvlUsd: 1_500_000,
    dataSource: "defillama",
    exchangeRate: null,
    sourceObservedAt: null,
    comparisonAnchorObservedAt: null,
    apy7d: 4.7,
    apy30d: 4.6,
    apyVarianceScore: 0.1,
    stdDev30d: 0.2,
    apyMin30d: 4.4,
    apyMax30d: 4.9,
    yieldStability: 0.9,
    safetyScore: 82,
    safetyGrade: "A-",
    yieldToRisk: 3.2,
    excessYield: 0.6,
    benchmarkKey: "USD",
    benchmarkLabel: benchmarkMeta.label!,
    benchmarkCurrency: benchmarkMeta.currency!,
    benchmarkRate: benchmarkMeta.rate,
    benchmarkRecordDate: benchmarkMeta.recordDate,
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    benchmarkMeta,
    pharosYieldScore: 28,
    prevExchangeRate: null,
    prevTvlUsd: 1_700_000,
    anomalies: [],
    warnings: [],
    confidenceTier: "curated",
    rejected: false,
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    previousBestSourceKey: null,
    ...overrides,
  };
}

function buildPayloadWithObservedAt(sourceObservedAt: number, overrides: Partial<EvaluatedYieldSource> = {}) {
  const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
  const source = makeEvaluatedSource(overrides);
  const benchmark = makeBenchmarkMeta();
  const benchmarks: ParsedYieldBenchmarkRegistry = { USD: benchmark, EUR: null, CHF: null };

  return buildYieldRankingsPayloadFromEvaluatedSources({
    evaluatedSources: [source],
    bestSourceKeyByCoin: new Map([[source.id, source.sourceKey]]),
    rankingProvenanceByKey: new Map([
      [
        buildHistoryKey(source.id, source.sourceKey),
        {
          sourceKey: source.sourceKey,
          sourceObservedAt,
          sourceAgeSeconds: Math.max(0, startSec - sourceObservedAt),
          confidenceTier: source.confidenceTier,
          selectionMethod: "confidence-weighted" as const,
          selectionReason: "test",
          sourceSwitch: false,
          previousBestSourceKey: null,
          usedLegacyHistory: false,
          usedDefaultSafety: false,
          benchmarkKey: source.benchmarkKey,
          benchmarkLabel: source.benchmarkLabel,
          benchmarkCurrency: source.benchmarkCurrency,
          benchmarkRate: source.benchmarkRate,
          benchmarkRecordDate: source.benchmarkRecordDate,
          benchmarkIsFallback: source.benchmarkIsFallback,
          benchmarkFallbackMode: source.benchmarkFallbackMode,
          benchmarkSelectionMode: source.benchmarkSelectionMode,
          benchmarkIsProxy: source.benchmarkIsProxy,
          anomalies: [],
        },
      ],
    ]),
    riskFreeRate: benchmark.rate,
    riskFreeRateMeta: benchmark,
    riskFreeRateRegistry: benchmarks,
    dlPoolsMeta: makeYieldSourceMeta(),
    safetySnapshot: makeSafetySnapshotMeta(),
    medianApy: 4.5,
    startSec,
  });
}

describe("buildYieldRankingsPayloadFromEvaluatedSources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not add data-stale before the cadence-derived threshold", () => {
    const thresholdSec = STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60);

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("adds data-stale once the cadence-derived threshold is exceeded", () => {
    const thresholdSec = STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec - 60);

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("does not add data-stale for healthy price-derived daily snapshots", () => {
    const thresholdSec = PRICE_DERIVED_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(
      Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60,
      {
        dataSource: "price-derived",
        sourceKey: "price-derived",
      },
    );

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("still adds data-stale when price-derived snapshots miss the extended threshold", () => {
    const thresholdSec = PRICE_DERIVED_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(
      Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec - 60,
      {
        dataSource: "price-derived",
        sourceKey: "price-derived",
      },
    );

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("does not add data-stale for healthy supplemental protocol-api rows", () => {
    const thresholdSec = SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(
      Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60,
      {
        dataSource: "protocol-api",
        sourceKey: "protocol-api:pendle:ethereum:0xpool",
      },
    );

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });

  it("adds data-stale once supplemental protocol-api rows miss their cadence window", () => {
    const thresholdSec = SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(
      Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec - 60,
      {
        dataSource: "protocol-api",
        sourceKey: "protocol-api:pendle:ethereum:0xpool",
      },
    );

    expect(payload.rankings[0]?.warningSignals).toContain("data-stale");
  });

  it("does not add data-stale for healthy supplemental onchain rows", () => {
    const thresholdSec = SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000;
    const payload = buildPayloadWithObservedAt(
      Math.floor(FIXED_NOW.getTime() / 1000) - thresholdSec + 60,
      {
        dataSource: "onchain",
        sourceKey: "aave-v3-onchain:ethereum:0xasset",
      },
    );

    expect(payload.rankings[0]?.warningSignals).not.toContain("data-stale");
  });
});

describe("validateYieldRankingsPayloadForPublish", () => {
  it("allows a valid replacement when the previous rankings cache is malformed", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [{ value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) }],
        first: { value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) },
      },
    ]);
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));

    const result = await validateYieldRankingsPayloadForPublish(db, payload);

    expect(result).toEqual({ ok: true, validationFailures: 0 });
  });

  it("blocks malformed previous-cache recovery when the replacement has no rows", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [{ value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) }],
        first: { value: "{not-json", updated_at: Math.floor(FIXED_NOW.getTime() / 1000) },
      },
    ]);
    const payload = {
      ...buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000)),
      rankings: [],
    };

    const result = await validateYieldRankingsPayloadForPublish(db, payload);

    expect(result).toEqual({
      ok: false,
      validationFailures: 1,
      reason: "empty-rankings-payload",
    });
  });

  it("blocks publish when ranking IDs are duplicated", async () => {
    const db = mockD1();
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));
    payload.rankings = [
      payload.rankings[0]!,
      {
        ...payload.rankings[0]!,
        yieldSource: "Duplicate Source",
      },
    ];

    const result = await validateYieldRankingsPayloadForPublish(db, payload);

    expect(result).toEqual({
      ok: false,
      validationFailures: 1,
      reason: "duplicate-ranking-ids",
    });
  });

  it("keeps alternate sources with distinct source keys even when display labels match", () => {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const benchmark = makeBenchmarkMeta();
    const best = makeEvaluatedSource({
      sourceKey: "defillama:best",
      yieldSource: "Shared Venue",
      currentApy: 6,
      pharosYieldScore: 90,
    });
    const altA = makeEvaluatedSource({
      sourceKey: "defillama:alt-a",
      yieldSource: "Shared Venue",
      currentApy: 5,
      pharosYieldScore: 80,
    });
    const altB = makeEvaluatedSource({
      sourceKey: "defillama:alt-b",
      yieldSource: "Shared Venue",
      currentApy: 4,
      pharosYieldScore: 70,
    });

    const payload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: [best, altA, altB],
      bestSourceKeyByCoin: new Map([[best.id, best.sourceKey]]),
      rankingProvenanceByKey: new Map(),
      riskFreeRate: benchmark.rate,
      riskFreeRateMeta: benchmark,
      riskFreeRateRegistry: { USD: benchmark, EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    expect(payload.rankings[0]?.altSources.map((source) => source.sourceKey)).toEqual([
      "defillama:alt-a",
      "defillama:alt-b",
    ]);
  });
});

describe("publishYieldCoordinatorResults", () => {
  function makePublicationDb(cacheWriteChanges: number) {
    return mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["yield-rankings"], rows: [], first: null },
      { match: "INSERT OR REPLACE INTO yield_publication_generations", rows: [] },
      { match: "INSERT OR REPLACE INTO yield_data", rows: [] },
      { match: "INSERT OR IGNORE INTO yield_history", rows: [] },
      { match: "INSERT OR REPLACE INTO yield_source_decisions", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: cacheWriteChanges },
      },
      { match: "UPDATE yield_publication_generations", rows: [] },
      { match: "UPDATE yield_data SET publication_state", rows: [] },
      { match: "UPDATE yield_history SET publication_state", rows: [] },
      { match: "DELETE FROM yield_history", rows: [] },
    ]);
  }

  function makePublishParams(overrides: {
    db: D1Database;
    previewRankingsPayload?: ReturnType<typeof buildPayloadWithObservedAt>;
  }) {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const source = makeEvaluatedSource();
    return {
      db: overrides.db,
      previewRankingsPayload: overrides.previewRankingsPayload ?? buildPayloadWithObservedAt(startSec),
      evaluatedSources: [source],
      bestSourceKeyByCoin: new Map([[source.id, source.sourceKey]]),
      startSec,
      medianApy: 4.5,
      dlPoolsMeta: makeYieldSourceMeta(),
      degradationReasons: [],
      resolvedCount: 1,
      rowsRejected: 0,
      divergenceFlags: 0,
      sourceSwitches: 0,
    };
  }

  it("stages then fails a generation when cache payload validation fails before row publication", async () => {
    const db = makePublicationDb(1);
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));
    payload.rankings = [
      payload.rankings[0]!,
      {
        ...payload.rankings[0]!,
        yieldSource: "Duplicate Source",
      },
    ];

    const result = await publishYieldCoordinatorResults(makePublishParams({ db, previewRankingsPayload: payload }));

    expect(result.ok).toBe(false);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_publication_generations"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("SET state = 'failed'"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"))).toBe(false);
  });

  it("marks staged rows failed when the rankings cache CAS skips because a newer cache exists", async () => {
    const db = makePublicationDb(0);

    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));

    expect(result).toMatchObject({
      ok: true,
      cacheWriteSkipped: true,
      casSkipped: true,
    });
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("SET state = 'failed'"))).toBe(true);
    expect(
      history.some((entry) => entry.sql.includes("UPDATE yield_history SET publication_state = ?") && entry.binds[0] === "failed"),
    ).toBe(true);
  });

  it("publishes generation metadata to cache and current/history rows on a successful generation", async () => {
    const db = makePublicationDb(1);

    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));

    expect(result).toMatchObject({
      ok: true,
      cacheWriteSkipped: false,
      casSkipped: false,
    });
    const history = db.getHistory();
    const yieldDataInsert = history.find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"));
    const yieldHistoryInsert = history.find((entry) => entry.sql.includes("INSERT OR IGNORE INTO yield_history"));
    const cacheWrite = history.find((entry) => entry.sql.includes("INSERT INTO cache (key, value, updated_at)"));
    expect(yieldDataInsert?.binds.slice(-2)).toEqual(["yield-1774526400", "staged"]);
    expect(yieldHistoryInsert?.binds.slice(-2)).toEqual(["yield-1774526400", "staged"]);
    expect(cacheWrite?.binds[0]).toBe("yield-rankings");
    expect(JSON.parse(String(cacheWrite?.binds[1]))).toMatchObject({
      publication: {
        generationId: "yield-1774526400",
        status: "published",
        cutoffAt: 1774526400,
      },
      rankings: [
        {
          publicationGenerationId: "yield-1774526400",
          publishedRank: 1,
        },
      ],
    });
    expect(history.some((entry) => entry.sql.includes("SET state = 'published'"))).toBe(true);
    expect(
      history.some((entry) => entry.sql.includes("UPDATE yield_data SET publication_state = ?") && entry.binds[0] === "published"),
    ).toBe(true);
  });
});

describe("yield publication migration compatibility", () => {
  it("keeps old-worker yield_data and yield_history inserts valid after the additive migration", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, "0000_baseline.sql"), "utf8"));
      sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, "0125_yield_publication_generations.sql"), "utf8"));

      sqlite
        .prepare(
          `INSERT INTO yield_data (
            stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d,
            yield_source, yield_type, data_source, is_best, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("usdt-tether", "legacy-best", "USDT", 4.2, 4.1, 4, "Legacy", "staking", "defillama", 1, 1_774_526_400);
      sqlite
        .prepare(
          `INSERT INTO yield_history (
            stablecoin_id, source_key, recorded_at, is_best, apy, data_source
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("usdt-tether", "legacy-best", 1_774_526_400, 1, 4.2, "defillama");

      const current = sqlite
        .prepare("SELECT publication_generation_id, publication_state FROM yield_data WHERE stablecoin_id = ?")
        .get("usdt-tether") as { publication_generation_id: string | null; publication_state: string | null };
      const history = sqlite
        .prepare("SELECT publication_generation_id, publication_state FROM yield_history WHERE stablecoin_id = ?")
        .get("usdt-tether") as { publication_generation_id: string | null; publication_state: string | null };

      expect(current).toEqual({ publication_generation_id: null, publication_state: null });
      expect(history).toEqual({ publication_generation_id: null, publication_state: null });
    } finally {
      sqlite.close();
    }
  });
});
