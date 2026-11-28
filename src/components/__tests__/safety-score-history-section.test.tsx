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

const renderUsdtHistory = () => renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);

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

    const html = renderUsdtHistory();

    expect(html).toContain("Best grade");
    expect(html).toContain("Lowest grade");
    // The oldest required lane (legacy, 2h old) bounds the dated streak.
    expect(html).toContain(`Streak as of ${new Date((NOW_SEC - 7_200) * 1000).toISOString().slice(0, 10)}`);
    expect(html).not.toContain("Current streak");
    // The dated streak spans both mobile columns so its label fits on one line at 390px.
    expect(html).toContain('class="pharos-inset px-3 py-1.5 col-span-2 sm:col-span-1"><p class="pharos-label">Streak as of');

    // One row grammar: a direction glyph, then "from X"; the verb stays for assistive tech.
    expect(html).toContain('<span class="sr-only">Upgraded </span>from B');
    expect(html).toContain("▲");
    expect(html).not.toContain("Upgraded from B");

    // Initial grade still present
    expect(html).toContain("Initial grade");
    expect(html).toContain(`Safety Score history as of ${new Date((NOW_SEC - 3_600) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(html).toContain(`Legacy history as of ${new Date((NOW_SEC - 7_200) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    // The header chip is the age chip every module carries, dated at the
    // lane's producer generation, never a bare calendar date.
    expect(html).toContain(`dateTime="${new Date((NOW_SEC - 3_600) * 1000).toISOString()}"`);
    expect(html).not.toMatch(/>\d{4}-\d{2}-\d{2}<\/span>/);
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

    // A re-baselined row names its source grade with a neutral glyph and a quiet tag.
    expect(html).toContain('<span aria-hidden="true">▼ </span>from C+');
    expect(html).toContain(">Methodology</span>");
    expect(html).not.toContain("Methodology baseline");
    expect(html).toContain('aria-label="Safety grade D, score 49"');
    expect(html).toContain("Streak as of ");
    expect(html).not.toContain("Show 1 more");
  });

  describe("methodology blips, timeline axis and the live grade", () => {
    const DAY = 86_400;
    const baseline = (date: number, grade: string, score: number, version: string) => ({
      date, grade, score, prevGrade: null, prevScore: null,
      transitionKind: "methodology-boundary-baseline", safetyScoreIdentity: makeV9Identity(version, `g-${version}`),
    });
    beforeEach(() => {
      useSafetyScoreHistoryMock.mockReturnValue({ data: [], meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" }, isLoading: false, error: null });
      useSafetyScoreHistoryV2Mock.mockReturnValue({
        data: { schemaVersion: 2, history: [
          baseline(NOW_SEC - 3 * DAY, "A+", 90, "9.90"),
          baseline(NOW_SEC - 2 * DAY, "C", 55, "9.92"),
          baseline(NOW_SEC - DAY, "A+", 90, "9.94"),
          baseline(NOW_SEC - 600, "B", 72, "9.95"),
        ] },
        meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" },
        isLoading: false,
        error: null,
      });
    });

    it("keeps a reverted one-day methodology blip out of the lowest grade and names it", () => {
      const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdc-circle" />);
      const lowest = html.slice(html.indexOf("Lowest grade"), html.indexOf("Streak as of"));
      expect(lowest).toContain('aria-label="Safety grade B, score 72"');
      expect(lowest).not.toContain('aria-label="Safety grade C, score 55"');
      // The note sits under the tiles, so it never leaves the Best tile half empty.
      expect(lowest).not.toContain("Excludes");
      expect(html).toContain("Lowest grade excludes a one-day methodology blip: C (55)");
      expect(html).toContain("Methodology · reverted next day");
      // The grade that did not revert keeps its plain methodology tag.
      expect(html.match(/reverted next day/g)).toHaveLength(1);
    });

    it("dates the grade strip at its start, middle and end and keys its colours", () => {
      const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdc-circle" />);
      const ticks = [...html.matchAll(/<span class="text-(?:left|center|right)">([^<]+)<\/span>/g)].map((match) => match[1]);
      expect(ticks).toHaveLength(3);
      expect(ticks[0]).toBe(new Date((NOW_SEC - 3 * DAY) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }));
      expect(html).toContain('aria-label="Timeline legend"');
      expect(html).toContain("A grades");
      expect(html).toContain("B grades");
      expect(html).toContain("C grades");
    });

    it("says when today's daily close differs from the live grade", () => {
      const live = renderToStaticMarkup(
        <SafetyScoreHistorySection stablecoinId="xaut-tether" liveGrade={{ grade: "A-", score: 81 }} />,
      );
      expect(live).toContain("today&#x27;s row reads B (72), while the live Safety Score is A- (81)");
      const same = renderToStaticMarkup(
        <SafetyScoreHistorySection stablecoinId="xaut-tether" liveGrade={{ grade: "B", score: 73 }} />,
      );
      expect(same).not.toContain("data-grade-history-live-note");
      expect(renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="xaut-tether" />)).not.toContain("live Safety Score");
    });
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

    const html = renderUsdtHistory();
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
    const html = renderUsdtHistory();
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
    const html = renderUsdtHistory();
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
    const html = renderUsdtHistory();
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
    const html = renderUsdtHistory();
    expect(html).toContain("Safety Score history as of");
    expect(html).not.toContain("Legacy history as of");
    // A retained lane with an unknown clock leaves no defensible endpoint.
    expect(html).not.toContain("Streak");
  });

  it("renders retained rows while a sibling lane is loading, and nothing when both are unavailable", () => {
    useSafetyScoreHistoryMock.mockReturnValue({ data: undefined, meta: null, isLoading: true, error: null });
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: V2_ROWS, meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" }, isLoading: false, error: null });
    expect(renderUsdtHistory()).toContain("Upgraded </span>from B");

    useSafetyScoreHistoryMock.mockReturnValue({ data: undefined, meta: null, isLoading: false, error: new Error("legacy down") });
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: undefined, meta: null, isLoading: false, error: new Error("v2 down") });
    const failed = renderUsdtHistory();
    expect(failed).toContain("Could not refresh");
    expect(failed).not.toContain("Failed to load this dataset");

    useSafetyScoreHistoryMock.mockReturnValue({ data: [], meta: { updatedAt: NOW_SEC, ageSeconds: 0, status: "fresh" }, isLoading: false, error: null });
    useSafetyScoreHistoryV2Mock.mockReturnValue({ data: { schemaVersion: 2, history: [] }, meta: { updatedAt: NOW_SEC, ageSeconds: 0, status: "fresh" }, isLoading: false, error: null });
    expect(renderUsdtHistory()).toBe("");
  });

  it("keeps a retained refresh failure silent and warns only on material lane age", () => {
    useSafetyScoreHistoryMock.mockReturnValue({ ...LEGACY_B, error: new Error("refetch failed") });
    const silent = renderUsdtHistory();
    // The age chip's live region stays empty; no notice is drawn.
    expect(silent).not.toMatch(/role="status"[^>]*>[^<]/);
    expect(silent).not.toContain("Showing an older snapshot");

    useSafetyScoreHistoryMock.mockReturnValue({ ...LEGACY_B, meta: { updatedAt: NOW_SEC - 30 * 86_400, ageSeconds: 30 * 86_400, status: "stale" } });
    const stale = renderUsdtHistory();
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
    const html = renderUsdtHistory();
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
