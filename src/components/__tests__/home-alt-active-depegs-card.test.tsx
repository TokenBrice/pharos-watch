// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
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
  ACTIVE_STABLECOIN_ID_SET: new Set([
    "usdc-circle",
    "eur-stasis",
    ...Array.from({ length: 119 }, (_, i) => `fixture-coin-${String(i + 3).padStart(2, "0")}`),
  ]),
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

const ACTIVE_COIN_IDS = [
  "usdc-circle",
  "eur-stasis",
  ...Array.from({ length: 119 }, (_, i) => `fixture-coin-${String(i + 3).padStart(2, "0")}`),
];

function makeActiveFixtures(count: number): { events: DepegEvent[]; coins: { id: string; symbol: string; activeDepeg: boolean; currentDeviationBps: number }[] } {
  const ids = ACTIVE_COIN_IDS.slice(0, count);
  return {
    events: ids.map((id, index) =>
      makeEvent({
        id: index + 1,
        stablecoinId: id,
        symbol: `C${String(index + 1).padStart(2, "0")}`,
        peakDeviationBps: -((index + 1) * 10),
      }),
    ),
    coins: ids.map((id, index) => ({ id, symbol: `C${String(index + 1).padStart(2, "0")}`, activeDepeg: true, currentDeviationBps: -((index + 1) * 10) })),
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

  it("publishes the filtered active count as the headline, not the render cap", () => {
    const { events, coins } = makeActiveFixtures(19);
    useActiveDepegEventsMock.mockReturnValue({ data: { events }, isLoading: false });
    usePegSummaryMock.mockReturnValue({ data: { coins }, isLoading: false });
    render(<ActiveDepegsCard />);

    expect(screen.getByText("19")).toBeTruthy();
    expect(screen.queryByText("4")).toBeNull();
    expect(screen.getByText("active")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Top 4 of 19 active depegs by deviation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("C19")).toBeTruthy();
    expect(screen.getByText("C18")).toBeTruthy();
    expect(screen.getByText("C17")).toBeTruthy();
    expect(screen.getByText("C16")).toBeTruthy();
    expect(screen.queryByText("C15")).toBeNull();
  });

  it("keeps flashing the headline when the active count changes above the render cap", () => {
    const nineteen = makeActiveFixtures(19);
    useActiveDepegEventsMock.mockReturnValue({ data: { events: nineteen.events }, isLoading: false });
    usePegSummaryMock.mockReturnValue({ data: { coins: nineteen.coins }, isLoading: false });
    const view = render(<ActiveDepegsCard />);
    expect(view.container.querySelector("[class*='pharos-data-fresh']")).toBeNull();

    const twenty = makeActiveFixtures(20);
    useActiveDepegEventsMock.mockReturnValue({ data: { events: twenty.events }, isLoading: false });
    usePegSummaryMock.mockReturnValue({ data: { coins: twenty.coins }, isLoading: false });
    view.rerender(<ActiveDepegsCard />);

    expect(view.container.querySelector(".pharos-data-fresh-up")?.textContent).toBe("20");
  });
  it("counts an open incident whose current observation is unavailable", () => {
    useActiveDepegEventsMock.mockReturnValue({ data: { events: [makeEvent()] }, isLoading: false });
    usePegSummaryMock.mockReturnValue({
      data: { coins: [{ id: "usdc-circle", symbol: "USDC", activeDepeg: true, currentDeviationBps: null }] },
      isLoading: false,
    });
    render(<ActiveDepegsCard />);

    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Observation unavailable")).toBeTruthy();
    expect(screen.queryByText("No active incidents")).toBeNull();
  });

  it("counts the complete summary beyond the first 100 event details", () => {
    const { events, coins } = makeActiveFixtures(120);
    useActiveDepegEventsMock.mockReturnValue({ data: { events: events.slice(0, 100) }, isLoading: false });
    usePegSummaryMock.mockReturnValue({ data: { coins }, isLoading: false });
    render(<ActiveDepegsCard />);

    expect(screen.getByText("120")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Top 4 of 120 active depegs by deviation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("C120")).toBeTruthy();
    expect(within(list).getAllByText("Age unavailable")).toHaveLength(4);
  });

  it("keeps the incident count when event detail retrieval fails", () => {
    const { coins } = makeActiveFixtures(1);
    useActiveDepegEventsMock.mockReturnValue({ error: new Error("event details failed"), isLoading: false });
    usePegSummaryMock.mockReturnValue({ data: { coins }, isLoading: false });
    render(<ActiveDepegsCard />);

    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("C01")).toBeTruthy();
    expect(screen.getByText("Age unavailable")).toBeTruthy();
  });
});
