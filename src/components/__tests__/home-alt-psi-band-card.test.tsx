// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PsiBandCard } from "@/components/home-alt-mini-cards/psi-band-card";
import type { StabilityIndexResponse } from "@shared/types/stability";

const { useStabilityIndexMock } = vi.hoisted(() => ({
  useStabilityIndexMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useStabilityIndex: useStabilityIndexMock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makePsiResponse(): StabilityIndexResponse {
  return {
    current: {
      score: 40,
      band: "BEDROCK",
      avg24h: 35,
      avg24hBand: "STEADY",
      components: { severity: 1, breadth: 2, stressBreadth: 3, trend: 4 },
      contributors: [],
      totalMcapUsd: 100,
      computedAt: 1_700_259_200,
      methodologyVersion: "1.0",
    },
    // API history is newest-first. The card should render oldest -> newest and
    // append the current sample, matching the full PSI history chart.
    history: [
      { date: 1_700_172_800, score: 30, band: "STEADY", methodologyVersion: "1.0" },
      { date: 1_700_086_400, score: 20, band: "STEADY", methodologyVersion: "1.0" },
      { date: 1_700_000_000, score: 10, band: "STEADY", methodologyVersion: "1.0" },
    ],
    methodology: {
      version: "1.0",
      versionLabel: "v1.0",
      currentVersion: "1.0",
      currentVersionLabel: "v1.0",
      changelogPath: "/methodology/stability-index-changelog/",
      isCurrent: true,
    },
  };
}

describe("PsiBandCard", () => {
  it("renders unavailable instead of a default steady band when the request fails", () => {
    useStabilityIndexMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("psi unavailable"),
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });

    render(<PsiBandCard />);

    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    expect(screen.queryByText(/Steady/)).toBeNull();
  });

  it("renders the Stability Index score and the sparkline from raw samples", () => {
    useStabilityIndexMock.mockReturnValue({
      data: makePsiResponse(),
      isLoading: false,
    });

    const { container, getByText, queryByText } = render(<PsiBandCard />);

    expect(container.textContent).toContain("Stability Index");
    expect(getByText("40.00")).toBeTruthy();
    expect(getByText("+15.0")).toBeTruthy();
    expect(queryByText("raw instant")).toBeNull();
    expect(queryByText("35.0")).toBeNull();

    const polyline = container.querySelector("polyline");
    expect(polyline).toBeTruthy();
    expect(polyline?.getAttribute("points")?.trim().split(/\s+/)).toHaveLength(4);
  });
});
