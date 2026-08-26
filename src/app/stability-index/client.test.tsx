// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StabilityIndexClient } from "./client";

let stabilityState: {
  data: {
    current: Record<string, unknown> | null;
    history: Array<Record<string, unknown>>;
    methodology: Record<string, unknown>;
  } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  dataUpdatedAt: number;
  meta: Record<string, unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  dataUpdatedAt: 0,
  meta: {},
};

const refetch = vi.fn();

vi.mock("@/hooks/api-hooks", () => ({
  useStabilityIndexDetail: () => ({
    ...stabilityState,
    refetch,
  }),
}));

vi.mock("@/hooks/use-time-range-filter", () => ({
  useTimeRangeFilter: <T,>(data: T[]) => ({
    range: "30d",
    setRange: vi.fn(),
    filteredData: data,
    options: [{ value: "30d", label: "30d" }],
  }),
}));

vi.mock("@/lib/logos", () => ({
  logosById: { "usdc-circle": "/usdc.svg" },
}));

vi.mock("@/components/chart-primitives/axes", () => ({
  DateTooltip: () => null,
  MonoYAxis: () => null,
  TimeGrid: () => null,
  TimeXAxis: () => null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Area: () => <div />,
}));

vi.mock("./psi-lighthouse-scene", () => ({
  PsiLighthouseScene: ({ band, score }: { band: string; score: number }) => (
    <div>{band} lighthouse scene {Math.round(score)}</div>
  ),
}));

vi.mock("@/components/psi-history-chart", () => ({
  ScoreChart: ({ data }: { data: unknown[] }) => <div>score-chart-{data.length}</div>,
  BAND_ZONES: [
    { y1: 90, label: "BEDROCK" },
    { y1: 75, label: "STEADY" },
    { y1: 60, label: "TREMOR" },
    { y1: 40, label: "FRACTURE" },
    { y1: 20, label: "CRISIS" },
    { y1: 0, label: "MELTDOWN" },
  ],
  PSI_EVENTS: [
    {
      label: "Silicon Valley Bank",
      date: Date.parse("2023-03-12T00:00:00Z"),
      links: [{ title: "Coverage", url: "https://example.com/svb" }],
    },
  ],
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: ({ error }: { error?: Error | null }) => <div role="alert">{error?.message ?? "error"}</div>,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/time-range-buttons", () => ({
  TimeRangeButtons: () => <div>time-range-buttons</div>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
  MethodologyTriggerButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

describe("StabilityIndexClient", () => {
  beforeEach(() => {
    refetch.mockReset();
    stabilityState = {
      data: {
        current: {
          score: 92.2,
          band: "BEDROCK",
          avg24h: 89.4,
          avg24hBand: "STEADY",
          components: { severity: 10, breadth: 5, stressBreadth: 2, trend: 4 },
          contributors: [
            { id: "usdc-circle", symbol: "USDC", bps: -120, mcapUsd: 60_000_000_000, ageDays: 3, factor: 1 },
          ],
          totalMcapUsd: 60_000_000_000,
          computedAt: 1_710_000_000,
          methodologyVersion: "1.0",
        },
        history: [
          { date: 1_709_913_600, score: 80, band: "STEADY", components: { severity: 9, breadth: 4, stressBreadth: 2, trend: 4 }, methodologyVersion: "1.0" },
          { date: 1_709_827_200, score: 76, band: "STEADY", components: { severity: 8, breadth: 4, stressBreadth: 1, trend: 4 }, methodologyVersion: "1.0" },
        ],
        methodology: {
          versionLabel: "v1.0",
          currentVersionLabel: "v1.0",
          changelogPath: "/methodology/stability-index-changelog/",
          isCurrent: true,
        },
      },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: Date.now(),
      meta: {},
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the current PSI state, contributors, and methodology section", () => {
    render(<StabilityIndexClient />);

    expect(screen.getAllByText("89.4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("rolling 24h avg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("STEADY").length).toBeGreaterThan(0);
    expect(screen.getByText("Top Contributors")).toBeTruthy();
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    const contributorsTable = screen.getByRole("table", {
      name: "Stablecoins currently contributing to PSI score reduction",
    });
    expect(contributorsTable).toBeTruthy();
    expect(contributorsTable.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
    const contributorsShell = screen.getByTestId("stability-index-top-contributors-table");
    expect(contributorsShell.getAttribute("data-table-id")).toBe("stability-index-top-contributors");
    expect(contributorsShell.className).toContain("pharos-density-compact");
    expect(screen.getByText("Methodology")).toBeTruthy();
    expect(screen.getByText("score-chart-3")).toBeTruthy();
  });

  it("shows the query error notice when the PSI detail query fails without data", () => {
    stabilityState = {
      data: { current: null, history: [], methodology: { versionLabel: "v1.0", currentVersionLabel: "v1.0", changelogPath: "/methodology/stability-index-changelog/", isCurrent: true } },
      isLoading: false,
      isError: true,
      error: new Error("psi down"),
      dataUpdatedAt: 0,
      meta: {},
    };

    render(<StabilityIndexClient />);

    expect(screen.getByRole("alert").textContent).toContain("psi down");
  });
});
