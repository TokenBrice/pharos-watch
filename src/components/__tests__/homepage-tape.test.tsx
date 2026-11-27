// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { TapeEvent } from "@shared/types/tape-event";
import { makeTapeEvent } from "@shared/test-utils/tape-event";

type LatestEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined;
  isLoading: boolean;
  error: Error | null;
  meta: null;
};

const useLatestEventsMock = vi.fn<() => LatestEventsResult>();
const useHomepageSnapshotMock = vi.fn<() => { data: unknown }>(() => ({ data: undefined }));
vi.mock("@/hooks/use-events", () => ({ useLatestEvents: () => useLatestEventsMock() }));
vi.mock("@/hooks/api-hooks", () => ({ useHomepageSnapshot: () => useHomepageSnapshotMock(), usePegSummary: () => ({ data: undefined }) }));
vi.mock("@/lib/logos", () => ({ logosById: {}, getLogoSrc: () => undefined }));

import { HomepageTape } from "@/components/homepage/homepage-tape";

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
beforeEach(() => { useHomepageSnapshotMock.mockReturnValue({ data: undefined }); useLatestEventsMock.mockReset(); mockLatestEvents(); });

function mockLatestEvents(overrides: Partial<LatestEventsResult> = {}) {
  useLatestEventsMock.mockReturnValue({ data: { events: [], nextCursor: null, total: null, totalExact: false }, isLoading: false, error: null, meta: null, ...overrides });
}
const mockEvents = (events: TapeEvent[]) => mockLatestEvents({ data: { events, nextCursor: null, total: null, totalExact: false } });
const dewsMove = (symbol: string, coinId: string, prevBand: string, newBand: string, severity: TapeEvent["severity"], ago: number, type: TapeEvent["type"] = "dews.escalated") =>
  makeTapeEvent({ id: `evt-${coinId}`, type, severity, ts: Date.now() - ago, coinId, title: `${symbol} DEWS ${prevBand} → ${newBand}`, payload: { prevBand, newBand }, sourceUrl: "/depeg/" });

describe("HomepageTape", () => {
  it("omits operational-only yield warnings and strips advisories from mixed ones", () => {
    const warning = (id: string, newSignals: string[]) => makeTapeEvent({ id, type: "yield.warning_emitted", coinId: "usde-ethena", severity: "warning", title: `USDe yield warning: ${newSignals.join(", ")}`, summary: "x", payload: { newSignals } });
    mockEvents([warning("only-aging", ["aging"]), warning("mixed", ["yield-spike", "data-stale"])]);
    render(<HomepageTape />);
    expect(screen.queryByText(/Aging observation|Data stale/)).toBeNull();
    expect(screen.getAllByText(/USDe yield warning: Yield spike/).length).toBeGreaterThan(0);
  });

  it("renders nothing when there are no events", () => {
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on endpoint error", () => {
    mockLatestEvents({ data: undefined, isLoading: false, error: new Error("fetch failed") });
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders depeg and freeze events with links and stablecoin logos, dropping score events", () => {
    mockEvents([
      makeTapeEvent({ id: "1747200000000-depeg-aaa11111", type: "depeg.opened", severity: "severe", title: "USDC depeg opened (-1200 bps)", sourceUrl: "/stablecoin/usdc-circle/#peg-history", coinId: "usdc-circle" }),
      makeTapeEvent({ id: "1747200000000-freeze-bbb22222", type: "freeze.funds.destroyed", severity: "critical", ts: Date.now() - 3_600_000, coinId: "usdt-tether", chain: "ethereum", title: "USDT $150.0M destroyed · Ethereum", sourceUrl: "/freezewatch/" }),
      makeTapeEvent({ id: "1747200000000-score-ccc33333", type: "score.grade.downgraded", severity: "warning", ts: Date.now() - 7_200_000, coinId: "usdt-tether", title: "USDT grade A -> B+", sourceUrl: "/stablecoin/usdt-tether/#report-card" }),
    ]);
    render(<HomepageTape />);
    expect(screen.getAllByText("USDC depeg opened (-1200 bps)")).toHaveLength(2);
    expect(screen.getAllByText(/USDT \$150\.0M destroyed/)).toHaveLength(2);
    expect(screen.queryByText("USDT grade A -> B+")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Severe" })).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: "Critical" })).toHaveLength(1);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdt-tether/#report-card"))).toBe(false);
    const allEventsLink = screen.getByRole("link", { name: "View all events" });
    expect(allEventsLink.getAttribute("href")).toMatch(/^\/timeline\/?$/);
    expect(allEventsLink.closest(".pharos-tape-track")).toBeNull();
    const cloneLinks = document.querySelectorAll('.pharos-tape-track a[aria-hidden="true"]');
    expect(cloneLinks.length).toBeGreaterThan(0);
    for (const clone of cloneLinks) expect(clone.getAttribute("tabindex")).toBe("-1");
  });

  it("collapses repeated same-coin same-type events into one cell with a count badge", () => {
    mockEvents([
      makeTapeEvent({ id: "evt-3", ts: Date.now() - 60_000, type: "depeg.peak_worsened", title: "USDXL depeg peak worsened (−112 bps)", coinId: "usdxl-last" }),
      makeTapeEvent({ id: "evt-2", ts: Date.now() - 600_000, type: "depeg.peak_worsened", title: "USDXL depeg peak worsened (−109 bps)", coinId: "usdxl-last" }),
      makeTapeEvent({ id: "evt-1", ts: Date.now() - 1_200_000, type: "depeg.peak_worsened", title: "USDXL depeg peak worsened (−104 bps)", coinId: "usdxl-last" }),
    ]);
    render(<HomepageTape />);
    expect(screen.getAllByText("USDXL depeg peak worsened (−112 bps)")).toHaveLength(2);
    expect(screen.queryByText("USDXL depeg peak worsened (−109 bps)")).toBeNull();
    expect(screen.queryByText("USDXL depeg peak worsened (−104 bps)")).toBeNull();
    expect(screen.getAllByText("×3")).toHaveLength(2);
    expect(screen.getAllByLabelText("3 similar events")).toHaveLength(1);
  });

  it("does not collapse different-class events for the same coin", () => {
    mockEvents([
      makeTapeEvent({ id: "evt-d", type: "depeg.opened", title: "USDT depeg opened (−110 bps)", coinId: "usdt-tether" }),
      makeTapeEvent({ id: "evt-f", type: "freeze.address.blocked", title: "USDT freeze blocked", coinId: "usdt-tether" }),
    ]);
    render(<HomepageTape />);
    expect(screen.getAllByText("USDT depeg opened (−110 bps)")).toHaveLength(2);
    expect(screen.getAllByText("USDT freeze blocked")).toHaveLength(2);
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  it("consolidates a DEWS sweep across coins into one cell that names its coins", () => {
    mockEvents([["FRAX", "frax-frax"], ["alUSD", "alusd-alchemix"], ["STBT", "stbt-matrixdock"], ["HBD", "hbd-hive"]]
      .map(([symbol, coinId], i) => dewsMove(symbol, coinId, "WATCH", "ALERT", "warning", 60_000 + 5_000 * i)));
    render(<HomepageTape />);
    expect(screen.getAllByText("DEWS WATCH → ALERT")).toHaveLength(2);
    expect(screen.queryByText("FRAX DEWS WATCH → ALERT")).toBeNull();
    expect(screen.getAllByText("FRAX, alUSD, STBT +1")).toHaveLength(2);
    expect(screen.queryByText(/×\d/)).toBeNull();
    expect(screen.getAllByRole("img", { name: "Warning" })).toHaveLength(1);
  });

  it("advances event ages on the viewer's minute clock between polls", () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-11-01T12:05:00.000Z");
    vi.setSystemTime(base);
    mockEvents([makeTapeEvent({ id: "evt-age", type: "freeze.address.blocked", title: "USDT freeze blocked", coinId: "usdt-tether", ts: base - 5 * 60_000 })]);
    render(<HomepageTape />);
    expect(screen.getAllByText("5m ago")).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(40 * 60_000); });
    expect(screen.getAllByText("45m ago")).toHaveLength(2);
    expect(screen.queryByText("5m ago")).toBeNull();
  });

  it("folds CALM ↔ WATCH churn out and pins recent warning-and-above events ahead of newer notices", () => {
    vi.useFakeTimers();
    mockEvents([
      makeTapeEvent({ id: "evt-freeze", type: "freeze.address.blocked", severity: "notice", title: "USDT freeze blocked", coinId: "usdt-tether" }),
      dewsMove("SDX", "sdx-stable", "CALM", "WATCH", "notice", 1_000),
      dewsMove("USDM", "usdm-mountain", "WATCH", "CALM", "info", 2_000, "dews.deescalated"),
      dewsMove("FRAX", "frax-frax", "WATCH", "ALERT", "warning", 3_000),
      dewsMove("alUSD", "alusd-alchemix", "ALERT", "WATCH", "notice", 4_000, "dews.deescalated"),
      makeTapeEvent({ id: "evt-old", type: "freeze.address.blocked", ts: Date.now() - 2 * 86_400_000, title: "Old USDT freeze", coinId: "usdt-tether" }),
    ]);
    render(<HomepageTape />);
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.queryByText(/CALM/)).toBeNull();
    expect(screen.getAllByText("FRAX DEWS WATCH → ALERT")).toHaveLength(2);
    expect(screen.getAllByText("alUSD DEWS ALERT → WATCH")).toHaveLength(2);
    expect(screen.getAllByRole("link")[0]?.textContent).toContain("FRAX DEWS WATCH → ALERT");
    expect(screen.getAllByRole("link")[1]?.textContent).toContain("USDT freeze blocked");
  });

  it("pins the live active-depeg count over the census", () => {
    mockEvents([makeTapeEvent({ id: "evt-f", type: "freeze.address.blocked", title: "USDT freeze blocked", coinId: "usdt-tether" })]);
    const { unmount } = render(<HomepageTape placement="top" />);
    screen.getByText("Chains");
    unmount();
    useHomepageSnapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 18 } } } });
    render(<HomepageTape placement="top" />);
    expect(screen.getByRole("link", { name: "18 active depegs" }).getAttribute("href")).toMatch(/^\/depeg/);
    expect(screen.queryByText("Chains")).toBeNull();
  });

  it("renders recent vs >30d split in top slot when >30d exists", () => {
    mockEvents([makeTapeEvent({ id: "e", type: "freeze.address.blocked", title: "USDT freeze", coinId: "usdt-tether" })]);
    useHomepageSnapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 17, recentActiveDepegCount: 4, longRunningActiveDepegCount: 13 } } } });
    const v = render(<HomepageTape placement="top" />);
    expect(screen.getByRole("link", { name: "17 active depegs: 4 recent, 13 long-running" }).textContent).toBe("4recent·13>30d");
    useHomepageSnapshotMock.mockReturnValue({ data: { incidents: { data: { activeDepegCount: 4, recentActiveDepegCount: 4, longRunningActiveDepegCount: 0 } } } });
    v.rerender(<HomepageTape placement="top" />);
    expect(screen.getByRole("link", { name: "4 active depegs" })).toBeTruthy();
  });
});
