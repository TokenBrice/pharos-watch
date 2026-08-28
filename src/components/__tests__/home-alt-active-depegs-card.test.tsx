// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import type { DepegEvent } from "@shared/types";

const { useActiveDepegEventsMock, usePegSummaryMock } = vi.hoisted(() => ({
  useActiveDepegEventsMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: usePegSummaryMock,
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useActiveDepegEvents: useActiveDepegEventsMock,
}));

vi.mock("@/lib/stablecoin-static-data", () => ({
  ACTIVE_STABLECOIN_ID_SET: new Set(["usdc-circle", "eur-stasis"]),
}));

vi.mock("next/image", () => ({
  default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeEvent(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return {
    id: overrides.id ?? 1,
    stablecoinId: overrides.stablecoinId ?? "usdc-circle",
    symbol: overrides.symbol ?? "USDC",
    pegType: "fiat-backed",
    direction: overrides.direction ?? "below",
    peakDeviationBps: overrides.peakDeviationBps ?? -150,
    startedAt: overrides.startedAt ?? 1_700_000_000,
    endedAt: null,
    startPrice: 0.985,
    peakPrice: 0.982,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
  };
}

describe("ActiveDepegsCard", () => {
  it("filters frozen coins out of the active depeg count and list", () => {
    useActiveDepegEventsMock.mockReturnValue({
      data: {
        events: [
          makeEvent({ id: 1, stablecoinId: "usdc-circle", symbol: "USDC", peakDeviationBps: -9025 }),
          makeEvent({ id: 2, stablecoinId: "pmusd-piedmont", symbol: "PMUSD", peakDeviationBps: -5600 }),
          makeEvent({ id: 3, stablecoinId: "eur-stasis", symbol: "EURS", direction: "above", peakDeviationBps: 777 }),
        ],
      },
      isLoading: false,
    });
    usePegSummaryMock.mockReturnValue({
      data: {
        coins: [
          { id: "usdc-circle", activeDepeg: true, currentDeviationBps: -120 },
          { id: "pmusd-piedmont", activeDepeg: true, currentDeviationBps: -5568 },
          { id: "eur-stasis", activeDepeg: true, currentDeviationBps: 42 },
        ],
      },
      isLoading: false,
    });
    render(<ActiveDepegsCard />);

    expect(screen.getByText("Total Active Depegs")).toBeTruthy();
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText("EURS")).toBeTruthy();
    expect(screen.getByText(/120/)).toBeTruthy();
    expect(screen.queryByText(/9025/)).toBeNull();
    expect(screen.queryByText("PMUSD")).toBeNull();
  });
});
