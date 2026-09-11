// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DdrTrackRecordSection } from "@/components/stablecoin-detail/ddr-track-record-section";
import { DDRR_PUBLIC_WARNING, type DdrrResponse, type DdrrRow } from "@shared/types/depeg-resolver-review";

const { useDepegResolverReviewMock, resolverEnabledMock, reviewerEnabledMock } = vi.hoisted(() => ({
  useDepegResolverReviewMock: vi.fn(),
  resolverEnabledMock: vi.fn(() => true),
  reviewerEnabledMock: vi.fn(() => true),
}));

vi.mock("@/hooks/api-hooks", () => ({ useDepegResolverReview: useDepegResolverReviewMock }));
vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverEnabled: resolverEnabledMock,
  isDepegResolverReviewerEnabled: reviewerEnabledMock,
}));

afterEach(() => {
  vi.clearAllMocks();
  resolverEnabledMock.mockReturnValue(true);
  reviewerEnabledMock.mockReturnValue(true);
});

const COIN = "lusd-liquity";

const BASE_ROW = {
  eventId: 1,
  currentEventId: 1,
  incidentKey: `${COIN}:below:1`,
  stablecoinId: COIN,
  symbol: "LUSD",
  name: "Liquity USD",
  pegCurrency: "USD",
  governance: "decentralized",
  direction: "below",
  startedAt: 1_700_000_000,
  eligibleAt: 1_700_000_600,
  sourceEventState: "recovered",
  terminalEvidenceAt: null,
  terminalEvidenceInterval: null,
  terminalEvidencePrecision: null,
} as const;

// One coherent scenario: the locked review forecast 1h of remaining depeg and
// the incident actually ran 2h past the lock. 2h is the IQR upper bound, so
// this is the inside-band boundary case, and every dependent duration field
// below is derived from those two numbers instead of stated independently.
const LOCKED_AT = 1_700_000_900;
const IQR_REMAINING_SEC = [1_800, 7_200] as const;
const PREDICTED_REMAINING_SEC = 3_600;
const ACTUAL_REMAINING_SEC = IQR_REMAINING_SEC[1];
const ACTUAL_ENDED_AT = LOCKED_AT + ACTUAL_REMAINING_SEC;
const SIGNED_DURATION_ERROR_SEC = PREDICTED_REMAINING_SEC - ACTUAL_REMAINING_SEC;

const PREDICTION_ROW = {
  ...BASE_ROW,
  kind: "prediction_review",
  predictionState: "frozen",
  publicPredictionId: 7,
  assessmentId: 9,
  predictionMethodologyVersion: "4.0",
  predictionPolicyVersion: "sticky-24h-v1",
  lockedAt: LOCKED_AT,
  publishedAt: LOCKED_AT + 100,
  publicationSnapshotToken: "snapshot-1",
  frozen: {
    resolutionTier: "recovery_likely",
    predictedRemainingSec: PREDICTED_REMAINING_SEC,
    iqrRemainingSec: [...IQR_REMAINING_SEC],
    horizonCells: [],
    stratum: null,
    factors: [],
  },
  actual: {
    kind: "recovered",
    actualEndedAt: ACTUAL_ENDED_AT,
    actualRemainingSec: ACTUAL_REMAINING_SEC,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    reviewedAt: ACTUAL_ENDED_AT + 100,
  },
  verdictReview: "correct_recoverable",
  durationReview: "inside_band",
  horizonReviews: [],
  predictedRemainingSec: PREDICTED_REMAINING_SEC,
  actualRemainingSec: ACTUAL_REMAINING_SEC,
  signedDurationErrorSec: SIGNED_DURATION_ERROR_SEC,
  absoluteDurationErrorSec: Math.abs(SIGNED_DURATION_ERROR_SEC),
  medianReview: null,
  // Closed interval: an actual equal to the upper bound is still inside.
  withinIqr: true,
} as unknown as DdrrRow;

const COVERAGE_ROW = {
  ...BASE_ROW,
  eventId: 2,
  startedAt: 1_699_900_000,
  kind: "coverage",
  predictionState: "missed_lock_recovered",
  actualOutcome: "recovered",
  actualEndedAt: 1_699_910_000,
  terminalEvidenceSourceDate: null,
  coverageCause: "lock_missed",
  operationalCoverageCause: null,
  outcomeQualityState: "classified",
  reason: null,
  failedPublication: null,
} as unknown as DdrrRow;

function mockReview(rows: DdrrRow[] | undefined) {
  useDepegResolverReviewMock.mockReturnValue({
    data:
      rows == null
        ? undefined
        : ({
            _meta: { computedAt: 1_700_100_000, publicWarning: DDRR_PUBLIC_WARNING },
            summary: {},
            rows,
            methodology: {},
          } as unknown as DdrrResponse),
  });
}

describe("DdrTrackRecordSection", () => {
  it("renders nothing while the review query has no data", () => {
    mockReview(undefined);
    const { container } = render(<DdrTrackRecordSection stablecoinId={COIN} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the reviewer feature flag is off", () => {
    reviewerEnabledMock.mockReturnValue(false);
    mockReview([PREDICTION_ROW]);
    const { container } = render(<DdrTrackRecordSection stablecoinId={COIN} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a coin with no reviewed publication", () => {
    mockReview([COVERAGE_ROW]);
    const { container } = render(<DdrTrackRecordSection stablecoinId={COIN} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the chip, facts, incident rows, and the /depeg link", () => {
    mockReview([PREDICTION_ROW, COVERAGE_ROW]);
    render(<DdrTrackRecordSection stablecoinId={COIN} />);

    expect(screen.getByText("DDR track record")).toBeTruthy();
    expect(screen.getByText("1/1 correct")).toBeTruthy();

    // Fact values, not just their labels: one scored forecast, called correctly,
    // with the median absolute duration miss of this scenario (1h).
    const facts = screen.getByRole("group", { name: "DDR track record facts" });
    expect(facts.textContent).toContain("Forecasts");
    expect(facts.textContent).toContain("Correct");
    expect(facts.textContent).toContain("Median miss");
    expect(facts.textContent).toContain("1h");
    expect(facts.textContent).toContain("Not called");

    const incidents = screen.getByRole("list", { name: "Reviewed depeg incidents" });
    expect(incidents.querySelectorAll("li")).toHaveLength(2);
    expect(incidents.textContent).toContain("2023-11-14");
    expect(incidents.textContent).toContain("Correct recoverable");
    expect(incidents.textContent).toContain("−1h inside band");
    expect(incidents.textContent).toContain("missed recovered");

    expect(screen.getByText(DDRR_PUBLIC_WARNING)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Full DDRR review" }).getAttribute("href")).toBe("/depeg");
    expect(screen.getByText("Reviewed 2023-11-16")).toBeTruthy();
  });
});
