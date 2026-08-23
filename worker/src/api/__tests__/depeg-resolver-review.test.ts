import { readJsonResponse } from "./api-request-response.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDRR_REVIEWER_VERSION,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { DDRR_REVIEWER_VERSION as DDRR_CACHE_REVIEWER_VERSION } from "@shared/types/depeg-resolver-review";
import { handleDepegResolverReview } from "../depeg-resolver-review";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { DDRR_SNAPSHOT_CACHE_GENERATION } from "../../lib/depeg-resolver-review-snapshot-cache";
import { buildEmptyDdrrSummary } from "../../lib/depeg-resolver-review-response";

afterEach(() => {
  vi.useRealTimers();
});

type LegacyDdrrCachePayload = {
  _meta: {
    computedAt: number;
    expiresAt: number;
    degraded: boolean;
    degradedReason: string | null;
    reviewerVersion: string;
    publicWarning: string;
    assessedEventCount: number;
    reviewedEventCount: number;
    pendingEventCount: number;
    durationScoredCount: number;
    verdictScoredCount: number;
    assessmentRowLimit: number;
    assessmentRowsTruncated: boolean;
    incidentRowLimit: number;
    incidentRowsTruncated: boolean;
    publicRowLimit: number;
    publicRowsTruncated: boolean;
    methodologyVersions: string[];
  };
  summary: Record<string, unknown>;
  rows: unknown[];
  methodology: Record<string, unknown>;
};

type DdrrApiTestBody = {
  _meta: {
    degraded: boolean;
    degradedReason: string | null;
    reviewerVersion: string;
  };
  summary: {
    headline: {
      recoveryLikelihoodAccuracyPct: number | null;
      recoveryLikelihoodScoredCount: number;
      meanSignedDurationErrorSec: number | null;
    };
  };
  rows: unknown[];
};

function snapshot(computedAt: number, expiresAt: number): LegacyDdrrCachePayload {
  return {
    _meta: {
      computedAt,
      expiresAt,
      degraded: false,
      degradedReason: null,
      reviewerVersion: DDRR_CACHE_REVIEWER_VERSION,
      publicWarning: "warning",
      assessedEventCount: 1,
      reviewedEventCount: 1,
      pendingEventCount: 0,
      durationScoredCount: 1,
      verdictScoredCount: 1,
      assessmentRowLimit: 20_000,
      assessmentRowsTruncated: false,
      incidentRowLimit: 20_000,
      incidentRowsTruncated: false,
      publicRowLimit: 400,
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
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: computedAt,
      isCurrent: true,
    },
  };
}

describe("handleDepegResolverReview", () => {
  it("rejects old reviewer snapshots instead of serving v1 review rows", async () => {
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
              reviewerVersion: DDRR_CACHE_REVIEWER_VERSION,
              payload,
            }),
            updated_at: payload._meta.computedAt,
          },
        ],
      },
    ]);

    const res = await handleDepegResolverReview(db);
    const body = (await readJsonResponse(res, 200)) as DdrrApiTestBody;

    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body._meta.degraded).toBe(true);
    expect(["invalid-payload", "reviewer-version-mismatch"]).toContain(body._meta.degradedReason);
    expect(body._meta.reviewerVersion).toBe(DDRR_REVIEWER_VERSION);
    expect(body.summary.headline.recoveryLikelihoodAccuracyPct).toBeNull();
    expect(body.rows).toEqual([]);
  });

  it("returns a valid degraded empty payload when no cache exists yet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const db = mockD1([{ match: "FROM cache WHERE key = ?", rows: [] }]);

    const res = await handleDepegResolverReview(db);
    const body = (await readJsonResponse(res, 200)) as DdrrApiTestBody;

    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body._meta.degraded).toBe(true);
    expect(body._meta.degradedReason).toBe("missing-cache");
    expect(body.summary.headline.recoveryLikelihoodScoredCount).toBe(0);
    expect(body.summary.headline.meanSignedDurationErrorSec).toBeNull();
    expect(body.rows).toEqual([]);
  });
});
