// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { HomeAltDdrOverview } from "@/components/home-alt-ddr-overview";

const { useDepegResolverSurfacesMock } = vi.hoisted(() => ({
  useDepegResolverSurfacesMock: vi.fn(),
}));

vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({
  useDepegResolverSurfaces: useDepegResolverSurfacesMock,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("HomeAltDdrOverview", () => {
  it("keeps invalidated, pending, and no-call states visible without live verdicts or durations", () => {
    const frozen = {
      resolution: { tier: "recovery_likely", factors: [] },
      duration: { suppressed: false, medianSec: 86_400 },
      sourceRow: { currentDeviationBps: -300, peakDeviationBps: -300 },
    };
    const base = { name: "Fixture", pegCurrency: "USD", direction: "below",
      live: { currentDeviationBps: -45, peakDeviationBps: -300 } };
    useDepegResolverSurfacesMock.mockReturnValue({
      resolverEnabled: true, resolverReviewerEnabled: false,
      resolver: { error: null, data: { _meta: { degraded: false }, rows: [
        { ...base, stablecoinId: "valid", symbol: "VALID", kind: "prediction", prediction: { state: "frozen" }, frozen },
        { ...base, stablecoinId: "withdrawn", symbol: "WITHDRAWN", kind: "invalidated_prediction",
          prediction: { state: "invalidated" }, originalKind: "prediction", originalOutcome: frozen },
        { ...base, stablecoinId: "pending", symbol: "PENDING", kind: "pending", prediction: { state: "pending_lock" } },
        { ...base, stablecoinId: "no-call", symbol: "NO-CALL", kind: "no_call", prediction: { state: "no_call" } },
      ] } },
      resolverReview: { data: undefined, error: null },
    });
    render(<HomeAltDdrOverview />);

    expect(screen.getByText("1 live")).toBeTruthy();
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).toContain("invalidated");
    expect(screen.getByText("PENDING").closest("a")?.textContent).toContain("pending lock");
    expect(screen.getByText("NO-CALL").closest("a")?.textContent).toContain("no call");
    expect(screen.getByText("VALID").closest("a")?.textContent).toContain("~1d");
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).not.toContain("~1d");
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).not.toContain("Likely");
    expect(screen.getAllByText("~1d")).toHaveLength(1);
  });

  it("shows a sealed forecast's current live deviation rather than its lock-time deviation", () => {
    useDepegResolverSurfacesMock.mockReturnValue({
      resolverEnabled: true,
      resolverReviewerEnabled: false,
      resolver: {
        data: {
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
        error: null,
      },
      resolverReview: { data: undefined, error: null },
    });
    render(<HomeAltDdrOverview />);

    expect(screen.getByText("-45 bps")).toBeTruthy();
    expect(screen.queryByText("-300 bps")).toBeNull();
  });
});
