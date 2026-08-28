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

const PREDICTION_ROW = {
  ...BASE_ROW,
  kind: "prediction_review",
  predictionState: "frozen",
  publicPredictionId: 7,
  assessmentId: 9,
  predictionMethodologyVersion: "4.0",
  predictionPolicyVersion: "sticky-24h-v1",
  lockedAt: 1_700_000_900,
  publishedAt: 1_700_001_000,
  publicationSnapshotToken: "snapshot-1",
  frozen: {
    resolutionTier: "recovery_likely",
    predictedRemainingSec: 3600,
    iqrRemainingSec: [1800, 7200],
    horizonCells: [],
    stratum: null,
    factors: [],
  },
  actual: {
    kind: "recovered",
    actualEndedAt: 1_700_010_000,
    actualRemainingSec: 9000,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    reviewedAt: 1_700_010_100,
  },
  verdictReview: "correct_recoverable",
  durationReview: "inside_band",
  horizonReviews: [],
  predictedRemainingSec: 3600,
  actualRemainingSec: 9000,
  signedDurationErrorSec: -3600,
  absoluteDurationErrorSec: 3600,
  medianReview: null,
  withinIqr: true,
} as unknown as DdrrRow;

const COVERAGE_ROW = {
  ...BASE_ROW,
  eventId: 2,
  startedAt: 1_699_900_000,
  kind: "coverage",
  predictionState: "missed_lock_recovered",
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

    const facts = screen.getByRole("group", { name: "DDR track record facts" });
    expect(facts.textContent).toContain("Forecasts");
    expect(facts.textContent).toContain("Correct");
    expect(facts.textContent).toContain("Median miss");
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
