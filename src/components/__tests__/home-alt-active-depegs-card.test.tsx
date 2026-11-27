// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import type { DepegEvent } from "@shared/types/peg";

const { useActiveDepegEventsMock, usePegSummaryMock, useStablecoinsMock, useResolverMock, ACTIVE_COIN_IDS } = vi.hoisted(() => ({
  useActiveDepegEventsMock: vi.fn(), usePegSummaryMock: vi.fn(),
  useStablecoinsMock: vi.fn(() => ({ data: undefined })), useResolverMock: vi.fn(() => ({ resolver: { data: undefined } })),
  ACTIVE_COIN_IDS: ["usdc-circle", "eur-stasis", ...Array.from({ length: 119 }, (_, i) => `fixture-coin-${String(i + 3).padStart(2, "0")}`)],
}));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));
vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({ useDepegResolverSurfaces: useResolverMock }));
vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: (...args: unknown[]) => {
    const result = usePegSummaryMock(...args), data = result?.data;
    if (!data?.coins || data.summary) return result;
    const ids = new Set(ACTIVE_COIN_IDS);
    return { ...result, data: { ...data, summary: { activeDepegCount: data.coins.filter((c: { id: string; activeDepeg?: boolean }) => c.activeDepeg === true && ids.has(c.id)).length } } };
  },
}));
vi.mock("@/hooks/use-depeg-events", () => ({ useActiveDepegEvents: useActiveDepegEventsMock }));
vi.mock("@/lib/stablecoin-static-data", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/stablecoin-static-data")>()), ACTIVE_STABLECOIN_ID_SET: new Set(ACTIVE_COIN_IDS) }));
vi.mock("next/image", () => ({ default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} /> }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

function makeEvent(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return { id: 1, stablecoinId: "usdc-circle", symbol: "USDC", pegType: "fiat-backed", direction: "below", peakDeviationBps: -150, startedAt: 1_700_000_000, endedAt: null, startPrice: 0.985, peakPrice: 0.982, recoveryPrice: null, pegReference: 1, source: "live", confirmationSources: null, pendingReason: null, closeReason: null, provenance: null, ...overrides };
}

function makeActiveFixtures(count: number) {
  const ids = ACTIVE_COIN_IDS.slice(0, count);
  return {
    events: ids.map((id, i) => makeEvent({ id: i + 1, stablecoinId: id, symbol: `C${String(i + 1).padStart(2, "0")}`, peakDeviationBps: -((i + 1) * 10) })),
    coins: ids.map((id, i) => ({ id, symbol: `C${String(i + 1).padStart(2, "0")}`, activeDepeg: true, currentDeviationBps: -((i + 1) * 10) })),
  };
}

const setEvents = (events: unknown) => useActiveDepegEventsMock.mockReturnValue({ data: { events }, isLoading: false });
const setPeg = (data: unknown, extra: Record<string, unknown> = {}) => usePegSummaryMock.mockReturnValue({ data, isLoading: false, ...extra });

describe("ActiveDepegsCard", () => {
  it("filters frozen coins out of the active depeg count and list", () => {
    setEvents([makeEvent({ id: 1, stablecoinId: "usdc-circle", symbol: "USDC", peakDeviationBps: -9025 }), makeEvent({ id: 2, stablecoinId: "pmusd-piedmont", symbol: "PMUSD", peakDeviationBps: -5600 }), makeEvent({ id: 3, stablecoinId: "eur-stasis", symbol: "EURS", direction: "above", peakDeviationBps: 777 })]);
    setPeg({ coins: [{ id: "usdc-circle", symbol: "USDC", pegCurrency: "USD", activeDepeg: true, currentDeviationBps: -120 }, { id: "pmusd-piedmont", symbol: "PMUSD", pegCurrency: "USD", activeDepeg: true, currentDeviationBps: -5568 }, { id: "eur-stasis", symbol: "EURS", pegCurrency: "EUR", activeDepeg: true, currentDeviationBps: 42 }] });
    render(<ActiveDepegsCard />);
    expect(screen.getByText("Active depegs")).toBeTruthy(); expect(screen.getByText("USDC")).toBeTruthy(); expect(screen.getByText("EURS")).toBeTruthy();
    expect(screen.getByText(/120 bps/)).toBeTruthy(); expect(screen.queryByText(/9025/)).toBeNull(); expect(screen.queryByText("PMUSD")).toBeNull();
    expect(screen.queryByText(/Unconfirmed|Near par/)).toBeNull();
  });

  it("publishes the filtered active count as the headline, not the render cap", () => {
    const { events, coins } = makeActiveFixtures(19);
    setEvents(events); setPeg({ coins }); render(<ActiveDepegsCard />);
    expect(screen.getByText("19")).toBeTruthy(); expect(screen.queryByText("4")).toBeNull();
    expect(screen.getByText("coins with open confirmed incidents")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Top 4 of 19 active depegs by materiality, then deviation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    screen.getByText("Top 4 of 19 by materiality, then deviation");
    expect(screen.getByText("C19")).toBeTruthy(); expect(screen.getByText("C16")).toBeTruthy(); expect(screen.queryByText("C15")).toBeNull();
  });

  it.each([["Observation unavailable", { currentDeviationBps: null }], ["Reference not yet updated", { priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg("stale-reference", null) }]] as const)("counts an open incident whose current reading is %s", (note, observation) => {
    setEvents([makeEvent({ stablecoinId: "eur-stasis", symbol: "EURS" })]);
    setPeg({ coins: [{ id: "eur-stasis", symbol: "EURS", pegCurrency: "EUR", activeDepeg: true, ...observation }] });
    render(<ActiveDepegsCard />);
    expect(screen.getByText("1")).toBeTruthy(); expect(screen.getByText(note)).toBeTruthy();
    expect(screen.getByText("coin with an open confirmed incident")).toBeTruthy(); expect(screen.queryByText("No open confirmed incidents")).toBeNull();
  });

  it("counts the complete summary beyond the first 100 event details", () => {
    const { events, coins } = makeActiveFixtures(120);
    setEvents(events.slice(0, 100)); setPeg({ coins }); render(<ActiveDepegsCard />);
    expect(screen.getByText("120")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Top 4 of 120 active depegs by materiality, then deviation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4); expect(screen.getByText("C120")).toBeTruthy();
    expect(within(list).getAllByText("Age unavailable")).toHaveLength(4);
  });

  it("says no open confirmed incidents at zero, not that every peg holds", () => {
    setEvents([]); setPeg({ coins: [{ id: "usdc-circle", symbol: "USDC", activeDepeg: false, currentDeviationBps: 0 }] });
    render(<ActiveDepegsCard />); expect(screen.getByText("No open confirmed incidents")).toBeTruthy();
  });

  it("names each row's recovery evidence on the viewer's minute clock, not query receipt time", () => {
    vi.useFakeTimers(); const now = 1_700_003_600; vi.setSystemTime(now * 1000);
    const atPar = { intervals: [], atParIntervals: [[now - 1_200, now - 1_200]] as Array<[number, number]>, lastObservationKind: "trusted-at-par" as const, lastTrustedObservationAt: now - 1_200, gapStartedAt: now - 1_200 };
    setEvents([{ ...makeEvent(), priceCoverage: atPar }]);
    setPeg({ coins: [{ id: "usdc-circle", symbol: "USDC", pegCurrency: "USD", activeDepeg: true, currentDeviationBps: -3 }], openIncidents: { "usdc-circle": { eventId: 1, startedAt: 1_700_000_000, escalatedAt: null, coverage: atPar } } }, { dataUpdatedAt: 1 });
    render(<ActiveDepegsCard />);
    expect(screen.getByText(", Recovery unconfirmed")).toBeTruthy(); expect(screen.getByText("Age unavailable")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByText(", Inside recovery band, awaiting confirmation")).toBeTruthy();
    expect(screen.getByRole("link", { name: /USDC/ }).getAttribute("title")).toBe("Inside recovery band, awaiting confirmation");
    expect(screen.getByText("1h")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(", Recovery unconfirmed")).toBeTruthy();
  });

  it("ranks rows by USD off peg with DDR call, cap and recency", () => {
    const now = 1_700_000_000 + 10 * 86_400; vi.useFakeTimers({ now: now * 1000 });
    setEvents([makeEvent({ id: 1, stablecoinId: "usdc-circle", symbol: "USDC", startedAt: now - 2 * 86_400 }), makeEvent({ id: 2, stablecoinId: "eur-stasis", symbol: "EURS", startedAt: now - 9 * 86_400 })]);
    setPeg({
      coins: [{ id: "eur-stasis", symbol: "EURS", pegCurrency: "EUR", activeDepeg: true, currentDeviationBps: -2000 }, { id: "usdc-circle", symbol: "USDC", pegCurrency: "USD", activeDepeg: true, currentDeviationBps: -100 }, { id: "fixture-coin-03", symbol: "C03", pegCurrency: "USD", activeDepeg: true, currentDeviationBps: -5000 }],
      openIncidents: { "usdc-circle": { eventId: 1, startedAt: now - 2 * 86_400, escalatedAt: null, coverage: null }, "eur-stasis": { eventId: 2, startedAt: now - 9 * 86_400, escalatedAt: null, coverage: null } },
    });
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [{ id: "eur-stasis", circulating: { peggedEUR: 10e6 } }, { id: "usdc-circle", circulating: { peggedUSD: 500e6 } }] } } as never);
    const ddrRow = (tier: string, eventState: string) => ({ kind: "prediction", stablecoinId: "usdc-circle", live: { eventState, currentEventId: 1 }, prediction: { state: "frozen", predictionMethodologyVersion: "v5.0" }, frozen: { resolution: { tier } } });
    useResolverMock.mockReturnValue({ resolver: { data: { _meta: { degraded: false }, rows: [ddrRow("at_risk", "active"), ddrRow("recovery_likely", "closed_pending_review")] } } } as never);
    render(<ActiveDepegsCard />); act(() => { vi.advanceTimersByTime(0); });
    const rows = within(screen.getByRole("list", { name: "Active depegs by materiality, then holder exposure" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent?.match(/USDC|EURS|C03/)?.[0])).toEqual(["USDC", "EURS", "C03"]);
    for (const text of ["New", "$500.0M mkt cap"]) within(rows[0]!).getByText(text);
    within(rows[0]!).getByTitle("Stress signals"); expect(within(rows[1]!).queryByText("New")).toBeNull();
    within(rows[2]!).getByText("Market cap unavailable");
  });

  it("keeps the incident count when event detail retrieval fails", () => {
    const { coins } = makeActiveFixtures(1);
    useActiveDepegEventsMock.mockReturnValue({ error: new Error("event details failed"), isLoading: false });
    setPeg({ coins }); render(<ActiveDepegsCard />);
    expect(screen.getByText("1")).toBeTruthy(); expect(screen.getByText("C01")).toBeTruthy(); expect(screen.getByText("Age unavailable")).toBeTruthy();
  });

  it("enforces -50.4 bps materiality, eventId DDR join, and recent/>30d split", async () => {
    const D = 86_400, now = 1_700_000_000 + 90 * D;
    const s = (eventId: number, d: number, e?: number) => ({ eventId, startedAt: now - d * D, escalatedAt: e ? now - e * D : null, coverage: null });
    const c = (id: string, symbol: string, bps: number, pegCurrency = "USD") => ({ id, symbol, pegCurrency, activeDepeg: true, currentDeviationBps: bps });
    const ddr = (currentEventId: number, tier: string) => ({ kind: "prediction", stablecoinId: "fixture-coin-03", live: { eventState: "active", currentEventId }, prediction: { state: "frozen", predictionMethodologyVersion: "v5.0" }, frozen: { resolution: { tier } } });
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [{ id: "usdc-circle", circulating: { peggedUSD: 500e6 } }, { id: "fixture-coin-03", circulating: { peggedUSD: 10e6 } }] } } as never);
    usePegSummaryMock.mockReturnValue({ isLoading: false, data: { coins: [c("usdc-circle", "USDC", -10), c("fixture-coin-03", "EDGE", -50.4), c("eur-stasis", "OLD", -900, "EUR")], openIncidents: { "usdc-circle": s(103, 2), "fixture-coin-03": s(102, 45, 2), "eur-stasis": s(104, 60) }, openIncidentsAsOfSec: now } });
    useResolverMock.mockReturnValue({ resolver: { data: { _meta: { degraded: false }, rows: [ddr(101, "recovery_unlikely")] } } } as never);
    const v = render(<ActiveDepegsCard />);
    expect(screen.getByText("2 recent · 1 >30d")).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "Recent active depegs by materiality, then holder exposure" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent?.match(/EDGE|USDC/)?.[0])).toEqual(["EDGE", "USDC"]);
    expect(rows[0]!.textContent).toMatch(/Escalating.*50 bps/);
    expect(rows[0]!.textContent).not.toMatch(/Near par|Terminal/);
    expect(rows[1]!.textContent).toContain("Near par");
    useResolverMock.mockReturnValue({ resolver: { data: { _meta: { degraded: false }, rows: [ddr(101, "recovery_unlikely"), ddr(102, "at_risk")] } } } as never);
    v.rerender(<ActiveDepegsCard />);
    within(screen.getAllByRole("listitem")[0]!).getByTitle("Stress signals");
    fireEvent.click(screen.getByRole("button", { name: ">30d (1)" }));
    expect(screen.getByText("OLD")).toBeTruthy();
    usePegSummaryMock.mockReturnValue({ isLoading: false, data: { coins: [c("eur-stasis", "OLD", -900, "EUR")], openIncidents: { "eur-stasis": s(104, 60) }, openIncidentsAsOfSec: now } });
    v.rerender(<ActiveDepegsCard />);
    expect(screen.getByText("No recent open incidents · 1 >30d by materiality, then deviation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recent (0)" }));
    expect(screen.getByText("No open incidents started in the last 30d or re-escalated in the last 7d")).toBeTruthy();
    v.unmount();

    // Unclicked auto-fallback returns to Recent when recentCount > 0; expired FX admission withholds bps ("Reference not yet updated", never "Near par"); boundary crossing triggers refetch.
    vi.useFakeTimers();
    const tFx = FX_REOPEN_QUOTE_AT + 7_141; // 1s past 7200s FX admission budget
    vi.setSystemTime(tFx * 1000);
    let resolveRefetch!: () => void;
    const refetch = vi.fn(() => new Promise<void>((res) => { resolveRefetch = res; }));
    const oldOnly = { coins: [c("eur-stasis", "OLD", -900, "EUR")], openIncidents: { "eur-stasis": { eventId: 104, startedAt: tFx - 60 * D, escalatedAt: null, coverage: null } }, openIncidentsAsOfSec: tFx };
    usePegSummaryMock.mockReturnValue({ isLoading: false, refetch, data: oldOnly });
    const v2 = render(<ActiveDepegsCard />);
    expect(screen.getByRole("button", { name: ">30d (1)" }).getAttribute("aria-pressed")).toBe("true");
    const fxExpired = { id: "eur-stasis", symbol: "EURS", pegCurrency: "EUR", activeDepeg: true, priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg("admitted", 25, FX_REOPEN_QUOTE_AT) };
    usePegSummaryMock.mockReturnValue({ isLoading: false, refetch, data: { coins: [fxExpired, c("usdc-circle", "USDC", -900)], openIncidents: { "eur-stasis": { eventId: 502, startedAt: tFx - 40 * D, escalatedAt: tFx - 7 * D + 30, coverage: null }, "usdc-circle": { eventId: 504, startedAt: tFx - 60 * D, escalatedAt: null, coverage: null } }, openIncidentsAsOfSec: tFx } });
    v2.rerender(<ActiveDepegsCard />);
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByRole("button", { name: "Recent (1)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Reference not yet updated")).toBeTruthy();
    expect(screen.queryByText("Near par")).toBeNull();
    // Crossing 502's 7d escalation window triggers refetch, holds pre-boundary state while in flight, fails closed when refetch settles with pre-boundary asOfSec (even under StrictMode), and restores split on post-boundary refresh.
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Recent (1)" })).toBeTruthy();
    await act(async () => { resolveRefetch(); });
    expect(screen.queryByRole("button", { name: />30d/ })).toBeNull();
    v2.unmount();

    const strictRefetch = vi.fn(() => Promise.resolve());
    usePegSummaryMock.mockReturnValue({ isLoading: false, refetch: strictRefetch, data: { coins: [fxExpired, c("usdc-circle", "USDC", -900)], openIncidents: { "eur-stasis": { eventId: 502, startedAt: tFx - 40 * D, escalatedAt: tFx - 7 * D + 30, coverage: null }, "usdc-circle": { eventId: 504, startedAt: tFx - 60 * D, escalatedAt: null, coverage: null } }, openIncidentsAsOfSec: tFx } });
    const v3 = render(<StrictMode><ActiveDepegsCard /></StrictMode>);
    await act(async () => { vi.advanceTimersByTime(0); await Promise.resolve(); });
    expect(strictRefetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Recent/ })).toBeNull();
    v3.unmount();
  });
});
