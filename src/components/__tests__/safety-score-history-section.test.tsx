// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { useSafetyScoreHistoryMock, useSafetyScoreHistoryV2Mock } = vi.hoisted(() => ({
  useSafetyScoreHistoryMock: vi.fn(),
  useSafetyScoreHistoryV2Mock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useSafetyScoreHistory: useSafetyScoreHistoryMock,
  useSafetyScoreHistoryV2: useSafetyScoreHistoryV2Mock,
}));

import { SafetyScoreHistorySection } from "@/components/stablecoin-detail/safety-score-history-section";

// Stable "now" so streak calculations are deterministic
const NOW_SEC = 1_742_000_000; // ~2025-03-15
const TEST_DIGEST = "a".repeat(64);

function makeV9Identity(methodologyVersion: string, publicationGenerationId: string) {
  return {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion,
    policyId: "v9-test-policy",
    policyDigest: TEST_DIGEST,
    evaluationBuildDigest: TEST_DIGEST,
    baseInputGenerationId: "report-cards-input:v1:test",
    publicationGenerationId,
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { afterEach } from "vitest";

describe("SafetyScoreHistorySection", () => {
  beforeEach(() => {
    useSafetyScoreHistoryMock.mockReset();
    useSafetyScoreHistoryV2Mock.mockReset();
    useSafetyScoreHistoryV2Mock.mockReturnValue({
      data: { schemaVersion: 2, history: [] },
      meta: null,
      isLoading: false,
      error: null,
    });
  });

  it("renders summary stats, timeline bar, and transition list", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [
        {
          date: 1_741_000_000,
          grade: "B",
          score: 74,
          prevGrade: null,
          prevScore: null,
          methodologyVersion: "5.5",
        },
        {
          date: 1_741_500_000,
          grade: "B+",
          score: 78,
          prevGrade: "B",
          prevScore: 74,
          methodologyVersion: "5.5",
        },
      ],
      meta: { updatedAt: NOW_SEC - 7_200, ageSeconds: 7_200, status: "fresh" },
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);

    // Summary stats strip
    expect(html).toContain("Best grade");
    expect(html).toContain("Lowest grade");
    expect(html).toContain("Current streak");

    // Upgrade indicator (B -> B+ is an upgrade)
    expect(html).toContain("Upgraded from B");

    // Initial grade still present
    expect(html).toContain("Initial grade");
    expect(html).toContain("Updated at ");
    expect(html).toContain(">2h</span>");
  });

  it("merges identity-aware grade changes and collapses repeated baselines", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [
        { date: 1_740_000_000, grade: "C+", score: 61, prevGrade: "B-", prevScore: 65, methodologyVersion: "8.17" },
      ],
      meta: { updatedAt: NOW_SEC - 10_000, ageSeconds: 10_000, status: "fresh" },
      isLoading: false,
      error: null,
    });
    useSafetyScoreHistoryV2Mock.mockReturnValue({
      data: {
        schemaVersion: 2,
        history: [
          {
            date: 1_740_100_000,
            grade: "C+",
            score: 64,
            prevGrade: null,
            prevScore: null,
            transitionKind: "methodology-boundary-baseline",
            safetyScoreIdentity: makeV9Identity("9.1", "test"),
          },
          {
            date: 1_740_200_000,
            grade: "D",
            score: 49,
            prevGrade: null,
            prevScore: null,
            transitionKind: "methodology-boundary-baseline",
            safetyScoreIdentity: makeV9Identity("9.2", "test-2"),
          },
          {
            date: 1_740_300_000,
            grade: "D",
            score: 48,
            prevGrade: null,
            prevScore: null,
            transitionKind: "methodology-boundary-baseline",
            safetyScoreIdentity: makeV9Identity("9.21", "test-3"),
          },
        ],
      },
      meta: { updatedAt: NOW_SEC - 1_000, ageSeconds: 1_000, status: "fresh" },
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="nusd-neutrl" />);

    expect(html).toContain("Methodology baseline");
    expect(html).toContain('aria-label="Safety grade D, score 49"');
    expect(html).toContain("Current streak");
    expect(html).not.toContain("Show 1 more");
    expect(html).toContain(">16m</span>");
  });

  it("omits the freshness indicator when history meta is unavailable", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [
        { date: 1_741_000_000, grade: "B", score: 74, prevGrade: null, prevScore: null, methodologyVersion: "6.0" },
      ],
      meta: null,
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).not.toContain("Updated at ");
  });
});
