import { afterEach, describe, expect, it, vi } from "vitest";
import { DDR_METHODOLOGY_VERSION } from "@shared/lib/depeg-resolver-version";
import type { DdrrResponse } from "@shared/types/depeg-resolver-review";
import { DDRR_REVIEWER_VERSION } from "@shared/types/depeg-resolver-review";
import { handleDepegResolverReview } from "../depeg-resolver-review";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { DDRR_SNAPSHOT_CACHE_GENERATION } from "../../lib/depeg-resolver-review-snapshot-cache";
import { buildEmptyDdrrSummary } from "../../cron/compute-depeg-resolver-review";

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(computedAt: number, expiresAt: number): DdrrResponse {
  return {
    _meta: {
      computedAt,
      expiresAt,
      degraded: false,
      degradedReason: null,
      reviewerVersion: DDRR_REVIEWER_VERSION,
      publicWarning: "warning",
      assessedEventCount: 1,
      reviewedEventCount: 1,
      pendingEventCount: 0,
      durationScoredCount: 1,
      verdictScoredCount: 1,
      assessmentRowLimit: 20_000,
      assessmentRowsTruncated: false,
      publicRowLimit: 100,
      publicRowsTruncated: false,
      methodologyVersions: [DDR_METHODOLOGY_VERSION],
    },
    summary: {
      ...buildEmptyDdrrSummary(),
      recoveryLikelihoodCorrectCount: 1,
      recoveryLikelihoodScoredCount: 1,
      recoveryLikelihoodAccuracyPct: 1,
      durationScoredCount: 1,
      averageSignedDurationErrorSec: 3600,
      averageAbsoluteDurationErrorSec: 3600,
      correctRecoverable: 1,
      verdictScoredCount: 1,
      durationUnscoredCount: 0,
      withinIqrCount: 1,
      iqrScoredCount: 1,
      withinIqrPct: 1,
      medianAbsoluteErrorSec: 3600,
    },
    rows: [
      {
        eventId: 42,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        direction: "below",
        startedAt: computedAt - 10_000,
        assessedAt: computedAt - 5_000,
        eventAgeSec: 5_000,
        checkpoint: "first",
        methodologyVersion: DDR_METHODOLOGY_VERSION,
        resolutionTier: "recovery_likely",
        durationSuppressed: false,
        durationSuppressedReason: null,
        predictedRemainingSec: 3600,
        iqrRemainingSec: [1800, 7200],
        actualOutcome: "recovered",
        actualEndedAt: computedAt - 1400,
        actualRemainingSec: 3600,
        verdictReview: "correct_recoverable",
        durationReview: "inside_band",
        medianReview: "median_exact",
        signedErrorSec: 0,
        absoluteErrorSec: 0,
        withinIqr: true,
        horizonReviews: [],
        stratum: "below - moderate - robust - USD",
        factors: [],
        sourceEventState: "recovered",
      },
    ],
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: "v1.0",
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: "v1.0",
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: computedAt,
      isCurrent: true,
    },
  };
}

describe("handleDepegResolverReview", () => {
  it("serves stale snapshots as degraded while keeping review rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const payload = snapshot(1_998_000, 1_999_000);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "depeg-resolver-review:snapshot",
            value: JSON.stringify({
              generation: DDRR_SNAPSHOT_CACHE_GENERATION,
              methodologyVersion: DDR_METHODOLOGY_VERSION,
              reviewerVersion: DDRR_REVIEWER_VERSION,
              payload,
            }),
            updated_at: payload._meta.computedAt,
          },
        ],
      },
    ]);

    const res = await handleDepegResolverReview(db);
    const body = (await res.json()) as DdrrResponse;

    expect(res.status).toBe(200);
    expect(body._meta.degraded).toBe(true);
    expect(body._meta.degradedReason).toBe("stale-cache");
    expect(body.summary.recoveryLikelihoodAccuracyPct).toBe(1);
    expect(body.rows[0].verdictReview).toBe("correct_recoverable");
  });

  it("returns a valid degraded empty payload when no cache exists yet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const db = mockD1([{ match: "FROM cache WHERE key = ?", rows: [] }]);

    const res = await handleDepegResolverReview(db);
    const body = (await res.json()) as DdrrResponse;

    expect(res.status).toBe(200);
    expect(body._meta.degraded).toBe(true);
    expect(body._meta.degradedReason).toBe("missing-cache");
    expect(body.summary.recoveryLikelihoodScoredCount).toBe(0);
    expect(body.summary.averageSignedDurationErrorSec).toBeNull();
    expect(body.rows).toEqual([]);
  });
});
