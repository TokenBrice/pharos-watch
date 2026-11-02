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
      meta: { updatedAt: NOW_SEC - 3_600, ageSeconds: 3_600, status: "fresh" },
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
    // The oldest required lane (legacy, 2h old) bounds the dated streak.
    expect(html).toContain(`Streak as of ${new Date((NOW_SEC - 7_200) * 1000).toISOString().slice(0, 10)}`);
    expect(html).not.toContain("Current streak");
    // The dated streak spans both mobile columns so its label fits on one line at 390px.
    expect(html).toContain('class="pharos-inset px-3 py-1.5 col-span-2 sm:col-span-1"><p class="pharos-label">Streak as of');

    // Upgrade indicator (B -> B+ is an upgrade)
    expect(html).toContain("Upgraded from B");

    // Initial grade still present
    expect(html).toContain("Initial grade");
    expect(html).toContain(`Safety Score history as of ${new Date((NOW_SEC - 3_600) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(html).toContain(`Legacy history as of ${new Date((NOW_SEC - 7_200) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(html).not.toContain("Updated");
    expect(html).not.toMatch(/\bnow\b/i);
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
    expect(html).toContain("Streak as of ");
    expect(html).not.toContain("Show 1 more");
  });

  it("omits lane provenance and the streak when history meta is unavailable", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [
        { date: 1_741_000_000, grade: "B", score: 74, prevGrade: null, prevScore: null, methodologyVersion: "6.0" },
      ],
      meta: null,
      isLoading: false,
      error: null,
    });

    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: { schemaVersion: 2, history: [] }, meta: null, isLoading: false, error: null });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).not.toContain(" as of ");
    expect(html).not.toContain("Streak");
    expect(html).toContain("Best grade");
  });

  const LEGACY_B = {
    data: [{ date: 1_741_000_000, grade: "B", score: 74, prevGrade: null, prevScore: null, methodologyVersion: "6.0" }],
    meta: { updatedAt: NOW_SEC - 7_200, ageSeconds: 7_200, status: "fresh" },
    isLoading: false,
    error: null,
  };
  const V2_ROWS = {
    schemaVersion: 2,
    history: [{
      date: 1_741_500_000, grade: "B+", score: 78, prevGrade: "B", prevScore: 74,
      transitionKind: "grade-change", safetyScoreIdentity: makeV9Identity("9.30", "v2"),
    }],
  };

  it.each([
    ["errored", { data: undefined, meta: null, isLoading: false, error: new Error("v2 down") }],
    ["loading", { data: undefined, meta: null, isLoading: true, error: null }],
  ])("retains legacy B with %s V2 but claims no current B or B-to-now", (_name, v2) => {
    useSafetyScoreHistoryMock.mockReturnValue(LEGACY_B);
    useSafetyScoreHistoryV2Mock.mockReturnValue(v2);
    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toContain("Grade History");
    expect(html).toContain("Initial grade");
    expect(html).not.toContain("Streak");
    expect(html).not.toContain("Current streak");
    expect(html).not.toContain('role="img"');
    expect(html).not.toMatch(/\bnow\b/i);
    expect(html).toContain(`Legacy history as of`);
    expect(html).not.toContain("Safety Score history as of");
  });

  it("names a failed V2 lane with nothing retained while keeping legacy rows", () => {
    useSafetyScoreHistoryMock.mockReturnValue(LEGACY_B);
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: undefined, meta: null, isLoading: false, error: new Error("v2 down") });
    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toContain("Could not refresh Safety Score history");
    expect(html).toContain("Initial grade");
  });

  it("caps a stale retained V2 timeline and streak at its fixed as-of, not now", () => {
    const v2Generation = 1_741_600_000; // ~4.6 days before NOW_SEC
    useSafetyScoreHistoryMock.mockReturnValue({ ...LEGACY_B, meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" } });
    useSafetyScoreHistoryV2Mock.mockReturnValue({
      data: V2_ROWS,
      meta: { updatedAt: v2Generation, ageSeconds: NOW_SEC - v2Generation, status: "stale" },
      isLoading: false,
      error: new Error("refresh failed"),
    });
    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    const asOf = new Date(v2Generation * 1000).toISOString().slice(0, 10);
    expect(html).toContain(`Streak as of ${asOf}`);
    expect(html).toContain(">1d</span>");
    expect(html).not.toMatch(/\bnow\b/i);
    const endLabel = new Date(v2Generation * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    expect(html).toContain(`to ${endLabel}`);
    // Two segments over the capped span: B for 500,000s, B+ for 100,000s.
    expect(html).toMatch(/width:83\.3/);
    expect(html).toMatch(/width:16\.6/);
  });

  it("never merges unequal or null lane clocks into one freshness claim", () => {
    useSafetyScoreHistoryMock.mockReturnValue({ ...LEGACY_B, meta: { updatedAt: null, ageSeconds: null, status: "unknown" } });
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: V2_ROWS, meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" }, isLoading: false, error: null });
    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toContain("Safety Score history as of");
    expect(html).not.toContain("Legacy history as of");
    // A retained lane with an unknown clock leaves no defensible endpoint.
    expect(html).not.toContain("Streak");
  });

  it("renders retained rows while a sibling lane is loading, and nothing when both are unavailable", () => {
    useSafetyScoreHistoryMock.mockReturnValue({ data: undefined, meta: null, isLoading: true, error: null });
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: V2_ROWS, meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" }, isLoading: false, error: null });
    expect(renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />)).toContain("Upgraded from B");

    useSafetyScoreHistoryMock.mockReturnValue({ data: undefined, meta: null, isLoading: false, error: new Error("legacy down") });
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: undefined, meta: null, isLoading: false, error: new Error("v2 down") });
    const failed = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(failed).toContain("Could not refresh");
    expect(failed).not.toContain("Failed to load this dataset");

    useSafetyScoreHistoryMock.mockReturnValue({ data: [], meta: { updatedAt: NOW_SEC, ageSeconds: 0, status: "fresh" }, isLoading: false, error: null });
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: { schemaVersion: 2, history: [] }, meta: { updatedAt: NOW_SEC, ageSeconds: 0, status: "fresh" }, isLoading: false, error: null });
    expect(renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />)).toBe("");
  });

  it("keeps a retained refresh failure silent and warns only on material lane age", () => {
    useSafetyScoreHistoryMock.mockReturnValue({ ...LEGACY_B, error: new Error("refetch failed") });
    const silent = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(silent).not.toContain('role="status"');

    useSafetyScoreHistoryMock.mockReturnValue({ ...LEGACY_B, meta: { updatedAt: NOW_SEC - 30 * 86_400, ageSeconds: 30 * 86_400, status: "stale" } });
    const stale = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(stale).toContain("Showing an older snapshot");
    expect(stale).toContain("Legacy history");
  });

  it("names no best or lowest grade when every observation is NR", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [{ date: 1_741_000_000, grade: "NR", score: null, prevGrade: null, prevScore: null, methodologyVersion: "6.0" }],
      meta: { updatedAt: NOW_SEC - 7_200, ageSeconds: 7_200, status: "fresh" },
      isLoading: false,
      error: null,
    });
    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).not.toContain("Best grade");
    expect(html).not.toContain("Lowest grade");
  });

  it("ends the streak and the open segment at the last observation when the asset has no current grade", () => {
    useSafetyScoreHistoryMock.mockReturnValue({ ...LEGACY_B, meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" } });
    useSafetyScoreHistoryV2Mock.mockReturnValue({
      data: V2_ROWS,
      meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" },
      isLoading: false,
      error: null,
    });
    const html = renderToStaticMarkup(
      <SafetyScoreHistorySection stablecoinId="xmd-metal-dollar" currentlyRated={false} />,
    );
    // The job-wide grade-history clock cannot carry a pipeline-gap asset's last grade forward.
    expect(html).not.toContain("Streak as of");
    const timeline = /aria-label="Grade timeline: ([^"]*)"/.exec(html)?.[1];
    expect(timeline).toBeDefined();
    expect(timeline).not.toContain("B+");
  });
});
