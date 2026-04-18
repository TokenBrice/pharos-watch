// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegHistory } from "@/components/depeg-history";
import type { DepegEvent } from "@shared/types";

const { useInfiniteDepegEventsMock } = vi.hoisted(() => ({
  useInfiniteDepegEventsMock: vi.fn(),
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: useInfiniteDepegEventsMock,
}));

afterEach(cleanup);

function makeEvent(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "fiat-backed",
    direction: "below",
    peakDeviationBps: -150,
    startedAt: 1_700_000_000,
    endedAt: 1_700_086_400,
    startPrice: 0.985,
    peakPrice: 0.982,
    recoveryPrice: 0.999,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    ...overrides,
  };
}

function mockEvents(events: DepegEvent[]) {
  useInfiniteDepegEventsMock.mockReturnValue({
    data: { events, total: events.length },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetchingNextPage: false,
    loadedCount: events.length,
    isFullyLoaded: true,
  });
}

describe("DepegHistory provenance badges", () => {
  it("renders pending_reason and confirmation_sources badges when present", () => {
    mockEvents([
      makeEvent({
        id: 42,
        confirmationSources: "DEX+CEX",
        pendingReason: "large-cap",
      }),
    ]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.getByTestId("event-pending-reason").textContent).toContain("large-cap");
    expect(screen.getByTestId("event-confirmed-by").textContent).toContain("DEX+CEX");
  });

  it("omits both badges for legacy events where provenance fields are null", () => {
    mockEvents([
      makeEvent({
        id: 7,
        confirmationSources: null,
        pendingReason: null,
      }),
    ]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.queryByTestId("event-pending-reason")).toBeNull();
    expect(screen.queryByTestId("event-confirmed-by")).toBeNull();
  });
});
