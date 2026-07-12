import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  loadCanaryStatus,
  normalizeWorkerCanaryMode,
  pruneWorkerCanaryRuns,
  runAndPersistCanaryChecks,
  runCanaryChecks,
} from "../canary-checks";
import { REPORT_CARD_CACHE_GENERATION } from "../report-card-cache";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";

const NOW = 1_775_900_000;

afterEach(() => {
  vi.useRealTimers();
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

function reportCardPayload(updatedAt = NOW - 60) {
  const scoreIds = [...ACTIVE_IDS].sort();
  const publicationGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
  return JSON.stringify({
    generation: REPORT_CARD_CACHE_GENERATION,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    payload: {
      updatedAt,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publicationGenerationId,
      completeness: {
        generationId: publicationGenerationId,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        expectedCount: scoreIds.length,
        scoredCount: scoreIds.length,
        notRatedCount: 0,
        notRatedIds: [],
      },
      scores: Object.fromEntries(scoreIds.map((id) => [id, { score: 92, grade: "A" }])),
    },
  });
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
        { key: "report_card_cache", value: reportCardPayload(), updatedAt: NOW - 60, updated_at: NOW - 60 },
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
      totalChecks: 7,
      okCount: 7,
      degradedCount: 0,
      errorCount: 0,
      skippedCount: 0,
      worstStatus: "ok",
      worstSeverity: "info",
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
    const summary = await runCanaryChecks(
      healthyD1({ stablecoinsActiveCount: ACTIVE_IDS.size - 1 }),
      { observedAt: NOW, mode: "status" },
    );
    const check = summary.results.find((result) => result.checkId === "stablecoins-cache-active-count");

    expect(check).toMatchObject({
      status: "degraded",
      severity: "warning",
      metadata: expect.objectContaining({
        activeCount: ACTIVE_IDS.size - 1,
        expectedActiveCount: ACTIVE_IDS.size,
      }),
    });
    expect((check?.metadata?.missingActiveIds as string[])).toHaveLength(1);
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
          { key: "report_card_cache", value: reportCardPayload(), updatedAt: NOW - 60, updated_at: NOW - 60 },
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
    expect(summary.errorCount).toBe(2);
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
    expect(inserts).toHaveLength(14);

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
    const db = mockD1([{
      match: "FROM worker_canary_runs",
      rows: [],
    }], { requireMatch: true });

    await loadCanaryStatus(db, NOW + 60, "alert");

    expect(db.getHistory()[0]?.binds).toEqual(["alert", "alert"]);
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

  it("skips rollout-missing tables without throwing the whole canary run", async () => {
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
          { key: "report_card_cache", value: reportCardPayload(), updatedAt: NOW - 60, updated_at: NOW - 60 },
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

    expect(summary.skippedCount).toBe(3);
    expect(summary.degradedCount).toBe(1);
    expect(summary.okCount).toBe(3);
    expect(summary.worstStatus).toBe("degraded");
  });
});
