import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import * as activeSafetyScoreSource from "../safety-score-active-source";
import {
  WORKER_CANARY_RUN_RETENTION_SEC,
  loadCanaryStatus,
  normalizeWorkerCanaryMode,
  pruneWorkerCanaryRuns,
  runAndPersistCanaryChecks,
  runCanaryChecks,
} from "../canary-checks";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();

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
  "yield-usd-benchmark-current",
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
      value: options.streakValue ?? JSON.stringify({ consecutiveFreshRuns: options.freshRuns ?? 2 }),
      updatedAt: NOW - 60,
      updated_at: NOW - 60,
    },
    {
      key: "fetch-tbill-rate:usd-fresh-streak",
      value: options.streakValue ?? JSON.stringify({ consecutiveFreshRuns: options.freshRuns ?? 2 }),
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
    unpublishedRows?: number;
    generationCount?: number;
    globalRows?: number;
    stablecoinsActiveCount?: number;
    blacklistEventNullIdentityRows?: number;
    blacklistBalanceNullIdentityRows?: number;
    gbpFreshRuns?: number;
    gbpFallback?: boolean;
    usdRecordDateMissing?: boolean;
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
      totalChecks: 9,

      okCount: 9,
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

  it("errors when DEX rows in any generation are not published", async () => {
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
    const db = mockD1([], { requireMatch: false });
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
      const db = mockD1([], { requireMatch: true });

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


  it("prunes canary run rows older than the 14-day retention cutoff", async () => {
    const db = mockD1([
      {
        match: "DELETE FROM worker_canary_runs",
        rows: [],
        runMeta: { changes: 4 },
      },
    ]);
    const cutoff = NOW - WORKER_CANARY_RUN_RETENTION_SEC;

    expect(WORKER_CANARY_RUN_RETENTION_SEC).toBe(14 * 24 * 3600);
    await expect(pruneWorkerCanaryRuns(db, cutoff)).resolves.toEqual({
      deleted: 4,
      truncated: false,
    });
    expect(db.getHistory()).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM worker_canary_runs"),
        binds: [cutoff, 5_000],
      }),
    ]);
  });

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
    expect(summary.okCount).toBe(4);
    expect(summary.worstStatus).toBe("error");
  });
});
