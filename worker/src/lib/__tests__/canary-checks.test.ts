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
  return JSON.stringify({
    generation: REPORT_CARD_CACHE_GENERATION,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    payload: {
      updatedAt,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      scores: {
        "usdt-tether": { score: 92, grade: "A" },
      },
    },
  });
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
  } = {},
) {
  const rowCount = dex.rowCount ?? 408;
  const latestPublishedRows = dex.latestPublishedRows ?? rowCount;
  const latestGenerationPublishedRows = dex.latestGenerationPublishedRows ?? latestPublishedRows;
  const retainedLegacyRows = dex.retainedLegacyRows ?? 0;
  const retainedOlderPublishedRows = dex.retainedOlderPublishedRows ?? 0;
  const unpublishedRows = dex.unpublishedRows ?? 0;
  const generationCount = dex.generationCount ?? 1;
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
      match: "FROM stress_signals_latest",
      first: {
        source_table: "stress_signals_latest",
        row_count: 20,
        latest_computed_at: NOW - 60,
        out_of_range_scores: 0,
      },
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
      totalChecks: 6,
      okCount: 6,
      degradedCount: 0,
      errorCount: 0,
      skippedCount: 0,
      worstStatus: "ok",
      worstSeverity: "info",
    });
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
        match: "FROM stress_signals_latest",
        first: {
          source_table: "stress_signals_latest",
          row_count: 20,
          latest_computed_at: NOW - 60,
          out_of_range_scores: 2,
        },
        rows: [],
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
    expect(inserts).toHaveLength(12);

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
    );
    expect(degradedStatus).toMatchObject({
      status: "degraded",
      errorCount: 1,
      staleCount: 0,
    });
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

    expect(summary.skippedCount).toBe(4);
    expect(summary.okCount).toBe(2);
    expect(summary.worstStatus).toBe("ok");
  });
});
