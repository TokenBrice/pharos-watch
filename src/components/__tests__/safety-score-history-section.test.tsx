import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { useSafetyScoreHistoryMock } = vi.hoisted(() => ({
  useSafetyScoreHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useSafetyScoreHistory: useSafetyScoreHistoryMock,
}));

import { SafetyScoreHistorySection } from "@/components/stablecoin-detail/safety-score-history-section";

// Stable "now" so streak calculations are deterministic
const NOW_SEC = 1_742_000_000; // ~2025-03-15
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
  });

  it("does not render while loading", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: undefined,
      meta: null,
      isLoading: true,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toBe("");
  });

  it("does not render when history is empty", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [],
      meta: null,
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toBe("");
  });

  it("renders error banner when query errors", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: undefined,
      meta: null,
      isLoading: false,
      error: new Error("boom"),
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toContain("Failed to load this dataset");
    expect(html).toContain("boom");
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
    expect(html).toContain("Best Grade");
    expect(html).toContain("Lowest Grade");
    expect(html).toContain("Current Streak");

    // Upgrade indicator (B -> B+ is an upgrade)
    expect(html).toContain("Upgraded from B");

    // Initial grade still present
    expect(html).toContain("Initial grade");
    expect(html).toContain('aria-label="Updated at ');
    expect(html).toContain(">2h</span>");
  });

  it("caps visible entries at 3 and shows 'Show more' button", () => {
    const entries = [
      { date: 1_740_000_000, grade: "B-", score: 68, prevGrade: null, prevScore: null, methodologyVersion: "6.0" },
      { date: 1_740_200_000, grade: "B", score: 72, prevGrade: "B-", prevScore: 68, methodologyVersion: "6.0" },
      { date: 1_740_400_000, grade: "B+", score: 76, prevGrade: "B", prevScore: 72, methodologyVersion: "6.0" },
      { date: 1_740_600_000, grade: "A-", score: 80, prevGrade: "B+", prevScore: 76, methodologyVersion: "6.0" },
      { date: 1_740_800_000, grade: "A", score: 85, prevGrade: "A-", prevScore: 80, methodologyVersion: "6.0" },
    ];

    useSafetyScoreHistoryMock.mockReturnValue({
      data: entries,
      meta: null,
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);

    // Show more button should indicate 2 hidden entries
    expect(html).toContain("Show 2 more");

    // Newest 3 entries visible (reversed: A, A-, B+)
    // The 4th newest (B) should NOT appear in the rendered list.
    // The B entry date is 1_740_200_000; the visible B+ entry date is 1_740_400_000.
    // Both contain "B" in grade text, so we check the "Show 2 more" presence as proxy.
  });

  it("shows downgrade indicator for downgrades", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [
        { date: 1_741_000_000, grade: "A", score: 85, prevGrade: null, prevScore: null, methodologyVersion: "6.0" },
        { date: 1_741_500_000, grade: "B+", score: 78, prevGrade: "A", prevScore: 85, methodologyVersion: "6.0" },
      ],
      meta: null,
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toContain("Downgraded from A");
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
    expect(html).not.toContain("Updated:");
  });
});
