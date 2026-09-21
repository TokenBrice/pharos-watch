// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseStudyChart } from "../case-study-chart";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import { getCaseStudyChartDays } from "@/lib/case-study-event-window";

const mocks = vi.hoisted(() => ({
  useSupplyHistory: vi.fn(() => ({
    data: [{ date: 1_700_000_000, circulatingUsd: 1_000_000, price: 0.99 }],
    error: null,
  })),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useSupplyHistory: mocks.useSupplyHistory,
}));

vi.mock("@/components/peg-deviation-chart", () => ({
  PegDeviationChart: ({
    data,
    stablecoinId,
  }: {
    data: readonly unknown[];
    stablecoinId: string;
  }) => (
    <output data-testid="case-study-peg-chart">
      {stablecoinId}:{data.length}
    </output>
  ),
}));

const NOW_MS = Date.UTC(2026, 8, 22, 12);
const CHART_FIXTURES = CASE_STUDY_LIST.flatMap((study) =>
  (study.dataWidgets ?? []).map((widget) => ({
    slug: study.slug,
    widget,
    eventWindows: study.eventWindows ?? [study.eventWindow],
  })),
);

describe.each(CHART_FIXTURES)("$slug chart", ({ widget, eventWindows }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    mocks.useSupplyHistory.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests enough history for its event and renders the correct coin series", () => {
    render(<CaseStudyChart widget={widget} eventWindows={eventWindows} />);

    expect(mocks.useSupplyHistory).toHaveBeenCalledWith(
      widget.coinId,
      getCaseStudyChartDays(eventWindows, NOW_MS),
    );
    expect(screen.getByTestId("case-study-peg-chart").textContent).toBe(
      `${widget.coinId}:1`,
    );
    expect(screen.getByText(widget.caption)).toBeDefined();
  });
});
