import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANARY_INCIDENT_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import * as activeSafetyScoreSource from "../safety-score-active-source";
import {
  loadCanaryStatus,
  normalizeWorkerCanaryMode,
  runAndPersistCanaryChecks,
  runCanaryChecks,
} from "../canary-checks";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";
import { checkTapeClassLiveness } from "../canary-checks-tape";
import { tapeProjectorCursorKey } from "../tape-event-store";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import {
  buildSupplySnapshotCompletionMarker,
  buildSupplySnapshotCoverageExpectation,
} from "../supply-snapshot-completion";
import { aggregateFlowCacheKey } from "../mint-burn-flow-cache-keys";
import {
  BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY,
  BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION,
} from "../blacklist-cache-keys";

const fixtures = createLatestSchemaFixtureTracker();

const NOW = 1_775_900_000;
const EXPECTED_CANARY_CHECK_IDS = [
  "dex-liquidity-current-publication",
  "dex-liquidity-global-row",
  "blacklist-null-identity",
  "stablecoins-cache-active-count",
  "supply-history-daily-coverage",
  "psi-latest-sample",
  "dews-latest-signal",
  "safety-score-v9-publication",
  "yield-gbp-benchmark-current",
  "yield-usd-benchmark-current",
  "depeg-detection-census",
  "depeg-pending-confirmation-stall",
  "depeg-open-coverage",
  "depeg-dex-suppression-divergence",
  "ddr-eligible-unsealed",
  "mint-burn-publication-coverage",
  "blacklist-roster-coverage",
  "tape-class-liveness",
  "public-dataset-snapshot-completeness",
  "stablecoins-active-price-coverage",
  "depeg-observation-coverage",
];

const HEALTHY_CENSUS = {
  scope: "psi-non-nav-before-supply-floor",
  evaluatedAt: NOW - 120,
  eligibleCount: 100,
  observedCount: 98,
  unavailableCount: 2,
  belowFloorCount: 0,
  reasonCounts: { "asset-absent": 2 },
};

function depegCensusRuns() {
  return [
    {
      started_at: NOW - 60,
      census_json: JSON.stringify(HEALTHY_CENSUS),
      pipeline_succeeded: 1,
      unavailable_reason: null,
    },
    {
      started_at: NOW - 960,
      census_json: JSON.stringify({ ...HEALTHY_CENSUS, unavailableCount: 0, reasonCounts: {} }),
      pipeline_succeeded: 1,
      unavailable_reason: null,
    },
  ];
}

function stablecoinsRunRows(options: {
  pricedActiveCount?: number;
  missingPriceCount?: number;
  unavailableCount?: number;
  reasonCounts?: Record<string, number>;
  includeCoverage?: boolean;
  includeCensus?: boolean;
  startedAt?: number;
} = {}) {
  const expectedActiveCount = ACTIVE_IDS.size;
  const pricedActiveCount = options.pricedActiveCount ?? expectedActiveCount;
  const missingPriceCount = options.missingPriceCount ?? 0;
  const unavailableCount = options.unavailableCount ?? 0;
  return [
    {
      started_at: options.startedAt ?? NOW - 60,
      status: "ok",
      metadata: JSON.stringify({
        cacheWriteMode: "published",
        ...(options.includeCoverage === false ? {} : {
          activePriceCoverage: {
            complete: missingPriceCount === 0,
            expectedActiveCount,
            pricedActiveCount,
            missingPriceCount,
            nominalReferenceCount: 0,
          },
        }),
        ...(options.includeCensus === false ? {} : {
          quality: {
            depegObservation: {
              scope: "psi-non-nav-before-supply-floor",
              evaluatedAt: NOW - 120,
              eligibleCount: expectedActiveCount,
              observedCount: expectedActiveCount - unavailableCount,
              unavailableCount,
              belowFloorCount: 0,
              reasonCounts: options.reasonCounts ?? {},
            },
          },
        }),
      }),
    },
  ];
}

/** Fixtures for the depeg canaries: a completed census and no stalled candidates. */
function depegCanaryFixtures() {
  return [
    { match: "pharos:depeg-census-runs", rows: depegCensusRuns() },
    {
      match: "pharos:depeg-pending-confirmation-canary",
      first: { severe_recent: 0, stalled_count: 0, pending_count: 0, oldest_first_seen: null },
      rows: [],
    },
    { match: "pharos:depeg-pending-aged-candidates", rows: [] },
    { match: "pharos:ddr-eligible-unsealed-canary", rows: [] },
    { match: "pharos:depeg-open-coverage-canary", rows: [] },
    { match: "pharos:depeg-dex-suppression-canary", rows: [] },
  ];
}

function activeV9(options: { held?: boolean; updatedAt?: number } = {}) {
  const updatedAt = options.updatedAt ?? NOW - 60;
  const snapshot = makeWorkerReportCardsV9Response({
    asOfSec: updatedAt - 60,
    updatedAt,
    cards: [...ACTIVE_IDS]
      .sort()
      .map((id) => makeWorkerV9Card({ id, score: 92, grade: "A" })),
  });
  if (options.held) {
    snapshot.publicationHealth = {
      ...snapshot.publicationHealth,
      status: "held",
      heldSinceSec: updatedAt,
      attemptedAtSec: updatedAt + 60,
      reasons: [{ code: "assessment-failed", detail: "test hold" }],
    };
    return {
      kind: "held" as const,
      reason: "v9-publication-held" as const,
      detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot",
      snapshot,
    };
  }
  return {
    kind: "v9" as const,
    snapshot,
  };
}

beforeEach(() => {
  vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreCohort")
    .mockResolvedValue(activeV9());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixtures.closeAll();
});

function stablecoinsPayload(activeCount = ACTIVE_IDS.size) {
  const assets = [...ACTIVE_IDS].slice(0, activeCount).map((id) => ({
    id,
    symbol: id.slice(0, 5).toUpperCase(),
    name: id,
    price: 1,
    circulating: { peggedUSD: 1_000_000 },
  }));
  return JSON.stringify({ peggedAssets: assets });
}

function supplyCompletionRow(nowSec = NOW) {
  const ids = [...ACTIVE_IDS];
  const snapshotDate = startOfUtcDaySec(new Date(nowSec * 1000));
  return {
    key: "snapshot-supply:last-write",
    value: JSON.stringify({
      ...buildSupplySnapshotCompletionMarker({
        snapshotDate,
        coverage: buildSupplySnapshotCoverageExpectation(ids, []),
        accountedActiveCount: ids.length,
        ownedRowIds: ids,
        missingActiveIds: [],
        unavailableActiveIds: [],
      }),
      writtenRows: ids.length,
    }),
    updatedAt: nowSec - 60,
    updated_at: nowSec - 60,
  };
}

function gbpCanaryCacheRows(options: {
  freshRuns?: number;
  fallback?: boolean;
  usdRecordDateMissing?: boolean;
  recordDate?: string;
  fetchedAt?: number;
  streakValue?: string;
} = {}) {
  const recordDate = options.recordDate ?? new Date((NOW - 24 * 3600) * 1000).toISOString().slice(0, 10);
  const benchmark = (key: "USD" | "GBP", source: string) => ({
    key,
    rate: 4.1,
    recordDate,
    fetchedAt: options.fetchedAt ?? NOW - 60,
    source,
    isFallback: false,
    fallbackMode: null,
    lastMarketRate: 4.1,
    lastMarketRecordDate: recordDate,
    lastMarketFetchedAt: NOW - 60,
    lastMarketSource: source,
  });
  return [
    {
      key: "risk_free_rates",
      value: JSON.stringify({
        version: 1,
        generationId: "benchmark-generation",
        benchmarks: {
          USD: {
            ...benchmark("USD", "fred-dgs3mo"),
            ...(options.usdRecordDateMissing ? { recordDate: null } : {}),
          },
          GBP: {
            ...benchmark("GBP", "fred-sonia-compounded-index"),
            isFallback: options.fallback ?? false,
            fallbackMode: options.fallback ? "gbp-sonia-compounded-index-failed-retained" : null,
          },
        },
      }),
      updatedAt: NOW - 60,
      updated_at: NOW - 60,
    },
    {
      key: "fetch-tbill-rate:gbp-retained-fallback-streak",
      value: options.streakValue ?? JSON.stringify({ generationId: "benchmark-generation", consecutiveFreshRuns: options.freshRuns ?? 2 }),
      updatedAt: NOW - 60,
      updated_at: NOW - 60,
    },
    {
      key: "fetch-tbill-rate:usd-fresh-streak",
      value: options.streakValue ?? JSON.stringify({ generationId: "benchmark-generation", consecutiveFreshRuns: options.freshRuns ?? 2 }),
      updatedAt: NOW - 60,
      updated_at: NOW - 60,
    },
  ];
}

function dewsRows(computedAt = NOW - 60, outOfRangeCount = 0) {
  return Array.from({ length: 20 }, (_, index) => ({
    stablecoin_id: `stablecoin-${String(index).padStart(2, "0")}`,
    score: index < outOfRangeCount ? 101 : 20 + index,
    band: "CALM",
    signals_json: "{}",
    computed_at: computedAt,
  }));
}

function dewsPointerRow(rows: ReturnType<typeof dewsRows>, computedAt = NOW - 60) {
  return {
    key: "dews:published-generation",
    value: JSON.stringify({
      updatedAt: computedAt,
      source: "compute-dews",
      publishStatus: "published",
      coverageVersion: 2,
      expectedRowCount: rows.length,
      stablecoinIdsDigest: buildDewsStablecoinIdsDigest(rows.map((row) => row.stablecoin_id)),
    }),
    updatedAt: computedAt,
    updated_at: computedAt,
  };
}

function mintBurnPublicationCacheRow(overrides: {
  admittedCount?: number;
  legCount?: number;
  score?: number | null;
  watermarkAgeSec?: number;
  admittedPairs?: Array<[string, string]>;
  coinIds?: string[];
  pendingLegs?: Array<{ configKey: string; reason: string }>;
} = {}) {
  const admittedPairs = overrides.admittedPairs ?? [["usdt-tether", "ethereum"], ["usdc-circle", "ethereum"]];
  const admittedCount = overrides.admittedCount ?? admittedPairs.length;
  return {
    key: aggregateFlowCacheKey(24),
    value: JSON.stringify({
      publication: {
        evaluatedAt: NOW - 60,
        requiredBaselineSec: 90 * 86400,
        freshnessBudgetSec: 8 * 3600,
        legsScope: "non-admitted",
        legCount: overrides.legCount ?? Math.max(admittedCount, admittedPairs.length),
        admittedCount,
        pendingAdmissionCount: 0,
        disabledCount: 0,
        admittedPairs,
        legs: (overrides.pendingLegs ?? []).map((leg) => ({
          configKey: leg.configKey,
          status: "pending-admission",
          reason: leg.reason,
        })),
      },
      gauge: { score: overrides.score === undefined ? 42 : overrides.score },
      coins: (overrides.coinIds ?? [...new Set(admittedPairs.map(([id]) => id))])
        .map((stablecoinId) => ({ stablecoinId })),
      window: {
        start: NOW - 24 * 3600,
        end: NOW - 3600,
        semantics: "closed-utc-hours",
        watermark: {
          timestamp: NOW - (overrides.watermarkAgeSec ?? 3600),
          ageSec: overrides.watermarkAgeSec ?? 3600,
          maxAgeSec: 8 * 3600,
          unavailableReason: null,
        },
      },
    }),
    updatedAt: NOW - 60,
    updated_at: NOW - 60,
  };
}

function blacklistRosterCacheRow(overrides: {
  totalEvents?: number;
  balanceRows?: number;
  supportedConfigs?: number;
  behindConfigs?: unknown[];
} = {}) {
  return {
    key: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY,
    value: JSON.stringify({
      version: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION,
      materializedAt: NOW - 60,
      freshnessTs: NOW - 60,
      payload: {
        totalEvents: overrides.totalEvents ?? 12_345,
        freezeLedgerMeta: { totalRows: overrides.balanceRows ?? 42 },
        coverage: { counts: { supportedConfigs: overrides.supportedConfigs ?? 51 } },
        refresh: { observedAt: NOW - 60, behindConfigs: overrides.behindConfigs ?? [] },
      },
    }),
    updatedAt: NOW - 60,
    updated_at: NOW - 60,
  };
}

function canaryPublicationCacheRows() {
  return [mintBurnPublicationCacheRow(), blacklistRosterCacheRow()];
}

function healthyD1(
  dex: {
    rowCount?: number;
    latestPublishedRows?: number;
    latestGenerationPublishedRows?: number;
    unpublishedRows?: number;
    generationCount?: number;
    globalRows?: number;
    stablecoinsActiveCount?: number;
    blacklistEventNullIdentityRows?: number;
    blacklistBalanceNullIdentityRows?: number;
    gbpFreshRuns?: number;
    gbpFallback?: boolean;
    usdRecordDateMissing?: boolean;
    psiInputSnapshot?: string;
    tape?: {
      cursors?: Record<string, number>;
      clocks?: Partial<{
        psi_at: number;
        dews_at: number;
        score_legacy_at: number;
        score_v2_at: number;
        yield_history_at: number;
        yield_decisions_at: number;
      }>;
    };
    publicDataset?: {
      snapshot?: { snapshot_date: string; byte_size: number | null; created_at: number } | null;
      evidence?: Partial<{
        started_at: number;
        stablecoin_count: number | null;
        dews_count: number | null;
        liquidity_count: number | null;
        dews_computed_at: number | null;
        compressed_size: number | null;
        dex_published_row_count: number | null;
        sealed_dex_row_count: number | null;
      }> | null;
    };
  } = {},
) {
  const rowCount = dex.rowCount ?? 408;
  const latestPublishedRows = dex.latestPublishedRows ?? rowCount;
  const latestGenerationPublishedRows = dex.latestGenerationPublishedRows ?? latestPublishedRows;
  const unpublishedRows = dex.unpublishedRows ?? 0;
  const generationCount = dex.generationCount ?? 1;
  const globalRows = dex.globalRows ?? 1;
  const generationMetadata = JSON.stringify({ activeStablecoinCount: latestPublishedRows - 1 });
  const publishedDewsRows = dewsRows();
  return mockD1([
    {
      match: "canary-dex-current-summary",
      first: {
        row_count: latestPublishedRows,
        unpublished_rows: unpublishedRows,
        generation_count: generationCount,
        latest_updated_at: NOW - 30,
      },
      rows: [],
    },
    {
      match: "canary-dex-latest-published-generation",
      first: {
        generation_id: "dex-gen-1",
        current_row_count: latestPublishedRows,
        expected_row_count: latestPublishedRows,
        metadata_json: generationMetadata,
        published_at: NOW - 30,
      },
      rows: [],
    },
    {
      match: "canary-dex-latest-generation-summary",
      matchBinds: ["dex-gen-1"],
      first: {
        live_generation_rows: latestGenerationPublishedRows,
        global_rows: globalRows,
      },
      rows: [],
    },
    {
      match: "blacklist-null-identity-canary",
      first: {
        event_rows: dex.blacklistEventNullIdentityRows ?? 0,
        balance_rows: dex.blacklistBalanceNullIdentityRows ?? 0,
      },
      rows: [],
    },
    {
      match: "FROM cache WHERE key = ?",
      rows: [
        {
          key: "stablecoins",
          value: stablecoinsPayload(dex.stablecoinsActiveCount),
          updatedAt: NOW - 60,
          updated_at: NOW - 60,
        },
        dewsPointerRow(publishedDewsRows),
        ...gbpCanaryCacheRows({
          freshRuns: dex.gbpFreshRuns,
          fallback: dex.gbpFallback,
          usdRecordDateMissing: dex.usdRecordDateMissing,
        }),
        supplyCompletionRow(),
        ...canaryPublicationCacheRows(),
      ],
    },
    {
      match: "SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?",
      first: { count: [...ACTIVE_IDS].length },
      rows: [],
    },
    {
      match: "FROM cache WHERE key IN",
      rows: [
        "psi.band_changed",
        "dews.escalated",
        "dews.deescalated",
        "score.upgraded",
        "score.downgraded",
        "yield.warning_emitted",
        "yield.pys_dropped",
      ].map((eventClass) => ({
        key: `tape-projector:cursor:${eventClass}`,
        value: String(dex.tape?.cursors?.[eventClass] ?? NOW - 120),
        updated_at: NOW - 120,
      })),
    },
    {
      match: "canary:tape-class-liveness",
      first: {
        psi_at: NOW - 60,
        dews_at: NOW - 60,
        score_legacy_at: NOW - 60,
        score_v2_at: NOW - 60,
        yield_history_at: NOW - 60,
        yield_decisions_at: NOW - 60,
        ...dex.tape?.clocks,
      },
      rows: [],
    },
    {
      match: "pharos:canary:public-dataset-snapshot",
      first: dex.publicDataset?.snapshot === undefined
        ? { snapshot_date: "2026-03-05", byte_size: 4_096, created_at: NOW - 3_600 }
        : dex.publicDataset.snapshot,
      rows: [],
    },
    {
      match: "pharos:canary:public-dataset-publication",
      first: dex.publicDataset?.evidence === null
        ? null
        : {
            started_at: NOW - 3_600,
            stablecoin_count: 200,
            dews_count: 20,
            liquidity_count: 408,
            dews_computed_at: NOW - 4_000,
            compressed_size: 4_096,
            dex_published_row_count: 408,
            sealed_dex_row_count: 408,
            ...dex.publicDataset?.evidence,
          },
      rows: [],
    },
    {
      match: "FROM stability_index_samples",
      first: {
        stored_at: NOW - 60,
        score: 82,
        band: "STABLE",
        methodology_version: "v1",
        input_snapshot: dex.psiInputSnapshot ?? JSON.stringify({
          universeCoverage: {
            expected: 200,
            present: 200,
            admittedSupply: 200,
            missingFromCacheIds: [],
            supplyUnavailableIds: [],
            trendUnavailableIds: [],
          },
        }),
      },
      rows: [],
    },
    {
      match: "pharos:stress-signals:published-exact",
      matchBinds: [NOW - 60],
      rows: publishedDewsRows,
    },
    {
      match: "canary-stablecoins-pricing-runs",
      matchBinds: [2],
      rows: stablecoinsRunRows(),
    },
    {
      match: "INSERT INTO worker_canary_runs",
      rows: [],
    },
    ...depegCanaryFixtures(),
    {
      match: "INSERT INTO cache",
      rows: [],
    },
  ]);
}

describe("worker data invariant canaries", () => {
  it("normalizes canary rollout modes", () => {
    expect(normalizeWorkerCanaryMode(undefined)).toBe("off");
    expect(normalizeWorkerCanaryMode("status")).toBe("status");
    expect(normalizeWorkerCanaryMode("ALERT")).toBe("alert");
    expect(normalizeWorkerCanaryMode("nope")).toBe("off");
  });

  it("returns ok for healthy structural data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(healthyD1(), { observedAt: NOW, mode: "status" });

    expect(summary).toMatchObject({
      mode: "status",
      totalChecks: 21,

      okCount: 21,
      degradedCount: 0,
      errorCount: 0,
      skippedCount: 0,
      worstStatus: "ok",
      worstSeverity: "info",
    });
    expect(
      summary.results.find((result) => result.checkId === "safety-score-v9-publication")?.metadata,
    ).toMatchObject({ safetyScoreIdentity: { model: "v9" } });
  });

  it.each([[14_399, "ok"], [14_400, "ok"], [14_401, "degraded"]])(
    "preserves the four-hour PSI and DEWS incident tolerance at %i seconds",
    async (age, status) => {
      const observedAt = NOW - 60 + Number(age);
      const summary = await runCanaryChecks(healthyD1(), { observedAt, mode: "status" });
      for (const checkId of ["psi-latest-sample", "dews-latest-signal"]) {
        expect(summary.results.find((result) => result.checkId === checkId)).toMatchObject({
          status,
          metadata: { maxAgeSec: 14_400, ageSec: age },
        });
      }
    },
  );

  it("accepts a publication read after the serial run assessment clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(healthyD1(), { observedAt: NOW - 120, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "psi-latest-sample")).toMatchObject({
      status: "ok",
      metadata: { storedAt: NOW - 60, ageSec: 0 },
    });
  });

  it("rejects a future-dated PSI sample clock instead of publishing a clamped zero age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const futureStoredAt = NOW + 3_600;
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(
      `INSERT INTO stability_index_samples
         (stored_at, score, band, components, input_snapshot, methodology_version)
       VALUES (?, 82, 'STABLE', '{"trend":0}', '{}', 'v1')`,
    ).run(futureStoredAt);

    await runAndPersistCanaryChecks(db, { observedAt: NOW, mode: "status" });
    const psi = (await loadCanaryStatus(db, NOW, "status")).checks["psi-latest-sample"];

    expect(psi).toMatchObject({
      status: "degraded",
      metadata: {
        storedAt: futureStoredAt,
        ageSec: null,
        timestampReason: "future-timestamp",
        maxAgeSec: CANARY_INCIDENT_MAX_AGE_SEC.stabilityIndex,
      },
    });
    expect(psi?.error).toBe("latest PSI sample clock rejected: future-timestamp");
  });


  it.each([
    [200, 197, "degraded"],
    [200, 170, "error"],
    [200, 199, "ok"],
  ])("classifies PSI universe coverage %i expected / %i admitted as %s", async (expected, admitted, status) => {
    const summary = await runCanaryChecks(healthyD1({
      psiInputSnapshot: JSON.stringify({
        universeCoverage: {
          expected,
          present: admitted,
          admittedSupply: admitted,
          missingFromCacheIds: Array.from({ length: expected - admitted }, (_, index) => `missing-${index}`),
          supplyUnavailableIds: [],
          trendUnavailableIds: [],
        },
      }),
    }), { observedAt: NOW, mode: "status" });
    const psi = summary.results.find((result) => result.checkId === "psi-latest-sample");
    expect(psi).toMatchObject({
      status,
      metadata: {
        universeCoverage: {
          status,
          expected,
          admittedSupply: admitted,
        },
      },
    });
  });

  it("degrades when the persisted PSI input snapshot is unreadable", async () => {
    const summary = await runCanaryChecks(healthyD1({ psiInputSnapshot: "not-json" }), {
      observedAt: NOW,
      mode: "status",
    });
    expect(summary.results.find((result) => result.checkId === "psi-latest-sample")).toMatchObject({
      status: "degraded",
      error: "latest PSI sample input snapshot is unreadable",
      metadata: { universeCoverage: null, universeCoverageReason: "input-snapshot-invalid" },
    });
  });

  it("flags a snapshot tape class whose cursor lags a moving source clock", async () => {
    const summary = await runCanaryChecks(healthyD1({
      tape: { cursors: { "psi.band_changed": NOW - 6_000 } },
    }), { observedAt: NOW, mode: "status" });
    const tape = summary.results.find((result) => result.checkId === "tape-class-liveness");
    expect(tape).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("psi.band_changed (5940s)"),
      metadata: { lagBudgetSec: 5_400, evaluatedCount: 7 },
    });
  });

  it("skips tape liveness when every source clock is stale", async () => {
    const stale = NOW - 200_000;
    const summary = await runCanaryChecks(healthyD1({
      tape: {
        clocks: {
          psi_at: stale,
          dews_at: stale,
          score_legacy_at: stale,
          score_v2_at: stale,
          yield_history_at: stale,
          yield_decisions_at: stale,
        },
      },
    }), { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "tape-class-liveness")).toMatchObject({
      status: "skipped",
      error: "tape-source-stale",
      metadata: { evaluatedCount: 0 },
    });
  });

  it("clocks score tape classes from organic history rows only", async () => {
    const { sqlite, db } = fixtures.open();
    const organicAt = NOW - 10_000;
    const insertV2 = sqlite.prepare(
      `INSERT INTO safety_score_history_v2
         (history_id, stablecoin_id, recorded_at, model, methodology_version, policy_id,
          policy_digest, evaluation_build_digest, base_input_generation_id,
          model_publication_generation_id, transition_kind, grade, score, prev_grade, created_at)
       VALUES (?, 'usdt-tether', ?, 'v9', 'v9', 'psi-policy', ?, ?, ?, 'generation-1', ?, 'A', 90, ?, 1)`,
    );
    const buildDigest = "d".repeat(64);
    const baseInput = `report-cards-input:v1:${"a".repeat(64)}`;
    insertV2.run("organic-1", organicAt, "p".repeat(64), buildDigest, baseInput, "organic-grade-change", "B+");
    insertV2.run("boundary-1", NOW, "p".repeat(64), buildDigest, baseInput, "methodology-boundary-baseline", null);
    const insertCursor = sqlite.prepare(
      "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
    );
    for (const eventClass of ["score.upgraded", "score.downgraded"]) {
      insertCursor.run(tapeProjectorCursorKey(eventClass), String(organicAt), organicAt);
    }

    const result = await checkTapeClassLiveness(db, NOW, {});
    expect(result).toMatchObject({
      status: "ok",
      metadata: {
        classes: expect.arrayContaining([
          expect.objectContaining({
            eventClass: "score.upgraded",
            sourceMax: organicAt,
            lagSec: 0,
            evaluated: true,
            reason: null,
          }),
          expect.objectContaining({
            eventClass: "score.downgraded",
            sourceMax: organicAt,
            lagSec: 0,
            evaluated: true,
            reason: null,
          }),
        ]),
      },
    });
  });

  it("flags an empty sealed public-dataset section even when the run reports success", async () => {
    const summary = await runCanaryChecks(healthyD1({
      publicDataset: { evidence: { stablecoin_count: 0 } },
    }), { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "public-dataset-snapshot-completeness"))
      .toMatchObject({
        status: "error",
        error: "sealed public snapshot has an empty stablecoins section",
        metadata: { snapshotDate: "2026-03-05", stablecoinCount: 0 },
      });
  });

  it("flags a sealed liquidity section smaller than the published generation", async () => {
    const summary = await runCanaryChecks(healthyD1({
      publicDataset: { evidence: { liquidity_count: 3 } },
    }), { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "public-dataset-snapshot-completeness"))
      .toMatchObject({
        status: "degraded",
        error: "sealed liquidity section has 3 rows for a 408-row published generation",
      });
  });

  it("compares the sealed liquidity section with its own sealed generation, not a later one", async () => {
    const summary = await runCanaryChecks(healthyD1({
      publicDataset: {
        evidence: { liquidity_count: 408, dex_published_row_count: 500, sealed_dex_row_count: 408 },
      },
    }), { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "public-dataset-snapshot-completeness"))
      .toMatchObject({
        status: "ok",
        metadata: { liquidityCount: 408, sealedDexPublicationRowCount: 408 },
      });
  });

  it("falls back to the live DEX generation for a sealed row written before the count was recorded", async () => {
    const summary = await runCanaryChecks(healthyD1({
      publicDataset: {
        evidence: { liquidity_count: 408, dex_published_row_count: 500, sealed_dex_row_count: null },
      },
    }), { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "public-dataset-snapshot-completeness"))
      .toMatchObject({
        status: "degraded",
        error: "sealed liquidity section has 408 rows for a 500-row published generation",
      });
  });

  it("flags a sealed DEWS generation that exceeded its consumer budget", async () => {
    const summary = await runCanaryChecks(healthyD1({
      publicDataset: { evidence: { dews_computed_at: NOW - 10_000 } },
    }), { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "public-dataset-snapshot-completeness"))
      .toMatchObject({
        status: "degraded",
        error: "sealed DEWS generation exceeded its 3600s consumer budget (6400s)",
      });
  });

  it("keeps a legacy sealed row unknown when its publication metadata is outside retention", async () => {
    const summary = await runCanaryChecks(healthyD1({
      publicDataset: { evidence: null },
    }), { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "public-dataset-snapshot-completeness"))
      .toMatchObject({
        status: "skipped",
        error: "public-snapshot-publication-metadata-unavailable",
      });
  });

  it("reads the newest sealed snapshot's persisted publication counts against SQLite", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(
      `INSERT INTO public_snapshots
         (snapshot_date, payload_gz, methodology_versions, content_hash, byte_size, created_at)
       VALUES (?, ?, '{}', 'hash', 4096, ?)`,
    ).run("2026-03-05", new Uint8Array([1, 2]), NOW - 3_600);
    sqlite.prepare(
      `INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata)
       VALUES ('snapshot-public-dataset', ?, 1000, 'ok', 1, ?)`,
    ).run(NOW - 3_600, JSON.stringify({
      snapshotDate: "2026-03-05",
      stablecoinCount: 200,
      dewsCount: 20,
      liquidityCount: 408,
      dewsComputedAt: NOW - 4_000,
      compressedSize: 4_096,
    }));

    const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "status" });
    expect(summary.results.find((result) => result.checkId === "public-dataset-snapshot-completeness"))
      .toMatchObject({
        status: "ok",
        metadata: {
          snapshotDate: "2026-03-05",
          stablecoinCount: 200,
          dewsCount: 20,
          liquidityCount: 408,
          publicationStartedAt: NOW - 3_600,
        },
      });
  });

  it("flags a seeded null-identity blacklist row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(healthyD1({ blacklistEventNullIdentityRows: 1 }), {
      observedAt: NOW,
      mode: "status",
    });
    const check = summary.results.find((result) => result.checkId === "blacklist-null-identity");

    expect(check).toMatchObject({
      status: "error",
      severity: "error",
      error: "blacklist identity invariant failed: 1 blacklist_events and 0 blacklist_current_balances rows have null config_key and contract_address",
      executionStatus: "completed",
      executionFailureReason: null,
      metadata: {
        eventRows: 1,
        balanceRows: 0,
        totalRows: 1,
      },
    });
    expect(summary.errorCount).toBe(1);
  });

  it("degrades while the canonical V9 publication is held", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.mocked(activeSafetyScoreSource.loadActiveSafetyScoreCohort)
      .mockResolvedValueOnce(activeV9({ held: true }));
    const summary = await runCanaryChecks(healthyD1(), {
      observedAt: NOW,
      mode: "status",
    });
    const reportCards = summary.results.find((result) => result.checkId === "safety-score-v9-publication");

    expect(reportCards).toMatchObject({
      status: "degraded",
      severity: "warning",
      error: "Safety Score V9 publication is held",
      metadata: { safetyScoreIdentity: { model: "v9" } },
    });
  });

  it("fails closed when the canonical V9 publication is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.mocked(activeSafetyScoreSource.loadActiveSafetyScoreCohort)
      .mockResolvedValueOnce({
        kind: "error",
        reason: "v9-snapshot-unavailable",
        snapshot: null,
        detail: "missing",
      });
    const summary = await runCanaryChecks(healthyD1(), {
      observedAt: NOW,
      mode: "status",
    });
    const reportCards = summary.results.find((result) => result.checkId === "safety-score-v9-publication");

    expect(reportCards).toMatchObject({
      status: "error",
      severity: "error",
      error: "active Safety Score source v9-snapshot-unavailable",
      executionStatus: "failed",
      metadata: {
        reason: "v9-snapshot-unavailable",
      },
    });
  });

  it("derives DEWS canary health from the exact published generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = healthyD1();

    const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "status" });
    const dews = summary.results.find((result) => result.checkId === "dews-latest-signal");

    expect(dews).toMatchObject({
      status: "ok",
      metadata: expect.objectContaining({
        sourceTable: "stress_signals",
        latestComputedAt: NOW - 60,
        exactCoverageVerified: true,
      }),
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("stress_signals_latest"))).toBe(false);
  });

  it.each([
    ["a routine single omission", 1, "ok", "info"],
    ["an elevated 1% omission", Math.ceil(ACTIVE_IDS.size * 0.01), "degraded", "warning"],
    ["a systemic >10% omission", Math.floor(ACTIVE_IDS.size * 0.1) + 1, "error", "error"],
  ] as const)("bands %s of active stablecoins", async (_label, missing, status, severity) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(healthyD1({ stablecoinsActiveCount: ACTIVE_IDS.size - missing }), {
      observedAt: NOW,
      mode: "status",
    });
    const check = summary.results.find((result) => result.checkId === "stablecoins-cache-active-count");

    expect(check).toMatchObject({
      status,
      severity,
      metadata: expect.objectContaining({
        activeCount: ACTIVE_IDS.size - missing,
        expectedActiveCount: ACTIVE_IDS.size,
      }),
    });
    const missingIds = check?.metadata?.missingActiveIds as string[];
    expect(missingIds).toHaveLength(missing);
    if (status !== "ok") expect(check?.error).toContain(missingIds[0]!);
  });

  it("keeps the GBP benchmark canary degraded until two direct publications", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const oneRun = await runCanaryChecks(healthyD1({ gbpFreshRuns: 1 }), {
      observedAt: NOW,
      mode: "status",
    });
    expect(oneRun.results.find((result) => result.checkId === "yield-gbp-benchmark-current")).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("1/2 consecutive fresh publications"),
    });

    const fallback = await runCanaryChecks(healthyD1({ gbpFreshRuns: 0, gbpFallback: true }), {
      observedAt: NOW,
      mode: "status",
    });
    expect(fallback.results.find((result) => result.checkId === "yield-gbp-benchmark-current")).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("GBP benchmark is fallback"),
    });

    const usdOneRun = await runCanaryChecks(healthyD1({ gbpFreshRuns: 1 }), {
      observedAt: NOW,
      mode: "status",
    });
    expect(usdOneRun.results.find((result) => result.checkId === "yield-usd-benchmark-current")).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("USD benchmark has 1/2 consecutive fresh publications"),
    });

    const usdFallback = await runCanaryChecks(healthyD1({ gbpFreshRuns: 0, gbpFallback: true }), {
      observedAt: NOW,
      mode: "status",
    });
    expect(usdFallback.results.find((result) => result.checkId === "yield-usd-benchmark-current")).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("0/2 consecutive fresh publications"),
    });
  });

  it.each([-1, 0, 1])("uses the shared five-day GBP/USD record budget (offset=%s)", async (offset) => {
    const recordDate = new Date(NOW * 1000).toISOString().slice(0, 10);
    const recordAt = Date.parse(`${recordDate}T00:00:00Z`) / 1000;
    const observedAt = recordAt + 5 * 86_400 + offset;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedAt * 1000));
    const db = mockD1([{ match: "FROM cache WHERE key = ?", rows: gbpCanaryCacheRows({ recordDate, fetchedAt: observedAt }) }]);
    const summary = await runCanaryChecks(db, { mode: "status", observedAt });
    for (const currency of ["gbp", "usd"]) {
      expect(summary.results.find((result) => result.checkId === `yield-${currency}-benchmark-current`)).toMatchObject({
        status: offset <= 0 ? "ok" : "degraded", executionStatus: "completed",
        metadata: { maxRecordAgeSec: 5 * 86_400, maxFetchAgeSec: 48 * 3600 },
      });
    }
  });

  it.each(["{}", "{", '{"consecutiveFreshRuns":-1}', '{"consecutiveFreshRuns":1.5}'])(
    "keeps malformed benchmark publication streak unknown (%s)", async (streakValue) => {
      const db = mockD1([{ match: "FROM cache WHERE key = ?", rows: gbpCanaryCacheRows({ streakValue }) }]);
      const summary = await runCanaryChecks(db, { mode: "status", observedAt: NOW });
      for (const currency of ["gbp", "usd"]) {
        expect(summary.results.find((result) => result.checkId === `yield-${currency}-benchmark-current`)).toMatchObject({
          executionStatus: "failed", executionFailureReason: "benchmark-fresh-streak-unavailable",
          metadata: { consecutiveFreshRuns: null },
        });
      }
    },
  );

  it.each(["registry-generationless", "all-generationless", "legacy-missing-marker", "marker-generationless", "generation-mismatch"] as const)(
    "does not certify unrelated benchmark recovery evidence (%s)", async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW * 1000));
      const { db, sqlite } = fixtures.open();
      for (const row of gbpCanaryCacheRows()) {
        const payload = JSON.parse(row.value);
        if (["registry-generationless", "all-generationless", "legacy-missing-marker"].includes(kind) && row.key === "risk_free_rates") {
          delete payload.generationId;
        }
        if (row.key !== "risk_free_rates") {
          if (kind === "legacy-missing-marker") continue;
          if (kind === "marker-generationless" || kind === "all-generationless") delete payload.generationId;
          if (kind === "generation-mismatch") payload.generationId = "another-publication";
        }
        sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
          row.key, JSON.stringify(payload), row.updatedAt,
        );
      }
      const summary = await runCanaryChecks(db, { mode: "status", observedAt: NOW });
      for (const currency of ["gbp", "usd"]) {
        const legacyRegistry = ["registry-generationless", "all-generationless", "legacy-missing-marker"].includes(kind);
        const reason = legacyRegistry
          ? "benchmark-registry-generation-legacy"
          : kind === "marker-generationless"
            ? "benchmark-fresh-streak-generation-unavailable"
            : "benchmark-fresh-streak-generation-mismatch";
        expect(summary.results.find((result) => result.checkId === `yield-${currency}-benchmark-current`)).toMatchObject({
          status: legacyRegistry ? "skipped" : "error",
          executionStatus: legacyRegistry ? "completed" : "failed",
          executionFailureReason: legacyRegistry ? null : reason,
          error: reason,
          metadata: legacyRegistry
            ? { generationId: null, consecutiveFreshRuns: null, reason }
            : { consecutiveFreshRuns: 2 },
        });
      }
    },
  );

  it("degrades USD when its benchmark record date is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(healthyD1({ usdRecordDateMissing: true }), {
      observedAt: NOW,
      mode: "status",
    });

    expect(summary.results.find((result) => result.checkId === "yield-usd-benchmark-current")).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("USD benchmark observation is stale"),
    });
  });

  it("accepts a live table matching the latest published generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(
      healthyD1({
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 368,
        generationCount: 2,
      }),
      { observedAt: NOW, mode: "status" },
    );

    const dexResult = summary.results.find((result) => result.checkId === "dex-liquidity-current-publication");

    expect(dexResult).toMatchObject({
      status: "ok",
      severity: "info",
      metadata: expect.objectContaining({
        rowCount: 368,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 368,
      }),
    });
    expect(summary.worstStatus).toBe("ok");
  });

  it("errors when generation-backed DEX rows in any generation are not published", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(
      healthyD1({
        rowCount: 377,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 368,
        unpublishedRows: 1,
        generationCount: 2,
      }),
      { observedAt: NOW, mode: "status" },
    );

    expect(summary.results.find((result) => result.checkId === "dex-liquidity-current-publication")).toMatchObject({
      status: "error",
      severity: "error",
      error: "1 current DEX liquidity rows are not published",
      executionStatus: "completed",
    });
  });

  it("errors when the latest DEX generation row count drifts from publication metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(
      healthyD1({
        rowCount: 377,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 367,
        generationCount: 2,
      }),
      { observedAt: NOW, mode: "status" },
    );

    expect(summary.results.find((result) => result.checkId === "dex-liquidity-current-publication")).toMatchObject({
      status: "error",
      severity: "error",
      error: "DEX latest-generation rows 367 differ from latest published generation 368",
      executionStatus: "completed",
      metadata: expect.objectContaining({
        rowCount: 368,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 367,
      }),
    });
  });

  it.each([null, "staged", "failed", "published"])(
    "ignores generationless legacy DEX rows with publication state %s", async (publicationState) => {
      const { db, sqlite } = fixtures.open();
      sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, current_row_count, metadata_json, created_at, published_at)
        VALUES ('current', ?, 'published', 2, 2, '{"activeStablecoinCount":1}', ?, ?)`).run(NOW, NOW, NOW);
      const insert = sqlite.prepare(`INSERT INTO dex_liquidity
        (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
        VALUES (?, 'TEST', ?, ?, ?)`);
      insert.run("asset", NOW, "current", "published");
      insert.run("__global__", NOW, "current", "published");
      for (const id of ["buck-buck-assets", "euroe-membrane", "usnd-nerite", "usr-resolv"]) {
        insert.run(id, NOW - 60, null, publicationState);
      }

      const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "status" });
      expect(summary.results.find((result) => result.checkId === "dex-liquidity-current-publication")).toMatchObject({
        status: "ok",
        severity: "info",
        executionStatus: "completed",
        executionFailureReason: null,
        metadata: {
          unpublishedRows: 0,
          rowCount: 2,
          latestPublishedRows: 2,
          latestPublishedExpectedRows: 2,
          latestGenerationPublishedRows: 2,
        },
      });
    },
  );

  it.each([null, "staged", "failed"])(
    "still errors on generation-backed DEX rows with publication state %s", async (publicationState) => {
      const { db, sqlite } = fixtures.open();
      sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, current_row_count, metadata_json, created_at, published_at)
        VALUES ('current', ?, 'published', 2, 2, '{"activeStablecoinCount":1}', ?, ?)`).run(NOW, NOW, NOW);
      sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, created_at)
        VALUES ('candidate', ?, 'staged', 1, ?)`).run(NOW, NOW);
      const insert = sqlite.prepare(`INSERT INTO dex_liquidity
        (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
        VALUES (?, 'TEST', ?, ?, ?)`);
      insert.run("asset", NOW, "current", "published");
      insert.run("__global__", NOW, "current", "published");
      insert.run("legacy", NOW - 60, null, null);
      insert.run("unpublished", NOW, "candidate", publicationState);

      const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "status" });
      expect(summary.results.find((result) => result.checkId === "dex-liquidity-current-publication")).toMatchObject({
        status: "error",
        severity: "error",
        executionStatus: "completed",
        executionFailureReason: null,
        error: "1 current DEX liquidity rows are not published",
        metadata: {
          unpublishedRows: 1,
          rowCount: 2,
          latestPublishedRows: 2,
          latestGenerationPublishedRows: null,
        },
      });
    },
  );

  it("checks the actual global identity only inside the published generation", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
      (generation_id, started_at, state, expected_row_count, current_row_count, metadata_json, created_at, published_at)
      VALUES ('current', ?, 'published', 2, 2, '{"activeStablecoinCount":1}', ?, ?)`).run(NOW, NOW, NOW);
    sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
      (generation_id, started_at, state, expected_row_count, written_row_count, created_at)
      VALUES ('candidate', ?, 'staged', 2, 2, ?)`).run(NOW, NOW);
    const insert = sqlite.prepare(`INSERT INTO dex_liquidity
      (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
      VALUES (?, 'TEST', ?, ?, 'published')`);
    insert.run("asset", NOW, "current");
    insert.run("replacement", NOW, "current");
    insert.run("__global__", NOW - 60, "older");
    const check = async () => (await runCanaryChecks(db, { observedAt: NOW, mode: "status" }))
      .results.filter(({ checkId }) => checkId.startsWith("dex-liquidity-"));
    expect(await check()).toMatchObject([
      { status: "ok" },
      { status: "degraded", metadata: { generationId: "current", currentRows: 2, globalRows: 0 } },
    ]);
    sqlite.exec("DELETE FROM dex_liquidity WHERE stablecoin_id = '__global__'");
    sqlite.exec("UPDATE dex_liquidity SET stablecoin_id = '__global__' WHERE stablecoin_id = 'replacement'");
    expect(await check()).toMatchObject([{ status: "ok" }, { status: "ok", metadata: { globalRows: 1 } }]);
    sqlite.exec("DELETE FROM dex_liquidity");
    expect((await check())[1]).toMatchObject({ status: "degraded", metadata: { currentRows: 0, globalRows: 0 } });
    sqlite.exec("DELETE FROM dex_liquidity_publication_generations");
    expect((await check())[1]).toMatchObject({ status: "degraded", metadata: { generationId: null } });
  });

  it("degrades noisy invariants without aborting the rest of the run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const unhealthyDewsRows = dewsRows(NOW - 60, 2);
    const db = mockD1([
      {
        match: "canary-dex-current-summary",
        first: { row_count: 408, unpublished_rows: 3, generation_count: 1, latest_updated_at: NOW - 30 },
        rows: [],
      },
      {
        match: "canary-dex-latest-published-generation",
        first: {
          generation_id: "dex-gen-1",
          current_row_count: 408,
          expected_row_count: 408,
          metadata_json: JSON.stringify({ activeStablecoinCount: 408 }),
          published_at: NOW - 30,
        },
        rows: [],
      },
      {
        match: "canary-dex-latest-generation-summary",
        first: { live_generation_rows: 408, global_rows: 0 },
        rows: [],
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          { key: "stablecoins", value: stablecoinsPayload(1), updatedAt: NOW - 60, updated_at: NOW - 60 },
          dewsPointerRow(unhealthyDewsRows),
          ...gbpCanaryCacheRows(),
          supplyCompletionRow(),
          ...canaryPublicationCacheRows(),
        ],
      },
      {
        match: "SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?",
        first: { count: [...ACTIVE_IDS].length },
        rows: [],
      },
      {
        match: "FROM cache WHERE key IN",
        rows: [
          "psi.band_changed",
          "dews.escalated",
          "dews.deescalated",
          "score.upgraded",
          "score.downgraded",
          "yield.warning_emitted",
          "yield.pys_dropped",
        ].map((eventClass) => ({
          key: `tape-projector:cursor:${eventClass}`,
          value: String(NOW - 120),
          updated_at: NOW - 120,
        })),
      },
      {
        match: "canary:tape-class-liveness",
        first: {
          psi_at: NOW - 60,
          dews_at: NOW - 60,
          score_legacy_at: NOW - 60,
          score_v2_at: NOW - 60,
          yield_history_at: NOW - 60,
          yield_decisions_at: NOW - 60,
        },
        rows: [],
      },
      {
        match: "pharos:canary:public-dataset-snapshot",
        first: { snapshot_date: "2026-03-05", byte_size: 4_096, created_at: NOW - 3_600 },
        rows: [],
      },
      {
        match: "pharos:canary:public-dataset-publication",
        first: {
          started_at: NOW - 3_600,
          stablecoin_count: 200,
          dews_count: 20,
          liquidity_count: 408,
          dews_computed_at: NOW - 4_000,
          compressed_size: 4_096,
          dex_published_row_count: 408,
        },
        rows: [],
      },
      {
        match: "FROM stability_index_samples",
        first: {
          stored_at: NOW - 20_000,
          score: 82,
          band: "STABLE",
          methodology_version: "v1",
        },
        rows: [],
      },
      {
        match: "pharos:stress-signals:published-exact",
        matchBinds: [NOW - 60],
        rows: unhealthyDewsRows,
      },
      ...depegCanaryFixtures(),
      {
        match: "canary-stablecoins-pricing-runs",
        matchBinds: [2],
        rows: stablecoinsRunRows(),
      },
      {
        match: "INSERT INTO cache",
        rows: [],
      },
    ]);

    const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "shadow" });

    expect(summary.worstStatus).toBe("error");
    expect(summary.errorCount).toBe(4);
    expect(summary.degradedCount).toBe(2);
    expect(summary.results.map((result) => [result.checkId, result.status])).toContainEqual([
      "dex-liquidity-current-publication",
      "error",
    ]);
  });

  it("persists idempotently and selects the latest active checks in the requested mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { db, sqlite } = fixtures.open();
    await runAndPersistCanaryChecks(db, { observedAt: NOW, mode: "status" });
    const summary = await runAndPersistCanaryChecks(db, { observedAt: NOW, mode: "status" });
    expect(sqlite.prepare("SELECT check_id, COUNT(*) AS count FROM worker_canary_runs GROUP BY check_id ORDER BY check_id").all())
      .toEqual([...EXPECTED_CANARY_CHECK_IDS].sort().map((check_id) => ({ check_id, count: 1 })));
    await runAndPersistCanaryChecks(db, { observedAt: NOW - 30, mode: "status" });
    await runAndPersistCanaryChecks(db, { observedAt: NOW + 30, mode: "alert" });
    sqlite.exec(`INSERT INTO worker_canary_runs
      (id, check_id, idempotency_key, status, severity, observed_at, duration_ms, metadata_json, error, mode)
      VALUES ('retired', 'report-card-cache-methodology', 'retired', 'error', 'error', ${NOW + 40}, 1, '{}', 'retired', 'status')`);
    const status = await loadCanaryStatus(db, NOW + 60, "status");
    expect(Object.keys(status.checks).sort()).toEqual([...EXPECTED_CANARY_CHECK_IDS].sort());
    expect(status).toMatchObject({
      latestRunAt: NOW,
      totalChecks: summary.totalChecks,
      okCount: summary.okCount,
      errorCount: summary.errorCount,
      degradedCount: summary.degradedCount,
      staleCount: 0,
    });
    const alert = await loadCanaryStatus(db, NOW + 60, "alert");
    expect(alert.latestRunAt).toBe(NOW + 30);
    expect(Object.keys(alert.checks).sort()).toEqual([...EXPECTED_CANARY_CHECK_IDS].sort());
  });

  it("maps fresh persisted checks to healthy and either warning class to degraded", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO worker_canary_runs
      (id, check_id, idempotency_key, status, severity, observed_at, duration_ms, metadata_json, error, mode)
      VALUES (?, ?, ?, 'ok', 'info', ?, 1, '{"executionStatus":"completed"}', NULL, 'status')`);
    for (const id of EXPECTED_CANARY_CHECK_IDS) insert.run(id, id, id, NOW);
    expect((await loadCanaryStatus(db, NOW + 60, "status")).status).toBe("healthy");

    const update = sqlite.prepare("UPDATE worker_canary_runs SET status = ? WHERE check_id = ?");
    update.run("degraded", EXPECTED_CANARY_CHECK_IDS[0]);
    expect((await loadCanaryStatus(db, NOW + 60, "status")).status).toBe("degraded");
    update.run("error", EXPECTED_CANARY_CHECK_IDS[0]);
    expect((await loadCanaryStatus(db, NOW + 60, "status")).status).toBe("degraded");
    update.run("ok", EXPECTED_CANARY_CHECK_IDS[0]);
    expect((await loadCanaryStatus(db, NOW + 60, "status")).status).toBe("healthy");
    sqlite.prepare("UPDATE worker_canary_runs SET metadata_json = '{}'").run();
    expect(await loadCanaryStatus(db, NOW + 60, "status")).toMatchObject({
      status: "degraded", unknownExecutionCount: EXPECTED_CANARY_CHECK_IDS.length,
    });
  });

  it("requires every active ID and fresh usable observations rather than just the returned count", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO worker_canary_runs
      (id, check_id, idempotency_key, status, severity, observed_at, duration_ms, metadata_json, error, mode)
      VALUES (?, ?, ?, 'ok', 'info', ?, 1, '{"executionStatus":"completed"}', NULL, 'status')`);
    const empty = await loadCanaryStatus(db, NOW, "status");
    expect(empty.status).toBe("unknown");
    expect(empty.missingCheckIds).toEqual(expect.arrayContaining(EXPECTED_CANARY_CHECK_IDS));
    const first = EXPECTED_CANARY_CHECK_IDS[0];
    insert.run(first, first, first, NOW);
    const partial = await loadCanaryStatus(db, NOW, "status");
    expect(partial).toMatchObject({ status: "degraded", totalChecks: 1, presentCheckIds: [first] });
    expect(partial.missingCheckIds).toEqual(EXPECTED_CANARY_CHECK_IDS.slice(1));
    for (const id of EXPECTED_CANARY_CHECK_IDS.slice(1)) insert.run(id, id, id, NOW);
    expect((await loadCanaryStatus(db, NOW + 7_200, "status")).status).toBe("healthy");
    sqlite.prepare("UPDATE worker_canary_runs SET observed_at = ? WHERE check_id = ?").run(NOW - 1, first);
    expect(await loadCanaryStatus(db, NOW + 7_200, "status")).toMatchObject({ status: "stale", staleCount: 1 });
    sqlite.prepare("UPDATE worker_canary_runs SET observed_at = ?, status = 'skipped' WHERE check_id = ?").run(NOW, first);
    expect((await loadCanaryStatus(db, NOW, "status")).status).toBe("degraded");
    sqlite.prepare("UPDATE worker_canary_runs SET check_id = 'retired' WHERE check_id = ?").run(first);
    expect(await loadCanaryStatus(db, NOW, "status")).toMatchObject({ status: "degraded", missingCheckIds: [first] });
  });

  it("rejects materially future observation clocks without discarding hard findings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const { db } = fixtures.open();
    await runAndPersistCanaryChecks(db, { observedAt: NOW + 86_400, mode: "status" });
    expect(await loadCanaryStatus(db, NOW, "status")).toMatchObject({
      status: "stale", staleCount: EXPECTED_CANARY_CHECK_IDS.length,
    });
  });

  it("does not turn absent required aggregates into measured zero findings", async () => {
    const db = mockD1([]);
    const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "status" });
    for (const checkId of ["blacklist-null-identity", "dex-liquidity-current-publication"]) {
      expect(summary.results.find((result) => result.checkId === checkId)).toMatchObject({
        status: "error", executionStatus: "failed",
      });
    }
  });
  it.each(["off", "shadow"] as const)(
    "returns the empty compatibility shape without querying retained rows in %s mode",
    async (mode) => {
      const db = mockD1([]);

      const status = await loadCanaryStatus(db, NOW + 60, mode);

      expect(status).toMatchObject({
        checkedAt: NOW + 60,
        status: "unknown",
        latestRunAt: null,
        maxAgeSec: 7_200,
        totalChecks: 0,
        okCount: 0,
        degradedCount: 0,
        errorCount: 0,
        skippedCount: 0,
        staleCount: 0,
        checks: {},
      });
      expect(db.getHistory()).toHaveLength(0);
    },
  );


  it("reports missing mandatory tables as canary errors without aborting sibling checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "canary-dex-current-summary",
        throwError: new Error("D1_ERROR: no such table: dex_liquidity_publication_generations"),
        rows: [],
      },
      {
        match: "canary-dex-latest-published-generation",
        throwError: new Error("D1_ERROR: no such table: dex_liquidity_publication_generations"),
        rows: [],
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          { key: "stablecoins", value: stablecoinsPayload(), updatedAt: NOW - 60, updated_at: NOW - 60 },
          ...gbpCanaryCacheRows(),
          supplyCompletionRow(),
          ...canaryPublicationCacheRows(),
        ],
      },
      {
        match: "SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?",
        first: { count: [...ACTIVE_IDS].length },
        rows: [],
      },
      {
        match: "pharos:canary:public-dataset-snapshot",
        first: { snapshot_date: "2026-03-05", byte_size: 4_096, created_at: NOW - 3_600 },
        rows: [],
      },
      {
        match: "pharos:canary:public-dataset-publication",
        first: {
          started_at: NOW - 3_600,
          stablecoin_count: 200,
          dews_count: 20,
          liquidity_count: 408,
          dews_computed_at: NOW - 4_000,
          compressed_size: 4_096,
          dex_published_row_count: 408,
        },
        rows: [],
      },
      {
        match: "FROM stability_index_samples",
        throwError: new Error("D1_ERROR: no such table: stability_index_samples"),
        rows: [],
      },
      {
        match: "FROM stress_signals_latest",
        throwError: new Error("D1_ERROR: no such table: stress_signals_latest"),
        rows: [],
      },
      {
        match: "FROM stress_signals",
        throwError: new Error("D1_ERROR: no such table: stress_signals"),
        rows: [],
      },
      ...depegCanaryFixtures().map((fixture) => ({
        ...fixture,
        throwError: new Error("D1_ERROR: no such table: depeg canary source"),
        rows: [],
      })),
      {
        match: "INSERT INTO cache",
        rows: [],
      },
    ]);

    const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "status" });

    // The depeg and pricing checks read cron_runs and depeg tables, which this fixture also omits.
    // The mint/burn and blacklist checks read the healthy cache rows above, so the union keeps
    // the original error total and adds two healthy observations.
    // tape-class-liveness fails on the omitted stability-index source clock above, while the
    // public-dataset check reads the two rows supplied here: the union adds one error and one ok.
    expect(summary.errorCount).toBe(12);
    expect(summary.skippedCount).toBe(0);
    expect(summary.degradedCount).toBe(1);
    expect(summary.okCount).toBe(8);
    expect(summary.worstStatus).toBe("error");
  });
});

describe("pricing canaries", () => {
  function pricingDb(rows: Record<string, unknown>[], publishedRows?: Record<string, unknown>[]) {
    return mockD1([
      { match: "canary-stablecoins-pricing-runs", matchBinds: [2], rows },
      ...(publishedRows
        ? [{ match: "canary-stablecoins-published-runs", rows: publishedRows }]
        : []),
    ]);
  }

  async function runPricingCheck(
    checkId: string,
    rows: Record<string, unknown>[],
    publishedRows?: Record<string, unknown>[],
  ) {
    const summary = await runCanaryChecks(pricingDb(rows, publishedRows), {
      observedAt: NOW,
      mode: "status",
    });
    return summary.results.find((result) => result.checkId === checkId);
  }

  it("grades the published priced cohort against the shared breadth share", async () => {
    const healthy = await runPricingCheck("stablecoins-active-price-coverage", stablecoinsRunRows());
    expect(healthy).toMatchObject({
      status: "ok",
      severity: "info",
      metadata: { pricedActiveCount: ACTIVE_IDS.size, expectedActiveCount: ACTIVE_IDS.size },
    });

    const breadth = Math.ceil(ACTIVE_IDS.size * 0.05);
    const degraded = await runPricingCheck("stablecoins-active-price-coverage", stablecoinsRunRows({
      pricedActiveCount: ACTIVE_IDS.size - breadth,
      missingPriceCount: breadth,
    }));
    expect(degraded).toMatchObject({ status: "degraded", severity: "warning" });
    expect(degraded?.error).toContain(`${breadth}/${ACTIVE_IDS.size} active assets are unpriced`);

    const empty = await runPricingCheck("stablecoins-active-price-coverage", stablecoinsRunRows({
      pricedActiveCount: 0,
      missingPriceCount: ACTIVE_IDS.size,
    }));
    expect(empty).toMatchObject({ status: "error", severity: "error" });
  });

  it("fails closed when the run does not report priced coverage", async () => {
    const check = await runPricingCheck("stablecoins-active-price-coverage", stablecoinsRunRows({
      includeCoverage: false,
    }));
    expect(check).toMatchObject({
      status: "error",
      executionStatus: "failed",
      executionFailureReason: "active-price-coverage-unreported",
    });
  });

  it("does not treat an aged producer row as current priced coverage", async () => {
    const check = await runPricingCheck("stablecoins-active-price-coverage", stablecoinsRunRows({
      startedAt: NOW - 3_600,
    }));
    expect(check).toMatchObject({
      status: "error",
      executionStatus: "failed",
      executionFailureReason: "sync-stablecoins-run-stale",
      metadata: { runAgeSec: 3_600, maxAgeSec: 1_800 },
    });
  });

  it("degrades when the depeg observation cohort shrinks against the previous generation", async () => {
    const stable = await runPricingCheck("depeg-observation-coverage", stablecoinsRunRows());
    expect(stable).toMatchObject({
      status: "ok",
      metadata: { observedCount: ACTIVE_IDS.size, unavailableCount: 0 },
    });

    const escalated = await runPricingCheck("depeg-observation-coverage", [
      ...stablecoinsRunRows({
        unavailableCount: 5,
        reasonCounts: { "primary-unusable": 2, "non-authoritative-reference": 3 },
      }),
      ...stablecoinsRunRows({ unavailableCount: 2, reasonCounts: { "primary-unusable": 2 }, startedAt: NOW - 960 }),
    ]);
    expect(escalated).toMatchObject({ status: "degraded", severity: "warning" });
    expect(escalated?.error).toContain("unavailable 2 -> 5");
    expect(escalated?.error).toContain("non-authoritative-reference+3");
    expect(escalated?.metadata).toMatchObject({
      baselineAvailable: true,
      unavailableDelta: 3,
      reasonDelta: { "non-authoritative-reference": 3 },
    });
  });

  it("keeps a stable depeg census ok without inventing a baseline", async () => {
    const single = await runPricingCheck("depeg-observation-coverage", stablecoinsRunRows({ unavailableCount: 2 }));
    expect(single).toMatchObject({ status: "ok", metadata: { baselineAvailable: false, unavailableCount: 2 } });
  });

  it("grades the last published generation when newer attempts did not publish", async () => {
    const publication = stablecoinsRunRows({ startedAt: NOW - 960 })[0]!;
    const skipped = {
      started_at: NOW - 60,
      status: "skipped_locked",
      metadata: JSON.stringify({ reason: "lease-locked" }),
    };
    const abandoned = {
      started_at: NOW - 300,
      status: "error",
      metadata: JSON.stringify({
        reason: "stale-slot-reconciled",
        failureCategory: "platform-abandoned",
        childDisposition: "abandoned",
      }),
    };

    for (const checkId of ["stablecoins-active-price-coverage", "depeg-observation-coverage"]) {
      const check = await runPricingCheck(checkId, [skipped, abandoned], [publication]);
      expect(check).toMatchObject({
        status: "ok",
        metadata: { runStartedAt: NOW - 960, runStatus: "ok", runAgeSec: 960 },
      });
    }
  });

  it("fails closed when no generation published inside the producer budget", async () => {
    const skipped = {
      started_at: NOW - 60,
      status: "skipped_locked",
      metadata: JSON.stringify({ reason: "lease-locked" }),
    };
    const check = await runPricingCheck("stablecoins-active-price-coverage", [skipped], []);
    expect(check).toMatchObject({
      status: "error",
      executionStatus: "failed",
      executionFailureReason: "sync-stablecoins-run-unavailable",
      metadata: { runStartedAt: NOW - 60, runStatus: "skipped_locked", runAgeSec: 60 },
    });
  });

  it("compares against the previous published census, not a newer skipped attempt", async () => {
    const current = stablecoinsRunRows({
      unavailableCount: 2,
      reasonCounts: { "primary-unusable": 2 },
      startedAt: NOW - 60,
    })[0]!;
    const skipped = {
      started_at: NOW - 120,
      status: "skipped_locked",
      metadata: JSON.stringify({ reason: "lease-locked" }),
    };
    const previous = stablecoinsRunRows({ startedAt: NOW - 960 })[0]!;

    const check = await runPricingCheck(
      "depeg-observation-coverage",
      [current, skipped],
      [current, previous],
    );
    expect(check).toMatchObject({
      status: "degraded",
      metadata: { baselineAvailable: true, unavailableDelta: 2, runStartedAt: NOW - 60 },
    });
  });

  it("reports a held or failed depeg stage instead of healthy coverage", async () => {
    const held = await runPricingCheck("depeg-observation-coverage", [{
      started_at: NOW - 60,
      status: "degraded",
      metadata: JSON.stringify({
        cacheWriteMode: "published",
        activePriceCoverage: { expectedActiveCount: ACTIVE_IDS.size, pricedActiveCount: ACTIVE_IDS.size, missingPriceCount: 0 },
        quality: {
          reason: "depeg-open-event-limit-reached",
          depegObservation: null,
          depegObservationUnavailableReason: "depeg-open-event-limit-reached",
        },
      }),
    }]);
    expect(held).toMatchObject({ status: "degraded", severity: "warning" });
    expect(held?.error).toContain("depeg-open-event-limit-reached");

    const unreported = await runPricingCheck("depeg-observation-coverage", stablecoinsRunRows({
      includeCensus: false,
    }));
    expect(unreported).toMatchObject({
      status: "error",
      executionStatus: "failed",
      executionFailureReason: "depeg-observation-unreported",
    });
  });
});
