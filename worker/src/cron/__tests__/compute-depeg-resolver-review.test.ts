import { describe, expect, it, vi, afterEach } from "vitest";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/depeg-resolver-version";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  buildDepegResolverReviewSnapshot,
  computeAndStoreDepegResolverReview,
} from "../compute-depeg-resolver-review";

afterEach(() => {
  vi.useRealTimers();
});

const STARTED_AT = 1_000_000;
const ASSESSED_AT = 1_010_000;

function assessmentRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 42,
    stablecoin_id: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    peg_currency: "USD",
    governance: "decentralized",
    direction: "below",
    started_at: STARTED_AT,
    assessed_at: ASSESSED_AT,
    event_age_sec: ASSESSED_AT - STARTED_AT,
    checkpoint: "first",
    methodology_version: DDR_METHODOLOGY_VERSION,
    resolution_tier: "recovery_likely",
    duration_suppressed: 0,
    duration_suppressed_reason: null,
    median_remaining_sec: 3_600,
    iqr_low_remaining_sec: 1_800,
    iqr_high_remaining_sec: 7_200,
    stratum: "below - moderate - robust - USD",
    horizons_json: JSON.stringify([
      {
        horizon: "6h",
        state: "benchmarked",
        probability: 0.55,
        probabilityDisplay: "50-60%",
        probabilityInterval: { lower: 0.5, upper: 0.6 },
        rawAtRisk: 20,
        uniqueCoins: 12,
        intervalClosures: 11,
        intervalNonClosures: 9,
      },
    ]),
    factors_json: JSON.stringify([]),
    ...overrides,
  };
}

describe("buildDepegResolverReviewSnapshot", () => {
  it("reviews stored DDR assessments against actual depeg event outcomes", async () => {
    const db = mockD1([
      { match: "FROM depeg_resolver_assessments", rows: [assessmentRow()] },
      {
        match: "FROM depeg_events",
        rows: [
          {
            id: 42,
            stablecoin_id: "lusd-liquity",
            started_at: STARTED_AT,
            ended_at: ASSESSED_AT + 7_200,
            recovery_price: 1,
          },
        ],
      },
    ]);

    const snapshot = await buildDepegResolverReviewSnapshot(db, ASSESSED_AT + 8_000);

    expect(snapshot.methodology.version).toBe(DDR_METHODOLOGY_VERSION);
    expect(snapshot.methodology.versionLabel).toBe(DDR_METHODOLOGY_VERSION_LABEL);
    expect(snapshot._meta.assessedEventCount).toBe(1);
    expect(snapshot._meta.reviewedEventCount).toBe(1);
    expect(snapshot.summary.recoveryLikelihoodAccuracyPct).toBe(1);
    expect(snapshot.summary.averageSignedDurationErrorSec).toBe(3_600);
    expect(snapshot.summary.averageAbsoluteDurationErrorSec).toBe(3_600);
    expect(snapshot.rows[0]).toMatchObject({
      eventId: 42,
      actualOutcome: "recovered",
      verdictReview: "correct_recoverable",
      durationReview: "inside_band",
      signedErrorSec: 3_600,
      withinIqr: true,
    });
  });

  it("marks missing source events as data issues without dropping the assessment", async () => {
    const db = mockD1([
      { match: "FROM depeg_resolver_assessments", rows: [assessmentRow()] },
      { match: "FROM depeg_events", rows: [] },
    ]);

    const snapshot = await buildDepegResolverReviewSnapshot(db, ASSESSED_AT + 8_000);

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].actualOutcome).toBe("source_event_missing");
    expect(snapshot.rows[0].verdictReview).toBe("data_issue");
    expect(snapshot.summary.dataIssue).toBe(1);
    expect(snapshot.summary.recoveryLikelihoodScoredCount).toBe(0);
  });

  it("keeps headline stats complete while capping public review rows", async () => {
    const assessmentRows = Array.from({ length: 101 }, (_, index) =>
      assessmentRow({
        event_id: index + 1,
        started_at: STARTED_AT - index,
      }),
    );
    const eventRows = assessmentRows.map((row) => ({
      id: row.event_id,
      stablecoin_id: row.stablecoin_id,
      started_at: row.started_at,
      ended_at: ASSESSED_AT + 7_200,
      recovery_price: 1,
    }));
    const db = mockD1([
      { match: "FROM depeg_resolver_assessments", rows: assessmentRows },
      { match: "FROM depeg_events", rows: eventRows },
    ]);

    const snapshot = await buildDepegResolverReviewSnapshot(db, ASSESSED_AT + 8_000);

    expect(snapshot._meta.reviewedEventCount).toBe(101);
    expect(snapshot._meta.publicRowLimit).toBe(100);
    expect(snapshot._meta.publicRowsTruncated).toBe(true);
    expect(snapshot.rows).toHaveLength(100);
    expect(snapshot.summary.recoveryLikelihoodScoredCount).toBe(101);
  });

  it("stores a cache snapshot with headline DDRR stats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((ASSESSED_AT + 8_000) * 1000);
    const db = mockD1([
      { match: "FROM depeg_resolver_assessments", rows: [assessmentRow()] },
      {
        match: "FROM depeg_events",
        rows: [
          {
            id: 42,
            stablecoin_id: "lusd-liquity",
            started_at: STARTED_AT,
            ended_at: ASSESSED_AT + 7_200,
            recovery_price: 1,
          },
        ],
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    const result = await computeAndStoreDepegResolverReview(db);
    const cacheWrite = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));

    expect(result.itemCount).toBe(1);
    expect(cacheWrite?.binds[0]).toBe("depeg-resolver-review:snapshot");
    expect(JSON.parse(cacheWrite?.binds[1] as string).payload.summary).toMatchObject({
      recoveryLikelihoodAccuracyPct: 1,
      averageSignedDurationErrorSec: 3_600,
    });
  });
});
