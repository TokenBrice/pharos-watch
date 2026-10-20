import { describe, expect, it } from "vitest";
import {
  buildAcceptanceReport,
  buildCaptureQueries,
  buildInventoryTransitions,
  executeCaptureQuery,
  stratifyRuns,
  summarize,
  type AcceptanceCapture,
  type CronRow,
  type QueryCapture,
} from "../dex-liquidity-acceptance-capture";

const DAY = 86400;
const FROM = Date.parse("2026-10-01T00:00:00Z") / 1000;
const TO = FROM + 7 * DAY;

function query(rows: Record<string, unknown>[] = [], overrides: Partial<QueryCapture> = {}): QueryCapture {
  return { sql: "SELECT retained_evidence;", queriedAt: "2026-10-08T00:00:00Z", rows, rowCount: rows.length,
    limit: null, truncated: false, raw: [{ success: true, results: rows }], error: null, ...overrides };
}
function capture(queries: AcceptanceCapture["queries"], overrides: Partial<AcceptanceCapture> = {}): AcceptanceCapture {
  return { kind: "dex-liquidity-acceptance", schemaVersion: 1, capturedAt: "2026-10-08T00:00:00Z", capturedUnix: TO,
    database: "stablecoin-db", window: { from: FROM, to: TO }, queries, ...overrides };
}
function run(id: number, at: number, version = "build-a", overrides: Partial<CronRow> = {}): CronRow {
  return { id, job: "sync-dex-liquidity", started_at: at, productive: 1, worker_version: version,
    status: "ok", duration_ms: 1000, metadata: { sourceCoverage: { coinTvlStepCount150: 0, coinTvlStepCount25: 0,
      nearCoverageGuard: false, hardCoverageGuard: false, nearValueGuard: false, nearMajorCoverageGuard: false } }, ...overrides };
}

describe("DEX acceptance aggregation", () => {
  it("retains failed raw envelopes and query evidence instead of converting them to zero rows", () => {
    for (const raw of [{}, [], { success: false, results: [], error: "unavailable" },
      { result: [{ results: [] }, { success: false, results: [] }] }]) {
      const result = executeCaptureQuery("SELECT evidence;", () => JSON.stringify(raw), 2);
      expect(result).toMatchObject({ sql: "SELECT evidence;", raw, rows: null, rowCount: null, limit: 2, truncated: false });
      expect(result.error).toMatch(/d1-/);
      expect(Number.isFinite(Date.parse(result.queriedAt))).toBe(true);
    }
    expect(executeCaptureQuery("SELECT evidence;", () => { throw new Error("wrangler exited 1"); }))
      .toMatchObject({ raw: null, rows: null, rowCount: null, error: "wrangler exited 1" });
  });

  it("captures valid empty evidence and all nested results without losing truncation", () => {
    const empty = { success: true, results: [] };
    expect(executeCaptureQuery("SELECT evidence;", () => JSON.stringify({ result: empty })))
      .toMatchObject({ rows: [], rowCount: 0, error: null, truncated: false, raw: { result: empty } });
    const raw = { result: [{ success: true, results: [{ id: 1 }] }, { results: [{ id: 2 }] }] };
    expect(executeCaptureQuery("SELECT evidence;", () => JSON.stringify(raw), 2))
      .toMatchObject({ raw, rows: [{ id: 1 }, { id: 2 }], rowCount: 2, limit: 2, truncated: true, error: null });
  });
  it("uses ordinary sample median and nearest-rank p95 without converting absent values to zero", () => {
    expect(summarize([1, 4, 3, 2, null, undefined, "0", NaN])).toEqual({ n: 4, unavailable: 4, median: 2.5, p95: 4, min: 1, max: 4 });
    expect(summarize(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
    expect(summarize([undefined])).toEqual({ n: 0, unavailable: 1, median: null, p95: null, min: null, max: null });
  });

  it("rejects non-integer query clocks before constructing remote SQL", () => {
    expect(() => buildCaptureQueries(FROM + 0.5, TO, TO)).toThrow("integer");
    expect(() => buildCaptureQueries(FROM, NaN, TO)).toThrow("integer");
    expect(() => buildCaptureQueries(FROM, TO, Infinity)).toThrow("integer");
  });

  it("excludes only the first productive version-change run per job and marks an absent anchor unavailable", () => {
    const entries = stratifyRuns([
      run(1, FROM - 3600),
      run(2, FROM, "build-b", { productive: 0 }),
      run(3, FROM + 3600, "build-b"),
      run(4, FROM + 7200, "build-b"),
      run(5, FROM + 7300, "build-b", { job: "sync-dex-liquidity-stage" }),
    ]);
    expect(entries.map((entry) => [entry.run.id, entry.deployExcluded, entry.versionBaselineUnavailable])).toEqual([
      [1, false, true], [2, false, false], [3, true, false], [4, false, false], [5, false, true],
    ]);
  });

  it("never passes missing counters, guards, version anchors or a truncated read", () => {
    const missing = buildAcceptanceReport([capture({ crons: query([run(1, FROM, "build-a", { metadata: {} })]), cron_errors: query() })], FROM, TO);
    expect(missing.legacy.find((entry) => entry.target === "s150 median=0 excluding deploys")?.verdict).toBe("UNMEASURABLE");
    expect(missing.legacy.find((entry) => entry.target === "Zero guard hits")?.verdict).toBe("UNMEASURABLE");
    expect(missing.prospective.stepped[0].coinTvlStepIds150).toBeNull();
    const truncated = buildAcceptanceReport([capture({ crons: query([run(2, FROM)], { truncated: true }), previous_versions: query([run(1, FROM - 3600)]), cron_errors: query() })], FROM, TO);
    expect(truncated.prospective.queryWindowComplete.crons).toBe(false);
    expect(truncated.legacy.find((entry) => entry.target === "s150 median=0 excluding deploys")?.verdict).toBe("UNMEASURABLE");
  });

  it("does not call a failed baseline's zero step counter a stability pass", () => {
    const report = buildAcceptanceReport([capture({ previous_versions: query([run(1, FROM - 3600)]), crons: query([run(2, FROM, "build-a", { metadata: { sourceCoverage: { coinTvlStepCount150: 0, coinTvlStepCount25: 0, coinTvlStepBaselineUnavailable: true } } })]), cron_errors: query() })], FROM, TO);
    expect(report.legacy.find((entry) => entry.target === "s150 median=0 excluding deploys")).toMatchObject({ verdict: "UNMEASURABLE", evidence: { n: 0, unavailable: 1 } });
  });

  it("includes terminal guard errors even when every productive slot reports false guards", () => {
    const failed = run(3, FROM + 1800, "build-a", { productive: 0, status: "error", error: "DEX hard coverage guard rejected generation" });
    const report = buildAcceptanceReport([capture({ previous_versions: query([run(1, FROM - 3600)]), crons: query([run(2, FROM)]), cron_errors: query([failed]) })], FROM, TO);
    expect(report.legacy.find((entry) => entry.target === "Zero guard hits")).toMatchObject({ verdict: "FAIL", evidence: { terminalGuardErrors: 1 } });
    expect(report.prospective.terminalErrors.map((r) => r.id)).toEqual([3]);
  });

  it("reports partial actual D1 cost as unavailable and never substitutes provider rowsRead", () => {
    const entry = run(2, FROM, "build-a", { metadata: { rowsRead: 999999, d1Cost: { queries: 3, rowsRead: 12, rowsWritten: 2, coverage: "partial", reasons: ["first-meta-unavailable"] } } });
    const report = buildAcceptanceReport([capture({ previous_versions: query([run(1, FROM - 3600)]), crons: query([entry]), cron_errors: query() })], FROM, TO);
    expect(report.prospective.laneDistributions["sync-dex-liquidity"]).toMatchObject({ d1RowsRead: { n: 0, unavailable: 1, median: null }, d1CostEvidence: [{ runId: 2, d1Cost: { rowsRead: 12, coverage: "partial" } }] });
    expect(report.legacy.find((entry) => entry.target === "Total D1 rows_read within +25% prior trailing-week median")?.verdict).toBe("UNMEASURABLE");
  });

  it("separates missing observation from a real measured zero and refuses incomplete inventory transitions", () => {
    const generations = [{ generation_id: "a", started_at: FROM, expected_row_count: 2, state: "published" },
      { generation_id: "b", started_at: FROM + 3600, expected_row_count: 2, state: "published" },
      { generation_id: "c", started_at: FROM + 7200, expected_row_count: 2, state: "published" }];
    const rows = [
      { generation_id: "a", stablecoin_id: "missing", total_tvl_usd: 100, liquidity_score: 50, coverage_class: "primary" },
      { generation_id: "a", stablecoin_id: "zero", total_tvl_usd: 100, liquidity_score: 50, coverage_class: "primary" },
      { generation_id: "b", stablecoin_id: "missing", total_tvl_usd: 0, liquidity_score: null, coverage_class: "unobserved" },
      { generation_id: "b", stablecoin_id: "zero", total_tvl_usd: 0, liquidity_score: null, coverage_class: "primary" },
    ];
    const transitions = buildInventoryTransitions(generations, rows);
    expect(transitions[0]).toMatchObject({ status: "ok", changes: [
      { stablecoinId: "missing", kind: "observation-missing", previousTvlUsd: 100, currentTvlUsd: null },
      { stablecoinId: "zero", kind: "positive-to-zero", previousTvlUsd: 100, currentTvlUsd: 0 },
    ] });
    expect(transitions[1]).toMatchObject({ status: "unavailable", reason: "captured-generation-incomplete", changes: null });
  });

  it("keeps the global sentinel in completeness but excludes it from rated and route-bearing asset populations", () => {
    const generations = [{ generation_id: "complete", started_at: FROM, state: "published", expected_row_count: 3,
      metadata_json: JSON.stringify({ activeStablecoinCount: 2, activeMetricsCount: 2, activeScoredCount: 2 }) }];
    const rows = [
      { generation_id: "complete", stablecoin_id: "rated", updated_at: FROM, liquidity_score: 50, coverage_class: "primary", score_eligible_routes: 1 },
      { generation_id: "complete", stablecoin_id: "nr", updated_at: FROM, liquidity_score: null, coverage_class: "primary", score_eligible_routes: 0 },
      { generation_id: "complete", stablecoin_id: "__global__", updated_at: FROM, liquidity_score: null, coverage_class: null, score_eligible_routes: null },
    ];
    const report = buildAcceptanceReport([capture({ generations: query(generations), generation_rows: query(rows) })], FROM, TO);
    expect(report.prospective.coverageGenerations[0]).toMatchObject({
      complete: true, capturedRows: 3, activeCatalog: 2, observed: 2, rated: 1, routeBearing: 1,
      observedCatalogFraction: 1, ratedCatalogFraction: 0.5, routeBearingCatalogFraction: 0.5,
    });
    const missingRoute = buildAcceptanceReport([capture({ generations: query(generations),
      generation_rows: query(rows.map((row) => row.stablecoin_id === "nr" ? { ...row, score_eligible_routes: null } : row)) })], FROM, TO);
    expect(missingRoute.prospective.coverageGenerations[0]).toMatchObject({ complete: true, rated: 1, routeBearing: null });
    const incomplete = buildAcceptanceReport([capture({ generations: query(generations), generation_rows: query(rows.slice(0, 2)) })], FROM, TO);
    expect(incomplete.prospective.coverageGenerations[0]).toMatchObject({ complete: false, capturedRows: 2, rated: null, routeBearing: null });
  });

  it("counts a return at the window start using both retained pre-window observations", () => {
    const observations = [{ at: FROM - 7200, tvl: 100 }, { at: FROM - 3600, tvl: 300 }, { at: FROM, tvl: 100 }];
    const generations = observations.map(({ at }, i) => ({ generation_id: `boundary-${i}`, started_at: at, state: "published", expected_row_count: 1 }));
    const rows = observations.map(({ at, tvl }, i) => ({ generation_id: `boundary-${i}`, stablecoin_id: "small-coin",
      updated_at: at, total_tvl_usd: tvl, liquidity_score: 50, coverage_class: "primary", methodology_version: "6.93", score_eligible_routes: 1 }));
    const packet = capture({ generations: query(generations), generation_rows: query(rows, { truncated: true }) });
    const report = buildAcceptanceReport([packet], FROM, TO);
    expect(report.prospective.hourlyMaterialMoves).toHaveLength(1);
    expect(report.prospective.hourlyReturns).toHaveLength(1);
    expect(report.prospective.hourlyReturns[0]).toMatchObject({
      stablecoinId: "small-coin", firstAt: FROM - 3600, returnAt: FROM, a: 100, b: 300, returned: 100, belowOneMillion: true,
    });
    expect(report.prospective.unavailableQueries).toContainEqual(expect.objectContaining({ key: "generation_rows", truncated: true }));
  });

});
