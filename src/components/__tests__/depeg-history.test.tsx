// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DepegHistory } from "@/components/depeg-history";
import type { DepegEvent } from "@shared/types";

const { useInfiniteDepegEventsMock } = vi.hoisted(() => ({
  useInfiniteDepegEventsMock: vi.fn(),
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: useInfiniteDepegEventsMock,
}));

afterEach(() => {
  cleanup();
  useInfiniteDepegEventsMock.mockReset();
});

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
    closeReason: null,
    provenance: null,
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
  it("background-loads every cursor page before computing metrics and local pagination", () => {
    mockEvents([makeEvent()]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(useInfiniteDepegEventsMock).toHaveBeenCalledWith({
      stablecoinId: "usdc-circle",
      autoLoadAll: true,
    });
  });

  it("renders pending_reason and confirmation_sources badges when present", () => {
    mockEvents([
      makeEvent({
        id: 42,
        confirmationSources: "DEX+CEX",
        pendingReason: "large-cap",
      }),
    ]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.getByTestId("stablecoin-depeg-history-table").getAttribute("data-table-id")).toBe(
      "stablecoin-depeg-history",
    );
    expect(screen.getByTestId("event-source").textContent).toContain("live");
    expect(screen.getByTestId("event-pending-reason").textContent).toContain("large cap");
    expect(screen.getByTestId("event-confirmed-by").textContent).toContain("DEX, CEX");
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

    expect(screen.getByTestId("event-source").textContent).toContain("live");
    expect(screen.queryByTestId("event-pending-reason")).toBeNull();
    expect(screen.queryByTestId("event-confirmed-by")).toBeNull();
  });
});

function tableRowCount(): number {
  return screen.getByTestId("stablecoin-depeg-history-table").querySelectorAll("tbody tr").length;
}

describe("DepegHistory incident fold", () => {
  it("opens truncated to six incidents and hides pagination while folded", () => {
    mockEvents(Array.from({ length: 9 }, (_, i) => makeEvent({ id: i + 1, startedAt: 1_700_000_000 - i * 86_400 })));

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(tableRowCount()).toBe(6);
    expect(screen.getByRole("button", { name: "Show all 9 incidents" })).toBeTruthy();
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
  });

  it("reveals the paginated remainder when the fold is opened", () => {
    mockEvents(Array.from({ length: 9 }, (_, i) => makeEvent({ id: i + 1, startedAt: 1_700_000_000 - i * 86_400 })));

    render(<DepegHistory stablecoinId="usdc-circle" />);
    fireEvent.click(screen.getByRole("button", { name: "Show all 9 incidents" }));

    expect(tableRowCount()).toBe(9);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("keeps short histories unfolded", () => {
    mockEvents(Array.from({ length: 4 }, (_, i) => makeEvent({ id: i + 1, startedAt: 1_700_000_000 - i * 86_400 })));

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(tableRowCount()).toBe(4);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
