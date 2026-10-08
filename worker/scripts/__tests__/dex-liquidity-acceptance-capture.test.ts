import { describe, expect, it } from "vitest";
import {
  buildAcceptanceReport,
  buildCaptureQueries,
  buildInventoryTransitions,
  findHourlyReturns,
  isProspectiveMaterialMove,
  mergeCronRuns,
  parseTime,
  renderAcceptanceMarkdown,
  stratifyRuns,
  summarize,
  type AcceptanceCapture,
  type CronRow,
  type Move,
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
function move(at: number, prior: number, current: number, overrides: Partial<Move> = {}): Move {
  return { stablecoinId: "small-coin", at, previousTvlUsd: prior, currentTvlUsd: current,
    method: "6.93", build: "build-a", runId: at, basis: "top-five-lower-bound", detail: {}, ...overrides };
}

describe("DEX acceptance aggregation", () => {
  it("uses ordinary sample median and nearest-rank p95 without converting absent values to zero", () => {
    expect(summarize([1, 4, 3, 2, null, undefined, "0", NaN])).toEqual({ n: 4, unavailable: 4, median: 2.5, p95: 4, min: 1, max: 4 });
    expect(summarize(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
    expect(summarize([undefined])).toEqual({ n: 0, unavailable: 1, median: null, p95: null, min: null, max: null });
  });

  it("accepts UTC dates and explicit ISO offsets without accepting an ambiguous local-time clock", () => {
    expect(parseTime("2026-10-01", 0)).toBe(FROM);
    expect(parseTime("2026-10-01T02:00:00+02:00", 0)).toBe(FROM);
    expect(parseTime("2026-10-01T00:00:00.500Z", 0)).toBe(FROM);
    expect(parseTime(undefined, FROM)).toBe(FROM);
    expect(() => parseTime("2026-10-01T00:00:00", 0)).toThrow("timezone-qualified");
    expect(() => parseTime(`2026-10-01T${"0".repeat(10000)}Z`, 0)).toThrow("Invalid time");
  });

  it("rejects non-integer query clocks before constructing remote SQL", () => {
    expect(() => buildCaptureQueries(FROM + 0.5, TO, TO)).toThrow("integer");
    expect(() => buildCaptureQueries(FROM, NaN, TO)).toThrow("integer");
    expect(() => buildCaptureQueries(FROM, TO, Infinity)).toThrow("integer");
  });

  it("deduplicates overlapping captures by invocation ID and retains the latest terminal evidence", () => {
    const early = capture({ crons: query([run(1, FROM, "build-a", { status: "running", productive: 0 })]) }, { capturedUnix: TO - DAY });
    const final = capture({ crons: query([run(1, FROM), run(2, FROM + 3600)]) });
    const merged = mergeCronRuns([final, early]);
    expect(merged.map((r) => [r.id, r.status, r.productive])).toEqual([[1, "ok", 1], [2, "ok", 1]]);
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

  it("retains below-$1M hourly returns and deploy boundaries, but rejects a direction reversal that does not return to A", () => {
    const returns = findHourlyReturns([
      move(FROM, 300000, 5000000),
      move(FROM + 3600, 5000000, 299000, { build: "build-b" }),
      move(FROM, 335000, 83673000, { stablecoinId: "not-a-return" }),
      move(FROM + 3600, 83673000, 10781000, { stablecoinId: "not-a-return" }),
      move(FROM, 500000, 17000000, { stablecoinId: "stale-return" }),
      move(FROM + 7 * 3600, 17000000, 500000, { stablecoinId: "stale-return" }),
    ]);
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ stablecoinId: "small-coin", belowOneMillion: true, a: 300000, returned: 299000, buildBoundary: true });
    expect(findHourlyReturns([move(FROM, 100, 1000, { build: null }), move(FROM + 3600, 1000, 100, { build: null })])[0].buildBoundary).toBeNull();
  });

  it("requires continuity at B instead of bridging unrelated censored top-five samples", () => {
    expect(findHourlyReturns([move(FROM, 100, 1000), move(FROM + 3600, 800, 100)])).toEqual([]);
    expect(isProspectiveMaterialMove(100, 125)).toBe(true);
    expect(isProspectiveMaterialMove(100, 80)).toBe(true);
    expect(isProspectiveMaterialMove(100000000, 101000000)).toBe(true);
    expect(isProspectiveMaterialMove(100, 124)).toBe(false);
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

  it("keeps deploy-slot steps in the event ledger while excluding them from clean distributions", () => {
    const step = run(2, FROM, "build-b", { metadata: { sourceCoverage: { coinTvlStepCount150: 9, coinTvlStepCount25: 9, coinTvlStepIds150: ["tiny"], coinTvlStepIds150Omitted: 8, coinTvlStepIds25: ["tiny"], coinTvlStepIds25Omitted: 8 } } });
    const report = buildAcceptanceReport([capture({ previous_versions: query([run(1, FROM - 3600)]), crons: query([step, run(3, FROM + 3600, "build-b")]), cron_errors: query() })], FROM, TO);
    const median = report.legacy.find((entry) => entry.target === "s150 median=0 excluding deploys");
    expect(median).toMatchObject({ verdict: "PASS", evidence: { n: 1, median: 0 } });
    expect(report.prospective.stepped[0]).toMatchObject({ runId: 2, deployExcluded: true, coinTvlStepIds150: ["tiny"], coinTvlStepIds150Omitted: 8 });
    expect(report.prospective.unexplainedMaterialMoves).toContainEqual(expect.objectContaining({ stablecoinId: "tiny", runId: 2 }));
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

  it("keeps daily day0 endpoints and eligible coin-day denominators separate from below-$1M moves", () => {
    const history = Array.from({ length: 8 }, (_, i) => [
      { stablecoin_id: "large", snapshot_date: FROM + i * DAY, total_tvl_usd: i === 0 ? 2000000 : i === 7 ? 8000000 : 4000000, methodology_version: "6.93", liquidity_score: 50, coverage_class: "primary" },
      { stablecoin_id: "small", snapshot_date: FROM + i * DAY, total_tvl_usd: i === 1 ? 3000000 : 500000, methodology_version: "6.93", liquidity_score: 50, coverage_class: "primary" },
    ]).flat();
    const flips = [{ sid: "large", d0: FROM, t0: 2000000, t1: 4000000 }, { sid: "large", d0: TO - DAY, t0: 4000000, t1: 8000000 }];
    const report = buildAcceptanceReport([capture({ history: query(history), pinned_flips: query(flips) })], FROM, TO);
    expect(report.prospective.daily).toMatchObject({ eligiblePairCoinDays: 7, eligibleCoins: 1, pairDates: 7, flips150: flips, flipsPer100EligiblePairDays: 2 / 7 * 100 });
    expect(report.prospective.queryWindowComplete.daily).toBe(true);
    expect(report.legacy[0].verdict).toBe("UNMEASURABLE"); // Counts qualify; exact root causes do not exist in the packet.
    expect(renderAcceptanceMarkdown(report)).toContain("≤4 daily flip coin-days/week; all attributed");
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

  it("deduplicates generation moves against top-five evidence and preserves manifest catalog/rated coverage", () => {
    const generations = [0, 1, 2].map((i) => ({ generation_id: `g${i}`, started_at: FROM + i * 3600, state: "published", expected_row_count: 1,
      metadata_json: JSON.stringify({ methodologyVersion: "6.93", activeStablecoinCount: 2, activeMetricsCount: 1, activeScoredCount: 1 }) }));
    const rows = [100000, 5000000, 100000].map((tvl, i) => ({ generation_id: `g${i}`, stablecoin_id: "small-coin", updated_at: FROM + i * 3600,
      total_tvl_usd: tvl, liquidity_score: 50, coverage_class: "primary", methodology_version: "6.93", score_eligible_routes: 1 }));
    const runs = [1, 2].map((i) => run(i + 1, FROM + i * 3600 + 400, "build-a", { metadata: { persistence: { generationId: `g${i}` }, sourceCoverage: {
      coinTvlStepCount150: 1, coinTvlStepCount25: 1, coinTvlStepTop: [{ stablecoinId: "small-coin", previousTvlUsd: i === 1 ? 100000 : 5000000, currentTvlUsd: i === 1 ? 5000000 : 100000 }] } } }));
    const report = buildAcceptanceReport([capture({ previous_versions: query([run(1, FROM - 3600)]), crons: query(runs), generations: query(generations), generation_rows: query(rows) })], FROM, TO);
    expect(report.prospective.hourlyMaterialMoves).toHaveLength(2);
    expect(report.prospective.hourlyReturns).toHaveLength(1);
    expect(report.prospective.coverageGenerations[0]).toMatchObject({ activeCatalog: 2, observed: 1, rated: 1, routeBearing: 1, observedCatalogFraction: 0.5, ratedCatalogFraction: 0.5 });
    expect(report.prospective.cohorts["sync-dex-liquidity|6.93|build-a"]).toMatchObject({ n: 2 });
  });
});
