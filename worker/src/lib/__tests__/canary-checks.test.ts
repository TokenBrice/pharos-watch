import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  pruneWorkerCanaryRuns,
  runAndPersistCanaryChecks,
  runCanaryChecks,
} from "../canary-checks";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";

const NOW = 1_775_900_000;
const EXPECTED_CANARY_CHECK_IDS = [
  "dex-liquidity-current-publication",
  "dex-liquidity-global-row",
  "blacklist-null-identity",
  "stablecoins-cache-active-count",
  "psi-latest-sample",
  "dews-latest-signal",
  "safety-score-v9-publication",
  "yield-gbp-benchmark-current",
];

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
  vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
    .mockResolvedValue(activeV9());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function gbpCanaryCacheRows(options: { freshRuns?: number; fallback?: boolean } = {}) {
  const recordDate = new Date((NOW - 24 * 3600) * 1000).toISOString().slice(0, 10);
  const benchmark = (key: "USD" | "GBP", source: string) => ({
    key,
    rate: 4.1,
    recordDate,
    fetchedAt: NOW - 60,
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
        benchmarks: {
          USD: benchmark("USD", "fred-dgs3mo"),
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
      value: JSON.stringify({ consecutiveFreshRuns: options.freshRuns ?? 2 }),
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

function healthyD1(
  dex: {
    rowCount?: number;
    latestPublishedRows?: number;
    latestGenerationPublishedRows?: number;
    retainedLegacyRows?: number;
    retainedOlderPublishedRows?: number;
    unpublishedRows?: number;
    generationCount?: number;
    stablecoinsActiveCount?: number;
    blacklistEventNullIdentityRows?: number;
    blacklistBalanceNullIdentityRows?: number;
    gbpFreshRuns?: number;
    gbpFallback?: boolean;
  } = {},
) {
  const rowCount = dex.rowCount ?? 408;
  const latestPublishedRows = dex.latestPublishedRows ?? rowCount;
  const latestGenerationPublishedRows = dex.latestGenerationPublishedRows ?? latestPublishedRows;
  const retainedLegacyRows = dex.retainedLegacyRows ?? 0;
  const retainedOlderPublishedRows = dex.retainedOlderPublishedRows ?? 0;
  const unpublishedRows = dex.unpublishedRows ?? 0;
  const generationCount = dex.generationCount ?? 1;
  const publishedDewsRows = dewsRows();
  return mockD1([
    {
      match: "FROM dex_liquidity_publication_generations",
      first: {
        generation_id: "dex-gen-1",
        current_row_count: latestPublishedRows,
        expected_row_count: latestPublishedRows,
        published_at: NOW - 30,
      },
      rows: [],
    },
    {
      match: "latest_generation_rows",
      matchBinds: ["dex-gen-1", "dex-gen-1"],
      first: {
        latest_generation_rows: latestGenerationPublishedRows,
        retained_legacy_rows: retainedLegacyRows,
        retained_older_published_rows: retainedOlderPublishedRows,
      },
      rows: [],
    },
    {
      match: "stablecoin_id = '__global__'",
      first: { current_rows: rowCount, global_rows: 1 },
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
      match: "unpublished_rows",
      first: {
        row_count: rowCount,
        unpublished_rows: unpublishedRows,
        generation_count: generationCount,
        latest_updated_at: NOW - 30,
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
        ...gbpCanaryCacheRows({ freshRuns: dex.gbpFreshRuns, fallback: dex.gbpFallback }),
      ],
    },
    {
      match: "FROM stability_index_samples",
      first: {
        stored_at: NOW - 60,
        score: 82,
        band: "STABLE",
        methodology_version: "v1",
      },
      rows: [],
    },
    {
      match: "pharos:stress-signals:published-exact",
      matchBinds: [NOW - 60],
      rows: publishedDewsRows,
    },
    {
      match: "INSERT INTO worker_canary_runs",
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
      totalChecks: 8,
      okCount: 8,
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
    vi.mocked(activeSafetyScoreSource.loadActiveSafetyScoreSource)
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
    vi.mocked(activeSafetyScoreSource.loadActiveSafetyScoreSource)
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

  it("degrades and names even one missing active stablecoin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(healthyD1({ stablecoinsActiveCount: ACTIVE_IDS.size - 1 }), {
      observedAt: NOW,
      mode: "status",
    });
    const check = summary.results.find((result) => result.checkId === "stablecoins-cache-active-count");

    expect(check).toMatchObject({
      status: "degraded",
      severity: "warning",
      metadata: expect.objectContaining({
        activeCount: ACTIVE_IDS.size - 1,
        expectedActiveCount: ACTIVE_IDS.size,
      }),
    });
    expect(check?.metadata?.missingActiveIds as string[]).toHaveLength(1);
    expect(check?.error).toContain((check?.metadata?.missingActiveIds as string[])[0]!);
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
  });

  it("accepts retained DEX rows outside the latest published generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(
      healthyD1({
        rowCount: 377,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 368,
        retainedLegacyRows: 4,
        retainedOlderPublishedRows: 5,
        generationCount: 2,
      }),
      { observedAt: NOW, mode: "status" },
    );

    const dexResult = summary.results.find((result) => result.checkId === "dex-liquidity-current-publication");

    expect(dexResult).toMatchObject({
      status: "ok",
      severity: "info",
      metadata: expect.objectContaining({
        rowCount: 377,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 368,
        retainedLegacyRows: 4,
        retainedOlderPublishedRows: 5,
      }),
    });
    expect(summary.worstStatus).toBe("ok");
  });

  it("errors when DEX rows in any generation are not published", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const summary = await runCanaryChecks(
      healthyD1({
        rowCount: 377,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 368,
        retainedLegacyRows: 4,
        retainedOlderPublishedRows: 5,
        unpublishedRows: 1,
        generationCount: 2,
      }),
      { observedAt: NOW, mode: "status" },
    );

    expect(summary.results.find((result) => result.checkId === "dex-liquidity-current-publication")).toMatchObject({
      status: "error",
      severity: "error",
      error: "1 current DEX liquidity rows are not published",
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
        retainedLegacyRows: 4,
        retainedOlderPublishedRows: 6,
        generationCount: 2,
      }),
      { observedAt: NOW, mode: "status" },
    );

    expect(summary.results.find((result) => result.checkId === "dex-liquidity-current-publication")).toMatchObject({
      status: "error",
      severity: "error",
      error: "DEX latest-generation rows 367 differ from latest published generation 368",
      metadata: expect.objectContaining({
        rowCount: 377,
        latestPublishedRows: 368,
        latestGenerationPublishedRows: 367,
      }),
    });
  });

  it("degrades noisy invariants without aborting the rest of the run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const unhealthyDewsRows = dewsRows(NOW - 60, 2);
    const db = mockD1([
      {
        match: "FROM dex_liquidity_publication_generations",
        first: {
          generation_id: "dex-gen-1",
          current_row_count: 408,
          expected_row_count: 408,
          published_at: NOW - 30,
        },
        rows: [],
      },
      {
        match: "stablecoin_id = '__global__'",
        first: { current_rows: 408, global_rows: 0 },
        rows: [],
      },
      {
        match: "unpublished_rows",
        first: { row_count: 408, unpublished_rows: 3, generation_count: 1, latest_updated_at: NOW - 30 },
        rows: [],
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          { key: "stablecoins", value: stablecoinsPayload(1), updatedAt: NOW - 60, updated_at: NOW - 60 },
          dewsPointerRow(unhealthyDewsRows),
          ...gbpCanaryCacheRows(),
        ],
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
    ]);

    const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "shadow" });

    expect(summary.worstStatus).toBe("error");
    expect(summary.errorCount).toBe(3);
    expect(summary.degradedCount).toBe(3);
    expect(summary.results.map((result) => [result.checkId, result.status])).toContainEqual([
      "dex-liquidity-current-publication",
      "error",
    ]);
  });

  it("persists latest rows idempotently and loads status summaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = healthyD1();

    await runAndPersistCanaryChecks(db, { observedAt: NOW, mode: "status" });
    await runAndPersistCanaryChecks(db, { observedAt: NOW, mode: "status" });
    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO worker_canary_runs"));
    expect(inserts).toHaveLength(16);

    const status = await loadCanaryStatus(
      mockD1([
        {
          match: "FROM worker_canary_runs",
          rows: [
            {
              check_id: "stablecoins-cache-active-count",
              status: "ok",
              severity: "info",
              observed_at: NOW,
              duration_ms: 5,
              metadata_json: JSON.stringify({
                label: "Stablecoins cache active count",
                description: "The stablecoins cache contains every active registry asset or an owned unexpired waiver.",
                activeCount: ACTIVE_IDS.size,
                mode: "status",
              }),
              error: null,
            },
            {
              check_id: "psi-latest-sample",
              status: "ok",
              severity: "info",
              observed_at: NOW,
              duration_ms: 3,
              metadata_json: JSON.stringify({
                label: "PSI latest sample",
                description: "The latest PSI sample exists.",
              }),
              error: null,
            },
          ],
        },
      ]),
      NOW + 60,
      "status",
    );

    expect(status).toMatchObject({
      checkedAt: NOW + 60,
      status: "healthy",
      latestRunAt: NOW,
      totalChecks: 2,
      okCount: 2,
      staleCount: 0,
    });
    expect(status.checks["stablecoins-cache-active-count"]).toMatchObject({
      status: "ok",
      severity: "info",
      metadata: expect.objectContaining({
        activeCount: ACTIVE_IDS.size,
        mode: "status",
      }),
    });

    const degradedStatus = await loadCanaryStatus(
      mockD1([
        {
          match: "FROM worker_canary_runs",
          rows: [
            {
              check_id: "dews-latest-signal",
              status: "error",
              severity: "error",
              observed_at: NOW,
              duration_ms: 4,
              metadata_json: JSON.stringify({
                label: "DEWS latest signal",
                description: "DEWS latest stress-signal rows exist.",
              }),
              error: "2 DEWS stress signals have out-of-range scores",
            },
          ],
        },
      ]),
      NOW + 60,
      "status",
    );
    expect(degradedStatus).toMatchObject({
      status: "degraded",
      errorCount: 1,
      staleCount: 0,
    });
  });

  it.each(["off", "shadow"] as const)(
    "returns the empty compatibility shape without querying retained rows in %s mode",
    async (mode) => {
      const db = mockD1([], { requireMatch: true });

      const status = await loadCanaryStatus(db, NOW + 60, mode);

      expect(status).toEqual({
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

  it("queries only the current authoritative canary mode", async () => {
    const db = mockD1(
      [
        {
          match: "FROM worker_canary_runs",
          rows: [],
        },
      ],
      { requireMatch: true },
    );

    await loadCanaryStatus(db, NOW + 60, "alert");

    expect(db.getHistory()[0]?.binds).toEqual([
      "alert",
      ...EXPECTED_CANARY_CHECK_IDS,
      "alert",
      ...EXPECTED_CANARY_CHECK_IDS,
    ]);
  });

  it("constrains status summaries to active canary check ids", async () => {
    const db = mockD1(
      [
        {
          match: "FROM worker_canary_runs",
          matchBinds: [
            "status",
            ...EXPECTED_CANARY_CHECK_IDS,
            "status",
            ...EXPECTED_CANARY_CHECK_IDS,
          ],
          rows: [],
        },
      ],
      { requireMatch: true },
    );

    await loadCanaryStatus(db, NOW + 60, "status");

    const query = db.getHistory()[0];
    expect(query?.sql).toContain("check_id IN");
    expect(query?.binds).not.toContain("report-card-cache-methodology");
  });

  it("prunes canary run rows older than the retention cutoff", async () => {
    const db = mockD1([
      {
        match: "DELETE FROM worker_canary_runs WHERE observed_at < ?",
        rows: [],
        runMeta: { changes: 4 },
      },
    ]);

    await expect(pruneWorkerCanaryRuns(db, NOW - 90 * 24 * 3600)).resolves.toBe(4);
    expect(db.getHistory()).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM worker_canary_runs WHERE observed_at < ?"),
        binds: [NOW - 90 * 24 * 3600],
      }),
    ]);
  });

  it("reports missing mandatory tables as canary errors without aborting sibling checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "unpublished_rows",
        throwError: new Error("D1_ERROR: no such table: dex_liquidity"),
        rows: [],
      },
      {
        match: "stablecoin_id = '__global__'",
        throwError: new Error("D1_ERROR: no such table: dex_liquidity"),
        rows: [],
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          { key: "stablecoins", value: stablecoinsPayload(), updatedAt: NOW - 60, updated_at: NOW - 60 },
          ...gbpCanaryCacheRows(),
        ],
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
    ]);

    const summary = await runCanaryChecks(db, { observedAt: NOW, mode: "status" });

    expect(summary.errorCount).toBe(4);
    expect(summary.skippedCount).toBe(0);
    expect(summary.degradedCount).toBe(1);
    expect(summary.okCount).toBe(3);
    expect(summary.worstStatus).toBe("error");
  });
});
