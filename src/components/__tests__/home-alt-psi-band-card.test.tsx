// @vitest-environment jsdom

import { render } from "@testing-library/react";
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
      asOf: 1_700_259_200,
      isCurrent: true,
    },
  };
}

describe("PsiBandCard", () => {
  it("leads with the displayed 24h basis and keeps the raw instant as context", () => {
    useStabilityIndexMock.mockReturnValue({
      data: makePsiResponse(),
      isLoading: false,
    });

    const { container, getByText } = render(<PsiBandCard />);

    expect(container.textContent).toContain("Stability Index");
    // Hero = rolling 24h avg at one decimal, matching the market-state line
    // and the /stability-index/ hero; the raw instant is demoted to context.
    expect(getByText("35.0").className).toContain("text-4xl");
    expect(getByText("Rolling 24h avg")).toBeTruthy();
    expect(getByText("40.0")).toBeTruthy();
    expect(getByText("+10.0")).toBeTruthy();
    expect(getByText("· Steady")).toBeTruthy();

    const polyline = container.querySelector("polyline");
    expect(polyline).toBeTruthy();
    expect(polyline?.getAttribute("points")?.trim().split(/\s+/)).toHaveLength(4);
  });

  it("keeps the band hue and lights the beacon while the sample is fresh", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const data = makePsiResponse();
    data.current!.computedAt = nowSec;
    useStabilityIndexMock.mockReturnValue({
      data,
      isLoading: false,
      dataUpdatedAt: Date.now(),
      meta: { updatedAt: nowSec, ageSeconds: 0, status: "fresh" },
    });

    const { getByText, queryByTestId } = render(<PsiBandCard />);

    expect(getByText("· Steady").className).toContain("text-teal-700");
    expect(queryByTestId("psi-band-card-as-of")).toBeNull();
  });

  it("drops the band hue and dates the stale observation without a state word", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const data = makePsiResponse();
    data.current!.computedAt = nowSec - 8 * 3600;
    useStabilityIndexMock.mockReturnValue({
      data,
      isLoading: false,
      dataUpdatedAt: Date.now(),
      meta: { updatedAt: nowSec - 8 * 3600, ageSeconds: 8 * 3600, status: "stale" },
    });

    const { container, getByText, getByTestId } = render(<PsiBandCard />);

    expect(getByText("· Steady").className).toContain("text-muted-foreground");
    expect(getByText("· Steady").className).not.toContain("text-teal");
    expect(getByTestId("psi-band-card-as-of").textContent).toMatch(/^As of /);
    expect(container.textContent).not.toMatch(/retained|stale/i);
  });
});
