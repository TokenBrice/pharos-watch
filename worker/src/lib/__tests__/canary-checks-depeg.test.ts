import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  checkDdrEligibleUnsealed,
  checkDepegDetectionCensus,
  checkDepegDexSuppression,
  checkDepegOpenCoverage,
  checkDepegPendingConfirmation,
} from "../canary-checks-depeg";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  fixtures.closeAll();
});

const NOW = 1_775_900_000;

const USD_IDS = [...PSI_ELIGIBLE_META_BY_ID]
  .filter(([, meta]) => meta.flags.pegCurrency === "USD")
  .map(([id]) => id);
const NON_USD_ID = [...PSI_ELIGIBLE_META_BY_ID].find(([, meta]) => meta.flags.pegCurrency !== "USD")?.[0];

function censusJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    scope: "psi-non-nav-before-supply-floor",
    evaluatedAt: NOW - 120,
    eligibleCount: 100,
    observedCount: 98,
    unavailableCount: 2,
    belowFloorCount: 0,
    reasonCounts: { "asset-absent": 2 },
    ...overrides,
  });
}

function censusRow(overrides: Record<string, unknown> = {}) {
  return {
    started_at: NOW - 60,
    census_json: censusJson(),
    pipeline_succeeded: 1,
    unavailable_reason: null,
    ...overrides,
  };
}

describe("depeg canary checks", () => {
  it("reports a completed census as healthy and keeps the counters", async () => {
    const db = mockD1([
      { match: "pharos:depeg-census-runs", rows: [censusRow(), censusRow({ started_at: NOW - 960 })] },
    ]);

    const result = await checkDepegDetectionCensus(db, NOW);

    expect(result).toMatchObject({
      status: "ok",
      severity: "info",
      executionStatus: "completed",
      metadata: {
        eligibleCount: 100,
        observedCount: 98,
        unavailableCount: 2,
        unavailableShare: 0.02,
        maxAgeSec: CRON_INTERVALS["sync-stablecoins"] * 2,
      },
    });
  });

  it("degrades when no run completed the detection pass", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-census-runs",
        rows: [censusRow({ census_json: null, pipeline_succeeded: 0, unavailable_reason: "depeg-detection-error" })],
      },
    ]);

    const result = await checkDepegDetectionCensus(db, NOW);

    expect(result).toMatchObject({
      status: "degraded",
      error: "depeg-census-missing",
      metadata: { unavailableReason: "depeg-detection-error" },
    });
  });

  it("degrades when the newest completed census misses two producer intervals", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-census-runs",
        rows: [censusRow({ started_at: NOW - CRON_INTERVALS["sync-stablecoins"] * 2 - 60 })],
      },
    ]);

    const result = await checkDepegDetectionCensus(db, NOW);

    expect(result).toMatchObject({ status: "degraded", error: expect.stringContaining("census is") });
  });

  it("requires two consecutive material census losses instead of one noisy run", async () => {
    const lossy = censusRow({ census_json: censusJson({ unavailableCount: 20, observedCount: 80 }) });
    const healthy = censusRow({ started_at: NOW - 960 });

    const oneRun = await checkDepegDetectionCensus(
      mockD1([{ match: "pharos:depeg-census-runs", rows: [lossy, healthy] }]),
      NOW,
    );
    expect(oneRun.status).toBe("ok");

    const twoRuns = await checkDepegDetectionCensus(
      mockD1([{ match: "pharos:depeg-census-runs", rows: [lossy, { ...lossy, started_at: NOW - 960 }] }]),
      NOW,
    );
    expect(twoRuns).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("two consecutive runs"),
      metadata: { unavailableShare: 0.2, priorUnavailableShare: 0.2 },
    });
  });

  it("reports its own read failure as a failed measurement, not a producer finding", async () => {
    const db = mockD1([
      { match: "pharos:depeg-census-runs", throwError: new Error("D1_ERROR: overloaded"), rows: [] },
    ]);

    const result = await checkDepegDetectionCensus(db, NOW);

    expect(result).toMatchObject({
      status: "error",
      executionStatus: "failed",
      executionFailureReason: "canary-source-unavailable",
    });
  });

  it("projects the census from persisted cron_runs metadata", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(
      `INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata)
       VALUES ('sync-stablecoins', ?, 1000, 'ok', 400, ?)`,
    );
    insert.run(
      NOW - 60,
      JSON.stringify({
        capabilities: { stablecoinsCache: true, depegPipeline: true },
        quality: { depegObservation: JSON.parse(censusJson()) },
      }),
    );
    insert.run(
      NOW - 960,
      JSON.stringify({
        capabilities: { stablecoinsCache: true, depegPipeline: true },
        quality: { depegObservation: JSON.parse(censusJson({ unavailableCount: 0 })) },
      }),
    );

    const result = await checkDepegDetectionCensus(db, NOW);

    expect(result).toMatchObject({
      status: "ok",
      metadata: {
        runStartedAt: NOW - 60,
        eligibleCount: 100,
        observedCount: 98,
        unavailableCount: 2,
        reasonCounts: { "asset-absent": 2 },
      },
    });
  });

  it("keeps quiet when no candidate is pending", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-pending-confirmation-canary",
        first: { severe_recent: 0, stalled_count: 0, pending_count: 0, oldest_first_seen: null },
        rows: [],
      },
      { match: "pharos:depeg-pending-aged-candidates", rows: [] },
    ]);

    expect(await checkDepegPendingConfirmation(db, NOW)).toMatchObject({
      status: "ok",
      metadata: { pendingCount: 0, unconfirmedSevereRecent: 0 },
    });
  });

  it("errors when an extreme move expired without a public event", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-pending-confirmation-canary",
        first: { severe_recent: 1, stalled_count: 0, pending_count: 0, oldest_first_seen: null },
        rows: [],
      },
      { match: "pharos:depeg-pending-aged-candidates", rows: [] },
    ]);

    const result = await checkDepegPendingConfirmation(db, NOW);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("expired unconfirmed"),
      metadata: { unconfirmedSevereRecent: 1 },
    });
  });

  it("errors when a candidate outlives every dynamic expiry limit", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-pending-confirmation-canary",
        first: { severe_recent: 0, stalled_count: 2, pending_count: 2, oldest_first_seen: NOW - 20_000 },
        rows: [],
      },
      {
        match: "pharos:depeg-pending-aged-candidates",
        rows: [
          { stablecoin_id: "usdt-tether", first_seen_at: NOW - 20_000 },
          { stablecoin_id: "usdc-circle", first_seen_at: NOW - 15_000 },
        ],
      },
    ]);

    const result = await checkDepegPendingConfirmation(db, NOW);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("outlived every dynamic expiry limit"),
      metadata: {
        stalledExpiredCount: 2,
        pending: [
          { stablecoinId: "usdt-tether", ageSec: 20_000 },
          { stablecoinId: "usdc-circle", ageSec: 15_000 },
        ],
      },
    });
  });

  it("degrades when a candidate is still unresolved past the base confirmation window", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-pending-confirmation-canary",
        first: { severe_recent: 0, stalled_count: 0, pending_count: 1, oldest_first_seen: NOW - 3_000 },
        rows: [],
      },
      {
        match: "pharos:depeg-pending-aged-candidates",
        rows: [{ stablecoin_id: "usdt-tether", first_seen_at: NOW - 3_000 }],
      },
    ]);

    const result = await checkDepegPendingConfirmation(db, NOW);

    expect(result).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("past the base confirmation window"),
      metadata: { olderThanBaseExpiryCount: 1 },
    });
  });

  it("names open events whose trusted price stopped advancing", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-open-coverage-canary",
        rows: [
          {
            id: 7,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            last_trusted_price_at: NOW - 2_000,
            price_coverage_gap_started_at: NOW - 1_800,
          },
        ],
      },
    ]);

    const result = await checkDepegOpenCoverage(db, NOW);

    expect(result).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("USDT(usdt-tether)"),
      metadata: {
        blindEventCount: 1,
        events: [{ eventId: 7, stablecoinId: "usdt-tether", blindAgeSec: 1_800 }],
      },
    });
  });

  it("seals eligible DDR incidents inside the grace window", async () => {
    const db = mockD1([{ match: "pharos:ddr-eligible-unsealed-canary", rows: [] }]);

    expect(await checkDdrEligibleUnsealed(db, NOW)).toMatchObject({
      status: "ok",
      metadata: { unsealedCount: 0, graceSec: CRON_INTERVALS["compute-depeg-resolver"] * 2 },
    });
  });

  it.each([
    [NOW - 2_000, "degraded"],
    [NOW - 7 * 3600, "error"],
  ] as const)("bands an unsealed eligible incident (%i)", async (eligibleAt, status) => {
    const db = mockD1([
      {
        match: "pharos:ddr-eligible-unsealed-canary",
        rows: [{ incident_key: "incident:usdt-tether:below:1", eligible_at: eligibleAt }],
      },
    ]);

    const result = await checkDdrEligibleUnsealed(db, NOW);

    expect(result).toMatchObject({
      status,
      metadata: {
        unsealedCount: 1,
        oldestAgeSec: NOW - eligibleAt,
        incidents: [{ incidentKey: "incident:usdt-tether:below:1", ageSec: NOW - eligibleAt }],
      },
    });
  });

  it("flags a fresh DEX recovery-band suppression with two corroborating protocol groups", async () => {
    const stablecoinId = USD_IDS[0]!;
    const sources = JSON.stringify([
      { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.999, tvl: 5_000_000, observedAt: NOW - 60, aggregateObservedAt: NOW - 60 },
      { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 1.001, tvl: 4_000_000, observedAt: NOW - 60, aggregateObservedAt: NOW - 60 },
    ]);
    const db = mockD1([
      {
        match: "pharos:depeg-dex-suppression-canary",
        rows: [
          {
            stablecoin_id: stablecoinId,
            dex_price_usd: 0.999,
            primary_price_at_calc: 0.985,
            deviation_from_primary_bps: 142,
            source_total_tvl: 9_000_000,
            price_sources_json: sources,
          },
        ],
      },
    ]);

    const result = await checkDepegDexSuppression(db, NOW);

    expect(result).toMatchObject({
      status: "degraded",
      error: expect.stringContaining(stablecoinId),
      metadata: {
        suppressedCount: 1,
        suppressed: [{ stablecoinId, primaryBps: 150, dexBps: 10, protocolGroups: 2 }],
      },
    });
  });

  it("ignores a single-protocol DEX row, a stale protocol clock, and non-USD pegs", async () => {
    const singleProtocol = JSON.stringify([
      { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.999, tvl: 5_000_000, observedAt: NOW - 60, aggregateObservedAt: NOW - 60 },
    ]);
    const staleProtocol = JSON.stringify([
      { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.999, tvl: 5_000_000, observedAt: NOW - 4_000, aggregateObservedAt: NOW - 60 },
      { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 1.001, tvl: 4_000_000, observedAt: NOW - 4_000, aggregateObservedAt: NOW - 60 },
    ]);
    const row = (stablecoinId: string, priceSourcesJson: string) => ({
      stablecoin_id: stablecoinId,
      dex_price_usd: 0.999,
      primary_price_at_calc: 0.985,
      deviation_from_primary_bps: 142,
      source_total_tvl: 9_000_000,
      price_sources_json: priceSourcesJson,
    });
    const db = mockD1([
      {
        match: "pharos:depeg-dex-suppression-canary",
        rows: [
          row(USD_IDS[0]!, singleProtocol),
          row(USD_IDS[1]!, staleProtocol),
          ...(NON_USD_ID ? [row(NON_USD_ID, singleProtocol)] : []),
        ],
      },
    ]);

    const result = await checkDepegDexSuppression(db, NOW);

    expect(result).toMatchObject({ status: "ok", metadata: { suppressedCount: 0 } });
  });

  it("escalates a broad DEX suppression cohort to error", async () => {
    const sources = JSON.stringify([
      { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.999, tvl: 5_000_000, observedAt: NOW - 60, aggregateObservedAt: NOW - 60 },
      { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 1.001, tvl: 4_000_000, observedAt: NOW - 60, aggregateObservedAt: NOW - 60 },
    ]);
    const ids = USD_IDS.slice(0, 10);
    expect(ids).toHaveLength(10);
    const db = mockD1([
      {
        match: "pharos:depeg-dex-suppression-canary",
        rows: ids.map((stablecoinId) => ({
          stablecoin_id: stablecoinId,
          dex_price_usd: 0.999,
          primary_price_at_calc: 0.985,
          deviation_from_primary_bps: 142,
          source_total_tvl: 9_000_000,
          price_sources_json: sources,
        })),
      },
    ]);

    const result = await checkDepegDexSuppression(db, NOW);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("10 USD-pegged assets"),
      metadata: { suppressedCount: 10 },
    });
  });
});
