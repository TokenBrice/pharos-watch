// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlacklistStatusCharts } from "@/components/blacklist-status-charts";

afterEach(() => {
  cleanup();
});

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({
    ref: { current: null },
    ready: true,
    width: 480,
    height: 240,
  }),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({
    data: { peggedAssets: [] },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useReportCards: () => ({
    data: { cards: [] },
    isLoading: false,
  }),
}));

vi.mock("@/lib/blacklist-status-buckets", () => ({
  BLACKLIST_STATUS_BUCKET_COLORS: {
    yes: "#ef4444",
    possible: "#f59e0b",
    upstream: "#f97316",
    no: "#22c55e",
  },
  BLACKLIST_STATUS_BUCKET_LABELS: {
    yes: "Yes",
    possible: "Possible",
    upstream: "Upstream",
    no: "No",
  },
  BLACKLIST_STATUS_BUCKET_ORDER: ["yes", "possible", "upstream", "no"],
  buildBlacklistStatusBuckets: () => [
    { status: "Yes", key: "yes", count: 5, marketCap: 100 },
    { status: "Possible", key: "possible", count: 3, marketCap: 50 },
    { status: "Upstream", key: "upstream", count: 2, marketCap: 25 },
    { status: "No", key: "no", count: 1, marketCap: 10 },
  ],
}));

vi.mock("recharts", () => ({
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Bar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Cell: ({
    onClick,
    "aria-label": ariaLabel,
  }: {
    onClick?: () => void;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {ariaLabel}
    </button>
  ),
}));

describe("BlacklistStatusCharts", () => {
  it("calls back with the selected status bucket when a bar is clicked", () => {
    const onStatusSelect = vi.fn();

    render(<BlacklistStatusCharts onStatusSelect={onStatusSelect} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Show No stablecoins" })[0]);

    expect(onStatusSelect).toHaveBeenCalledWith("no");
  });
});
