import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { useSafetyScoreHistoryMock } = vi.hoisted(() => ({
  useSafetyScoreHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/use-safety-score-history", () => ({
  useSafetyScoreHistory: useSafetyScoreHistoryMock,
}));

import {
  SafetyScoreHistorySection,
  describeSafetyScoreTransition,
} from "@/components/stablecoin-detail/safety-score-history-section";

describe("SafetyScoreHistorySection", () => {
  beforeEach(() => {
    useSafetyScoreHistoryMock.mockReset();
  });

  it("describes initial and transition rows", () => {
    expect(
      describeSafetyScoreTransition({
        date: 1_772_000_000,
        grade: "B+",
        score: 78,
        prevGrade: null,
        prevScore: null,
        methodologyVersion: "5.5",
      }),
    ).toBe("Initial grade");

    expect(
      describeSafetyScoreTransition({
        date: 1_772_086_400,
        grade: "A-",
        score: 82,
        prevGrade: "B+",
        prevScore: 78,
        methodologyVersion: "5.5",
      }),
    ).toBe("B+ -> A-");
  });

  it("does not render while loading", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toBe("");
  });

  it("does not render when history is empty", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toBe("");
  });

  it("does not render when query errors", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toBe("");
  });

  it("renders seed and transition summaries", () => {
    useSafetyScoreHistoryMock.mockReturnValue({
      data: [
        {
          date: 1_772_000_000,
          grade: "B",
          score: 74,
          prevGrade: null,
          prevScore: null,
          methodologyVersion: "5.5",
        },
        {
          date: 1_772_086_400,
          grade: "B+",
          score: 78,
          prevGrade: "B",
          prevScore: 74,
          methodologyVersion: "5.5",
        },
      ],
      isLoading: false,
      error: null,
    });

    const html = renderToStaticMarkup(<SafetyScoreHistorySection stablecoinId="usdt-tether" />);
    expect(html).toContain("Initial grade");
    expect(html).toContain("B -&gt; B+");
  });
});
