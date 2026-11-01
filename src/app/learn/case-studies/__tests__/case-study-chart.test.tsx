// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseStudyChart } from "../case-study-chart";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import { getCaseStudyChartDays } from "@/lib/case-study-event-window";

const mocks = vi.hoisted(() => ({
  useSupplyHistory: vi.fn(() => ({
    data: [{ date: 1_700_000_000, circulatingUsd: 1_000_000, price: 0.99 }],
    error: null as Error | null,
    isLoading: false,
  })),
  pegDeviationChart: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useSupplyHistory: mocks.useSupplyHistory,
}));

vi.mock("@/components/peg-deviation-chart", () => ({
  PegDeviationChart: (props: { data: readonly unknown[] }) => {
    mocks.pegDeviationChart(props);
    return <output data-testid="case-study-peg-chart">{props.data.length}</output>;
  },
}));

vi.mock("@/components/chart-skeleton", () => ({
  ChartSkeleton: () => <div data-testid="chart-skeleton" />,
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
    mocks.pegDeviationChart.mockClear();
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
    expect(mocks.pegDeviationChart).toHaveBeenCalledWith({
      data: mocks.useSupplyHistory.mock.results[0].value.data,
      pegCurrency: "USD",
      embedded: true,
    });
    expect(screen.getByTestId("case-study-peg-chart").textContent).toBe("1");
    expect(screen.getByText(widget.caption)).toBeDefined();
  });
});

describe("case-study chart query states", () => {
  const { widget, eventWindows } = CHART_FIXTURES[0]!;
  const point = { date: 1_700_000_000, circulatingUsd: 1_000_000, price: 0.99 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    mocks.useSupplyHistory.mockClear();
    mocks.pegDeviationChart.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a retained series visible when a refresh fails", () => {
    mocks.useSupplyHistory.mockReturnValue({
      data: [point],
      error: new Error("http 503"),
      isLoading: false,
    });

    render(<CaseStudyChart widget={widget} eventWindows={eventWindows} />);

    expect(screen.getByTestId("case-study-peg-chart")).toBeTruthy();
    expect(screen.queryByText("Failed to load this dataset")).toBeNull();
  });

  it("shows a skeleton, not an unavailability claim, while the first read is pending", () => {
    mocks.useSupplyHistory.mockReturnValue({ data: [], error: null, isLoading: true });

    render(<CaseStudyChart widget={widget} eventWindows={eventWindows} />);

    expect(screen.getByTestId("chart-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("case-study-peg-chart")).toBeNull();
    expect(screen.queryByText(/No price history available/)).toBeNull();
  });

  it("reports a settled empty failure instead of an empty chart", () => {
    mocks.useSupplyHistory.mockReturnValue({
      data: [],
      error: new Error("http 503"),
      isLoading: false,
    });

    render(<CaseStudyChart widget={widget} eventWindows={eventWindows} />);

    expect(screen.getByText("Failed to load this dataset")).toBeTruthy();
    expect(screen.queryByTestId("case-study-peg-chart")).toBeNull();
  });
});
