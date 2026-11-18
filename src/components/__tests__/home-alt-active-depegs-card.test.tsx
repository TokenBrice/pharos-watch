// @vitest-environment jsdom

import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import type { DepegEvent } from "@shared/types/peg";

const { useActiveDepegEventsMock, usePegSummaryMock, useStablecoinsMock, useResolverMock } = vi.hoisted(() => ({
  useActiveDepegEventsMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  useStablecoinsMock: vi.fn(() => ({ data: undefined })),
  useResolverMock: vi.fn(() => ({ resolver: { data: undefined } })),
}));

vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));
vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({ useDepegResolverSurfaces: useResolverMock }));

// The headline reads the worker's `summary.activeDepegCount` (the /depeg/ hero
// authority). Fixtures that only list coins get that count the way the worker
// derives it here: flagged coins (none of these fixtures are NAV tokens).
vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: (...args: unknown[]) => {
    const result = usePegSummaryMock(...args);
    const data = result?.data;
    if (!data?.coins || data.summary) return result;
    const activeIds = new Set(["usdc-circle", "eur-stasis", ...Array.from({ length: 119 }, (_, i) => `fixture-coin-${String(i + 3).padStart(2, "0")}`)]);
    const activeDepegCount = data.coins.filter((coin: { id: string; activeDepeg?: boolean }) => coin.activeDepeg === true && activeIds.has(coin.id)).length;
    return { ...result, data: { ...data, summary: { activeDepegCount } } };
  },
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useActiveDepegEvents: useActiveDepegEventsMock,
}));

vi.mock("@/lib/stablecoin-static-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stablecoin-static-data")>()),
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
  vi.useRealTimers();
  vi.resetAllMocks();
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

    expect(screen.getByText("Active depegs")).toBeTruthy();
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
    expect(screen.getByText("coins with open confirmed incidents")).toBeTruthy();
    // Without supply the order falls back to deviation.
    const list = screen.getByRole("list", { name: "Top 4 of 19 active depegs by deviation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    screen.getByText("Top 4 of 19 by deviation");
    expect(screen.getByText("C19")).toBeTruthy();
    expect(screen.getByText("C16")).toBeTruthy();
    expect(screen.queryByText("C15")).toBeNull();
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
    expect(screen.getByText("coin with an open confirmed incident")).toBeTruthy();
    expect(screen.queryByText("No open confirmed incidents")).toBeNull();
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

  it("says no open confirmed incidents at zero, not that every peg holds", () => {
    useActiveDepegEventsMock.mockReturnValue({ data: { events: [] }, isLoading: false });
    usePegSummaryMock.mockReturnValue({ data: { coins: [{ id: "usdc-circle", symbol: "USDC", activeDepeg: false, currentDeviationBps: 0 }] }, isLoading: false });
    render(<ActiveDepegsCard />);
    expect(screen.getByText("No open confirmed incidents")).toBeTruthy();
  });

  it("names each row's recovery evidence on the viewer's minute clock, not query receipt time", () => {
    vi.useFakeTimers();
    const now = 1_700_003_600;
    vi.setSystemTime(now * 1000);
    const atPar = {
      intervals: [], atParIntervals: [[now - 1_200, now - 1_200]] as Array<[number, number]>,
      lastObservationKind: "trusted-at-par" as const, lastTrustedObservationAt: now - 1_200, gapStartedAt: now - 1_200,
    };
    useActiveDepegEventsMock.mockReturnValue({ data: { events: [{ ...makeEvent(), priceCoverage: atPar }] }, isLoading: false });
    usePegSummaryMock.mockReturnValue({
      data: { coins: [{ id: "usdc-circle", symbol: "USDC", activeDepeg: true, currentDeviationBps: -3 }] },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    render(<ActiveDepegsCard />);
    // Before the mounted clock ticks nothing is claimed.
    expect(screen.getByText(", Recovery unconfirmed")).toBeTruthy();
    expect(screen.getByText("Age unavailable")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByText(", Inside recovery band, awaiting confirmation")).toBeTruthy();
    expect(screen.getByRole("link", { name: /USDC/ }).getAttribute("title")).toBe("Inside recovery band, awaiting confirmation");
    expect(screen.getByText("1h")).toBeTruthy();
    // Past the continuous-observation limit the at-par reading expires.
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(", Recovery unconfirmed")).toBeTruthy();
  });

  it("ranks rows by USD off peg with DDR call, cap and recency", () => {
    const now = 1_700_000_000 + 10 * 86_400;
    vi.useFakeTimers({ now: now * 1000 });
    useActiveDepegEventsMock.mockReturnValue({ isLoading: false, data: { events: [
      makeEvent({ id: 1, stablecoinId: "usdc-circle", symbol: "USDC", startedAt: now - 2 * 86_400 }),
      makeEvent({ id: 2, stablecoinId: "eur-stasis", symbol: "EURS", startedAt: now - 9 * 86_400 }),
    ] } });
    usePegSummaryMock.mockReturnValue({ isLoading: false, data: { coins: [
      { id: "eur-stasis", symbol: "EURS", activeDepeg: true, currentDeviationBps: -2000 },
      { id: "usdc-circle", symbol: "USDC", activeDepeg: true, currentDeviationBps: -100 },
      { id: "fixture-coin-03", symbol: "C03", activeDepeg: true, currentDeviationBps: -5000 },
    ] } });
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [
      { id: "eur-stasis", circulating: { peggedEUR: 10_000_000 } }, { id: "usdc-circle", circulating: { peggedUSD: 500_000_000 } },
    ] } } as never);
    const ddrRow = (tier: string, eventState: string) => ({ kind: "prediction", stablecoinId: "usdc-circle", live: { eventState },
      prediction: { state: "frozen", predictionMethodologyVersion: "v5.0" }, frozen: { resolution: { tier } } });
    // A later, closed incident's frozen call must not overwrite the active one.
    useResolverMock.mockReturnValue({ resolver: { data: { _meta: { degraded: false },
      rows: [ddrRow("at_risk", "active"), ddrRow("recovery_likely", "closed_pending_review")] } } } as never);
    render(<ActiveDepegsCard />);
    act(() => { vi.advanceTimersByTime(0); });

    // $5.0M USDC > $2.0M EURS; unknown supply (C03) last despite the widest gap.
    const rows = within(screen.getByRole("list", { name: "Active depegs by USD off peg" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.match(/USDC|EURS|C03/)?.[0])).toEqual(["USDC", "EURS", "C03"]);
    for (const text of ["New", "$500.0M mkt cap"]) within(rows[0]!).getByText(text);
    within(rows[0]!).getByTitle("Stress signals");
    expect(within(rows[1]!).queryByText("New")).toBeNull();
    within(rows[2]!).getByText("Market cap unavailable");
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
