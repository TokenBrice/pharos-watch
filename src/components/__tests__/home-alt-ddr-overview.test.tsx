// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { HomeAltDdrOverview } from "@/components/home-alt-ddr-overview";

const { useDepegResolverSurfacesMock, useLogosMock } = vi.hoisted(() => ({
  useDepegResolverSurfacesMock: vi.fn(),
  useLogosMock: vi.fn(),
}));

vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({
  useDepegResolverSurfaces: useDepegResolverSurfacesMock,
}));

vi.mock("@/hooks/use-logos", () => ({ useLogos: useLogosMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeAltDdrOverview", () => {
  it("shows a sealed forecast's current live deviation rather than its lock-time deviation", () => {
    useDepegResolverSurfacesMock.mockReturnValue({
      resolverEnabled: true,
      resolverReviewerEnabled: false,
      resolverData: {
        _meta: { degraded: false },
        rows: [
          {
            kind: "prediction",
            stablecoinId: "test-usd",
            symbol: "TUSD",
            name: "Test USD",
            pegCurrency: "USD",
            direction: "below",
            prediction: { state: "frozen" },
            frozen: {
              resolution: { tier: "at_risk", factors: [] },
              duration: { suppressed: true, medianSec: null },
              sourceRow: { currentDeviationBps: -300, peakDeviationBps: -300 },
            },
            live: { currentDeviationBps: -45, peakDeviationBps: -300 },
          },
        ],
      },
      resolverError: null,
      resolverReviewData: undefined,
      resolverReviewError: null,
    });
    useLogosMock.mockReturnValue({ data: {} });

    render(<HomeAltDdrOverview />);

    expect(screen.getByText("-45 bps")).toBeTruthy();
    expect(screen.queryByText("-300 bps")).toBeNull();
  });
});
