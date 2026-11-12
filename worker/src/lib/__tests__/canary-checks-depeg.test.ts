import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { PSI_HISTORICAL_PRICE_GAP_REVIEWS, STABLECOIN_PRICE_GAP_REVIEWS, type StablecoinPriceGapReview } from "../stablecoin-publication-reviews";
import {
  assessDepegObservationGaps,
  checkDdrEligibleUnsealed,
  checkDepegDetectionCensus,
  checkDepegDexSuppression,
  checkDepegOpenCoverage,
  checkDepegPendingConfirmation,
  DEPEG_BLIND_EVENT_REVIEWS,
  DepegBlindEventReviewSchema,
  resolveDepegBlindEventReviews,
} from "../canary-checks-depeg";

const fixtures = createLatestSchemaFixtureTracker();
const psi = PSI_HISTORICAL_PRICE_GAP_REVIEWS as StablecoinPriceGapReview[];
const gaps = STABLECOIN_PRICE_GAP_REVIEWS as StablecoinPriceGapReview[];
const gapCount = gaps.length;
const [review] = DEPEG_BLIND_EVENT_REVIEWS;

afterEach(() => {
  fixtures.closeAll();
  psi.length = 0;
  gaps.length = gapCount;
});

const NOW = 1_775_900_000;
const recoverySources = [
  { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.999, tvl: 5_000_000, observedAt: NOW - 60, aggregateObservedAt: NOW - 60 },
  { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 1.001, tvl: 4_000_000, observedAt: NOW - 60, aggregateObservedAt: NOW - 60 },
];

function suppressionRow(stablecoin_id: string, price_sources_json: string, candidate_count: number) {
  return { stablecoin_id, price_sources_json, candidate_count, dex_price_usd: 0.999,
    primary_price_at_calc: 0.985, deviation_from_primary_bps: 142, source_total_tvl: 9_000_000 };
}

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

function pending(first: Record<string, unknown>, rows: Record<string, unknown>[] = []) {
  return mockD1([
    { match: "pharos:depeg-pending-confirmation-canary", first, rows: [] },
    { match: "pharos:depeg-pending-aged-candidates", rows },
  ]);
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

  it.each([
    ["nominal", true, "primary-unusable", 0, {}, 0],
    ["unreviewed", false, "primary-unusable", 0, {}, 1],
    ["reviewed", false, "primary-unusable", 0, {}, 0],
    ["expired", false, "primary-unusable", 1, {}, 1],
    ["future", false, "primary-unusable", -1, {}, 1],
    ["wrong mechanism", true, "supply-unavailable", 0, {}, 1],
    ["truncated", true, "primary-unusable", 0, { unavailableIdsTruncated: true }, 1],
    ["dropped", true, "primary-unusable", 0, { unavailableIdsDropped: true }, 1],
    ["legacy", true, "primary-unusable", 0, { unavailableAssets: undefined }, 1],
    ["malformed", true, "primary-unusable", 0, { unavailableIdsDropped: "invalid" }, 1],
    ["incomplete", true, "primary-unusable", 0, { unavailableAssets: [] }, 1],
    ["psi", false, "primary-unusable", 0, {}, 0],
    ["psi empty", false, "primary-unusable", 0, {}, 1],
    ["psi active", false, "primary-unusable", 0, {}, 1],
    ["psi expired", false, "primary-unusable", 1, {}, 1],
    ["psi future", false, "primary-unusable", -1, {}, 1],
    ["psi http", false, "primary-unusable", 0, {}, 1],
    ["closure", false, "primary-unusable", 0, {}, 0],
    ["reopening wait", false, "primary-unusable", 0, {}, 0],
    ["reopened", false, "primary-unusable", 0, {}, 1],
  ] as const)("grades actionable census gaps: %s", async (kind, nominal, reason, reviewClock, overrides, actionable) => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS[0];
    const reopen = Date.UTC(2026, 10, 8, 23) / 1000;
    const market = ["closure", "reopening wait", "reopened"].includes(kind);
    const now = market ? reopen + 1_801
      : reviewClock > 0 ? review.expiresAt : reviewClock < 0 ? review.reviewedAt - 1 : review.reviewedAt + 60;
    const evaluatedAt = market ? reopen + (kind === "closure" ? -1 : kind === "reopened" ? 1_800 : 1_799) : now;
    const id = kind.startsWith("psi") ? "ust-terra"
      : market ? "audm-mento" : kind === "unreviewed" ? "unreviewed" : review.stablecoinId;
    if (kind.startsWith("psi") && kind !== "psi empty") {
      (kind === "psi active" ? gaps : psi).push({ ...review, stablecoinId: id,
        sources: kind === "psi http" ? ["http://example.com"] : review.sources });
    }
    const row = censusRow({ started_at: now - 60, census_json: censusJson({ evaluatedAt, eligibleCount: 10,
      observedCount: 9, unavailableCount: 1, reasonCounts: { [reason]: 1 }, unavailableIdsTruncated: false,
      unavailableAssets: [{ id, reason, reviewedNominalReference: nominal }], ...overrides }) });
    if (kind === "psi empty") expect(JSON.stringify(assessDepegObservationGaps(JSON.parse(row.census_json), now)))
      .toBe('{"unavailableIdsComplete":true,"acknowledgedUnavailableIds":{"reviewedNominalReference":[],"scheduledMarketClosure":[],"reviewedPriceGap":[]},"actionableUnavailableIds":["ust-terra"],"actionableReasonCounts":{"primary-unusable":1},"acknowledgedUnavailableCount":0,"actionableUnavailableCount":1}');
    const result = await checkDepegDetectionCensus(mockD1([{ match: "pharos:depeg-census-runs",
      rows: [row, { ...row, started_at: now - 960 }] }]), now);
    expect(result).toMatchObject({ status: actionable ? "degraded" : "ok", metadata: {
      unavailableCount: 1, unavailableShare: 0.1, acknowledgedUnavailableCount: 1 - actionable,
      actionableUnavailableCount: actionable, actionableUnavailableIds: "unavailableAssets" in overrides
        || "unavailableIdsTruncated" in overrides || "unavailableIdsDropped" in overrides ? null : actionable ? [id] : [],
    } });
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

  it("uses the outcome/clock index for the unconfirmed-severe lookback", async () => {
    const { sqlite } = fixtures.open();
    const plan = (
      sqlite.prepare(
        `EXPLAIN QUERY PLAN
           SELECT COUNT(*) FROM depeg_pending_outcomes
           WHERE outcome = 'unconfirmed-severe' AND outcome_at >= ?`,
      ).all(NOW - 86_400) as Array<{ detail?: string }>
    )
      .map((row) => row.detail ?? "")
      .join("\n");

    expect(plan).toContain("idx_depeg_pending_outcomes_outcome_time");
  });

  it("keeps quiet when no candidate is pending", async () => {
    const db = pending({ severe_recent: 0, stalled_count: 0, pending_count: 0, oldest_first_seen: null });

    expect(await checkDepegPendingConfirmation(db, NOW)).toMatchObject({
      status: "ok",
      metadata: { pendingCount: 0, unconfirmedSevereRecent: 0 },
    });
  });

  it("errors when an extreme move expired without a public event", async () => {
    const db = pending({ severe_recent: 1, stalled_count: 0, pending_count: 0, oldest_first_seen: null });

    const result = await checkDepegPendingConfirmation(db, NOW);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("expired unconfirmed"),
      metadata: { unconfirmedSevereRecent: 1 },
    });
  });

  it("errors when a candidate outlives every dynamic expiry limit", async () => {
    const db = pending({ severe_recent: 0, stalled_count: 2, pending_count: 2, oldest_first_seen: NOW - 20_000 }, [
      { stablecoin_id: "usdt-tether", first_seen_at: NOW - 20_000 },
      { stablecoin_id: "usdc-circle", first_seen_at: NOW - 15_000 },
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

  it.each([
    ["keeps a candidate that is legitimately inside the extended confirmation window", 3000, "large-cap", false],
    ["errors when a non-extreme candidate outlives the extended expiry limit", 9060, "large-cap", true],
    ["keeps an extreme-move candidate inside its severe expiry limit", 9600, "extreme-move", false],
  ] as const)("%s", async (_title, age, reason, expired) => {
    const db = pending({ severe_recent: 0 }, [{ stablecoin_id: "usdt-tether", first_seen_at: NOW - age, reason }]);
    expect(await checkDepegPendingConfirmation(db, NOW)).toMatchObject({
      status: expired ? "error" : "ok",
      ...(expired ? { error: expect.stringContaining("outlived every dynamic expiry limit") } : {}),
      metadata: expired ? { stalledExpiredCount: 1 } : { olderThanBaseExpiryCount: 1, stalledExpiredCount: 0 },
    });
  });

  it("names open events whose trusted price stopped advancing", async () => {
    const db = mockD1([
      { match: "pharos:depeg-census-runs", rows: [] },
      {
        match: "pharos:depeg-open-coverage-canary",
        rows: [
          {
            id: 7,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            last_trusted_price_at: NOW - 2_000,
            price_coverage_gap_started_at: NOW - 1_800,
            total_count: 1,
            acknowledged_count: 0, acknowledged_ids_json: "[]",
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

  it.each(["fresh", "stale", "future", "missing", "reviewed", "large", "cut", "omitted"])("partitions dead-band notices: %s", async (kind) => {
    const now = review.reviewedAt;
    const { db, sqlite } = fixtures.open();
    const id = kind === "reviewed" ? review.stablecoinId : "usdt-tether";
    const receipt = { eventId: review.eventId, stablecoinId: id, evidenceKind: "dex-aggregate", evaluatedAt: now,
      price: 0.992, deviationBps: -80, contributorCount: kind === "large" ? 30 : kind === "cut" ? 3 : 2, pricedTvlUsd: 2e6, publishedAt: now, aggregateObservedAt: now,
      contributors: Array.from({ length: kind === "large" ? 30 : 2 }, (_, i) => ["direct_api", "cg_onchain"][i % 2]).map((family) => ({ family, protocol: family, chain: "ethereum",
        price: 0.992, deviationBps: -80, tvlUsd: 1e6, aggregateObservedAt: now,
        observedAt: now - (kind === "stale" ? 2101 : kind === "future" ? -1 : 30) })) };
    sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, last_trusted_price_at)
      VALUES (?, ?, 'COIN', 'peggedUSD', 'below', 150, ?, 0.985, 1, ?)`).run(review.eventId, id, now - 5000, now - 2000);
    sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-stablecoins', ?, 1, 'ok', ?)")
      .run(now, JSON.stringify({ capabilities: { depegPipeline: true }, quality: { depegObservation:
        JSON.parse(censusJson({ evaluatedAt: now, deadBandNoticesOmittedCount: 1, deadBandNotices: ["missing", "omitted"].includes(kind) ? undefined : [receipt] })) } }));
    const unresolved = kind === "fresh" ? 1 : 0;
    const acknowledged = kind === "reviewed" ? 1 : 0;
    expect(await checkDepegOpenCoverage(db, now)).toMatchObject({ status: unresolved || acknowledged ? "ok" : "degraded",
      metadata: { blindEventCount: 1, unresolvedBlindEventCount: unresolved,
        actionableBlindEventCount: 1 - unresolved - acknowledged, acknowledgedBlindEventCount: acknowledged,
        unresolvedBlindEvents: unresolved ? [receipt] : [] } });
  });

  it.each(["reviewed", "unreviewed", "new-event", "expired", "future"])("grades only actionable blind events: %s", async (kind) => {
    const now = kind === "expired" ? review.expiresAt : review.reviewedAt - (kind === "future" ? 1 : 0);
    const id = kind === "unreviewed" ? "usdt-tether" : review.stablecoinId;
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, last_trusted_price_at)
      VALUES (?, ?, 'COIN', 'peggedUSD', 'below', 150, ?, 0.985, 1, ?)`).run(review.eventId + (kind === "new-event" ? 1 : 0), id, now - 5000, now - 2000);
    const acknowledged = kind === "reviewed" ? 1 : 0;
    expect(await checkDepegOpenCoverage(db, now)).toMatchObject({ status: acknowledged ? "ok" : "degraded",
      metadata: { blindEventCount: 1, acknowledgedBlindEventCount: acknowledged, actionableBlindEventCount: 1 - acknowledged,
        acknowledgedBlindEvents: acknowledged ? [expect.objectContaining({ stablecoinId: id })] : [],
        actionableBlindEvents: acknowledged ? [] : [expect.objectContaining({ stablecoinId: id })] } });
  });

  it.each([{ owner: "" }, { reason: " " }, { sources: [] }, { sources: ["http://example.com"] }, { sources: ["https://"] },
    { reviewedAt: NaN }, { stablecoinId: "unknown" }, { expiresAt: review.reviewedAt + 14 * 86400 + 1 },
  ])("ignores malformed blind reviews: %j", (overrides) => {
    expect(resolveDepegBlindEventReviews(review.reviewedAt, [{ ...review, ...overrides }]).size).toBe(0);
  });

  it("validates the blind review registry and rejects duplicates", () => {
    for (const entry of DEPEG_BLIND_EVENT_REVIEWS) {
      const at = entry.eventId === 91042 ? 1_794_515_340 : 1_794_513_840;
      expect([DepegBlindEventReviewSchema.safeParse(entry).success, entry.reviewedAt, entry.expiresAt]).toEqual([true, at, at + 604800]);
    }
    expect([...resolveDepegBlindEventReviews(review.reviewedAt).keys()]).toEqual([91042, 91040, 90793, 90786, 90748, 84563, 90804, 91037]);
    expect(resolveDepegBlindEventReviews(review.reviewedAt, [review, review]).size).toBe(0);
    expect(resolveDepegBlindEventReviews(review.reviewedAt, [review, { ...review, reason: "" }]).size).toBe(0);
  });

  it("uses the newer trusted clock when an old continuity gap survives a fresh at-par observation", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(
      `INSERT INTO depeg_events
         (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at,
          start_price, peg_reference, last_trusted_price_at, price_coverage_gap_started_at)
       VALUES ('usdt-tether', 'USDT', 'peggedUSD', 'below', 150, ?, NULL, 0.985, 1, ?, ?)`,
    ).run(NOW - 5_000, NOW - 60, NOW - 3_000);

    const result = await checkDepegOpenCoverage(db, NOW);

    expect(result).toMatchObject({
      status: "ok",
      metadata: { blindEventCount: 0, events: [] },
    });
  });

  it("exempts frozen coins, whose open rows are preserved history", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(
      `INSERT INTO depeg_events
         (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at,
          start_price, peg_reference, last_trusted_price_at, price_coverage_gap_started_at)
       VALUES (?, ?, 'peggedUSD', 'below', 150, ?, NULL, 0.985, 1, ?, NULL)`,
    );
    const [frozenId] = [...FROZEN_IDS];
    insert.run(frozenId, "FRZ", NOW - 90_000, NOW - 80_000);
    insert.run("live-coin", "LIVE", NOW - 5_000, NOW - 2_000);

    const result = await checkDepegOpenCoverage(db, NOW);

    expect(result).toMatchObject({
      status: "degraded",
      metadata: { blindEventCount: 1, events: [{ stablecoinId: "live-coin" }] },
    });
    expect((result.metadata as { events: unknown[] }).events).toHaveLength(1);
  });

  it("reports the full blind cohort while capping the event detail list", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(
      `INSERT INTO depeg_events
         (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at,
          start_price, peg_reference, last_trusted_price_at, price_coverage_gap_started_at)
       VALUES (?, ?, ?, 'peggedUSD', 'below', 150, ?, NULL, 0.985, 1, ?, NULL)`,
    );
    for (let index = 0; index < 30; index++) {
      insert.run(review.eventId + index, index < 2 ? review.stablecoinId : `coin-${index}`, `C${index}`, NOW - 5_000 - index, NOW - 2_000 - index);
    }

    const result = await checkDepegOpenCoverage(db, review.reviewedAt);

    expect(result).toMatchObject({
      status: "degraded",
      metadata: { blindEventCount: 30, acknowledgedBlindEventCount: 1, actionableBlindEventCount: 29,
        acknowledgedBlindReviewIds: [review.eventId], acknowledgedBlindEventsTruncated: true },
    });
    expect(JSON.stringify(result.metadata).length).toBeLessThan(3500);
    expect((result.metadata as { events: unknown[] }).events).toHaveLength(10);
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
        rows: [{ incident_key: "incident:usdt-tether:below:1", eligible_at: eligibleAt, total_count: 1 }],
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

  it("excludes health-deferred and repair-quarantined DDR incidents from the unsealed cohort", async () => {
    const { db, sqlite } = fixtures.open();
    const insertEvent = sqlite.prepare(
      `INSERT INTO depeg_events
         (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at,
          start_price, peak_price, peg_reference, source)
       VALUES (?, ?, 'peggedUSD', 'below', 150, ?, NULL, 0.985, 0.985, 1, 'live')`,
    );
    const insertIncidentLink = sqlite.prepare(
      `INSERT INTO depeg_resolver_incident_event_links
         (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
       VALUES (?, ?, 'observed', NULL, ?, 'fixture')`,
    );
    const insertIncident = sqlite.prepare(
      `INSERT INTO depeg_resolver_incidents
         (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
          first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
          superseded_by_incident_key, source_fingerprint, created_at, updated_at)
       VALUES (?, ?, 'USD', 'below', ?, ?, ?, ?, 150, 'active', NULL, ?, ?, ?)`,
    );
    const insertMembership = sqlite.prepare(
      `INSERT INTO depeg_resolver_incident_policy_membership
         (incident_key, stablecoin_id, prediction_policy_version, public_tracked_at_first_seen,
          psi_shadow_at_first_seen, rollout_active_at_enablement, policy_universe_included,
          policy_universe_reason, registry_snapshot_json, created_at)
       VALUES (?, ?, 'fixture-v1', 1, 0, 1, 1, 'post_effective_public_tracked', '{}', ?)`,
    );
    const insertLockState = sqlite.prepare(
      `INSERT INTO depeg_resolver_prediction_lock_state
         (incident_key, event_id, prediction_policy_version, eligible_at, deferral_count, last_state, created_at, updated_at)
       VALUES (?, ?, 'fixture-v1', ?, 0, ?, ?, ?)`,
    );
    const insertRepairTask = sqlite.prepare(
      `INSERT INTO worker_repair_tasks
         (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
       VALUES (?, 'ddr-repair-required-event', ?, 50, 'open', 0, '{}', ?, ?)`,
    );
    const eligibleAt = NOW - 2_000;
    const fixturesForIncident = [
      { suffix: "a", lastState: "pending_lock", repaired: false, expected: true },
      { suffix: "b", lastState: "lock_deferred", repaired: false, expected: false },
      { suffix: "c", lastState: "pending_lock", repaired: true, expected: false },
    ];
    for (const fixture of fixturesForIncident) {
      const incidentKey = `ddr2:${fixture.suffix.repeat(32)}`;
      const eventId = Number(
        insertEvent.run(`coin-${fixture.suffix}`, `C${fixture.suffix}`, NOW - 5_000).lastInsertRowid,
      );
      insertIncidentLink.run(incidentKey, eventId, NOW - 5_000);
      insertIncident.run(
        incidentKey,
        `coin-${fixture.suffix}`,
        eventId,
        eventId,
        NOW - 5_000,
        NOW - 5_000,
        `${fixture.suffix.repeat(64)}`,
        NOW - 5_000,
        NOW - 5_000,
      );
      insertMembership.run(incidentKey, `coin-${fixture.suffix}`, NOW - 5_000);
      insertLockState.run(incidentKey, eventId, eligibleAt, fixture.lastState, NOW - 5_000, NOW - 2_000);
      if (fixture.repaired) {
        insertRepairTask.run(`repair:${eventId}`, String(eventId), NOW - 1_000, NOW - 1_000);
      }
    }

    const result = await checkDdrEligibleUnsealed(db, NOW);

    expect(result).toMatchObject({
      status: "degraded",
      metadata: { unsealedCount: 1, incidents: [{ incidentKey: `ddr2:${"a".repeat(32)}` }] },
    });
  });

  it.each([false, true])("flags a fresh DEX recovery-band suppression with two corroborating protocol groups (envelope=%s)", async (envelope) => {
    const stablecoinId = USD_IDS[0]!;
    const sources = JSON.stringify(envelope ? { aggregateObservedAt: NOW - 60, sources: recoverySources } : recoverySources);
    const db = mockD1([
      {
        match: "pharos:depeg-dex-suppression-canary",
        rows: [suppressionRow(stablecoinId, sources, 1)],
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
    const singleProtocol = JSON.stringify(recoverySources.slice(0, 1));
    const staleProtocol = JSON.stringify(recoverySources.map((source) => ({ ...source, observedAt: NOW - 4_000 })));
    const db = mockD1([
      {
        match: "pharos:depeg-dex-suppression-canary",
        rows: [
          suppressionRow(USD_IDS[0]!, singleProtocol, 5),
          suppressionRow(USD_IDS[1]!, staleProtocol, 5),
          suppressionRow(USD_IDS[2]!, JSON.stringify({ aggregateObservedAt: NOW, sources: [] }), 5),
          suppressionRow(USD_IDS[3]!, "{}", 5),
          ...(NON_USD_ID ? [suppressionRow(NON_USD_ID, singleProtocol, 5)] : []),
        ],
      },
    ]);

    const result = await checkDepegDexSuppression(db, NOW);

    expect(result).toMatchObject({ status: "ok", metadata: { suppressedCount: 0 } });
  });

  it("escalates a broad DEX suppression cohort to error", async () => {
    const sources = JSON.stringify(recoverySources);
    const ids = USD_IDS.slice(0, 10);
    expect(ids).toHaveLength(10);
    const db = mockD1([
      {
        match: "pharos:depeg-dex-suppression-canary",
        rows: ids.map((id) => suppressionRow(id, sources, ids.length)),
      },
    ]);

    const result = await checkDepegDexSuppression(db, NOW);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("10 USD-pegged assets"),
      metadata: { suppressedCount: 10 },
    });
  });

  it("names a saturated DEX suppression cohort as a lower bound", async () => {
    const sources = JSON.stringify(recoverySources);
    const ids = USD_IDS.slice(0, 50);
    expect(ids).toHaveLength(50);
    const db = mockD1([
      {
        match: "pharos:depeg-dex-suppression-canary",
        rows: ids.map((id) => suppressionRow(id, sources, 60)),
      },
    ]);

    const result = await checkDepegDexSuppression(db, NOW);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("at least 50 USD-pegged assets"),
      metadata: {
        suppressedCount: 50,
        suppressedCountIsLowerBound: true,
        candidateCount: 60,
      },
    });
  });
});
