// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TapeEvent } from "@shared/types/tape-event";
import { makeTapeEvent } from "@shared/test-utils/tape-event";

type LatestEventsResult = {
  data: { events: TapeEvent[]; nextCursor: string | null; total: number | null; totalExact: boolean } | undefined;
  dataUpdatedAt: number;
  isLoading: boolean;
};

const useLatestEventsMock = vi.fn<(options: unknown) => LatestEventsResult>();

vi.mock("@/hooks/use-events", () => ({
  useLatestEvents: (options: unknown) => useLatestEventsMock(options),
}));

import { TapeForCoinTeaser } from "@/components/tape/tape-for-coin-teaser";

const NOW = Date.UTC(2026, 9, 26, 18, 0);

function mockEvents(events: TapeEvent[], overrides: Partial<LatestEventsResult> = {}) {
  useLatestEventsMock.mockReturnValue({
    data: { events, nextCursor: null, total: null, totalExact: false },
    dataUpdatedAt: NOW,
    isLoading: false,
    ...overrides,
  });
}

function lowBand(id: string, up: boolean, ts: number): TapeEvent {
  return makeTapeEvent({
    id,
    ts,
    type: up ? "dews.escalated" : "dews.deescalated",
    severity: up ? "warning" : "info",
    coinId: "usde-ethena",
    transition: "updated",
    title: up ? "USDe DEWS CALM → WATCH" : "USDe DEWS WATCH → CALM",
    summary: up ? "DEWS threat band escalated from CALM to WATCH." : "DEWS threat band de-escalated from WATCH to CALM.",
    payload: up ? { prevBand: "CALM", newBand: "WATCH" } : { prevBand: "WATCH", newBand: "CALM" },
    sourceUrl: null,
  });
}

function other(id: string, ts: number): TapeEvent {
  return makeTapeEvent({
    id,
    ts,
    type: "mint_burn.large_mint",
    severity: "info",
    coinId: "usde-ethena",
    transition: "updated",
    summary: "Large mint observed.",
    sourceUrl: null,
  });
}

afterEach(() => {
  useLatestEventsMock.mockReset();
  vi.useRealTimers();
});

describe("TapeForCoinTeaser", () => {
  it("requests one bounded 100-event page for the coin", () => {
    mockEvents([]);
    render(<TapeForCoinTeaser coinId="usde-ethena" />);
    expect(useLatestEventsMock).toHaveBeenCalledWith({ coin: "usde-ethena", limit: 100 });
  });

  it("folds routine Calm/Watch flips into one scoped line so older stories become visible", () => {
    const hour = 3_600_000;
    const newest = Date.UTC(2026, 9, 26, 12, 0);
    mockEvents([
      lowBand("r5", true, newest),
      lowBand("r4", false, newest - hour),
      lowBand("r3", true, newest - 2 * hour),
      lowBand("r2", false, newest - 3 * hour),
      lowBand("r1", true, Date.UTC(2026, 9, 25, 12, 0)),
      other("m1", Date.UTC(2026, 9, 24, 12, 0)),
    ]);
    render(<TapeForCoinTeaser coinId="usde-ethena" />);

    const links = screen.getAllByRole("link").filter((link) => /^\/timeline\/?\?event=/.test(link.getAttribute("href") ?? ""));
    expect(links.map((link) => link.getAttribute("href")?.split("event=")[1])).toEqual(["m1"]);
    expect(screen.getByText("Also 5 routine early-warning changes between Calm and Watch in the latest 6 events.")).toBeTruthy();
    expect(screen.queryByText(/CALM|WATCH/)).toBeNull();
    expect(screen.getByText("Large mint")).toBeTruthy();
  });

  it("collapses a page of only routine flips to one muted line", () => {
    mockEvents([lowBand("r1", false, NOW - 60_000)]);
    render(<TapeForCoinTeaser coinId="usde-ethena" />);
    expect(screen.getByText("No notable activity in the latest 1 event.")).toBeTruthy();
    expect(screen.getByText("1 routine early-warning change between Calm and Watch in the latest 1 event.")).toBeTruthy();
  });

  it("caps at four logical entries", () => {
    mockEvents(Array.from({ length: 8 }, (_, i) => other(`m${i}`, NOW - i * 86_400_000)));
    render(<TapeForCoinTeaser coinId="usde-ethena" />);
    expect(screen.getAllByText("Large mint")).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Recent activity" })).toBeTruthy();
  });

  it("groups same-day mints and burns with totals and keeps routine flows informational", () => {
    const flow = (id: string, direction: "mint" | "burn", amountUsd: number, ts: number) => makeTapeEvent({
      id, ts, type: direction === "mint" ? "mint_burn.large_mint" : "mint_burn.large_burn", severity: "warning",
      coinId: "usdc-circle", transition: "updated", sourceUrl: null, payload: { direction, amountUsd },
      title: `USDC ${direction}ed`, summary: `Single ${direction} transaction.`,
    });
    const day = Date.UTC(2026, 9, 26, 12, 0);
    // Two identical-looking $15.0M burns are distinct transactions, so both count.
    mockEvents([
      flow("f1", "mint", 20_000_000, day),
      flow("f2", "burn", 15_000_000, day - 60_000),
      flow("f3", "burn", 15_000_000, day - 120_000),
      flow("f4", "mint", 10_000_000, day - 86_400_000),
    ]);
    const { container } = render(<TapeForCoinTeaser coinId="usdc-circle" supplyUsd={75_000_000_000} />);
    expect(screen.getByText("Large mints & burns")).toBeTruthy();
    expect(screen.getByText("1 mint · $20.0M · 2 burns · $30.0M")).toBeTruthy();
    expect(screen.getByText("Net \u2212$10.0M")).toBeTruthy();
    expect(container.querySelectorAll('[data-activity-kind="flows"]')).toHaveLength(2);
    expect(screen.queryByText("Warning")).toBeNull();
    expect(screen.queryByText("Notice")).toBeNull();
  });

  it("reads the oldest group on a full page as a floor", () => {
    const flows = Array.from({ length: 100 }, (_, i) => makeTapeEvent({
      id: `f${i}`, ts: NOW - i * 60_000, type: "mint_burn.large_burn", severity: "info", coinId: "usdc-circle",
      transition: "updated", sourceUrl: null, payload: { direction: "burn", amountUsd: 1_000_000 },
    }));
    mockEvents(flows);
    render(<TapeForCoinTeaser coinId="usdc-circle" />);
    expect(screen.getByText("≥100 burns · ≥$100.0M")).toBeTruthy();
  });

  it("marks a flow material at 1% of supply, or $100M when supply is unknown", () => {
    const big = makeTapeEvent({
      id: "big", ts: NOW, type: "mint_burn.large_mint", severity: "info", coinId: "usdc-circle",
      transition: "updated", sourceUrl: null, payload: { direction: "mint", amountUsd: 150_000_000 },
    });
    mockEvents([big]);
    const { unmount } = render(<TapeForCoinTeaser coinId="usdc-circle" />);
    expect(screen.getByText("Notice")).toBeTruthy();
    unmount();
    render(<TapeForCoinTeaser coinId="usdc-circle" supplyUsd={75_000_000_000} />);
    expect(screen.queryByText("Notice")).toBeNull();
  });

  it("pairs a depeg's open and resolution into one neutral history entry; an open one warns", () => {
    const depeg = (id: string, type: string, ts: number, rowId: string, payload: Record<string, unknown>) => makeTapeEvent({
      id, ts, type, severity: type === "depeg.resolved" ? "info" : "notice", coinId: "xaut-tether",
      sourceTable: "depeg_events", sourceRowId: rowId, sourceUrl: null, summary: "Trading below peg.",
      transition: type === "depeg.resolved" ? "resolved" : "opened", payload,
    });
    const start = Date.UTC(2026, 10, 14, 7, 0) / 1000;
    mockEvents([
      depeg("open2", "depeg.opened", NOW, "2", { direction: "below", absDeviationBps: 120 }),
      depeg("res1", "depeg.resolved", Date.UTC(2026, 10, 14, 18, 15), "1",
        { direction: "below", absDeviationBps: 241, startedAt: start, endedAt: start + 11 * 3_600 + 15 * 60 }),
      depeg("open1", "depeg.opened", Date.UTC(2026, 10, 14, 7, 0), "1", { direction: "below", absDeviationBps: 241 }),
    ]);
    const { container } = render(<TapeForCoinTeaser coinId="xaut-tether" />);
    expect(container.querySelectorAll('[data-activity-kind="depeg"]')).toHaveLength(2);
    expect(screen.getByText("Depeg open")).toBeTruthy();
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("Depeg resolved")).toBeTruthy();
    expect(screen.getByText("Below peg for 11h 15m, now back within range.")).toBeTruthy();
    const peak = screen.getByText("Peak \u2212241 bps");
    expect(peak.className).toContain("text-muted-foreground");
  });

  it("lists a week-long run of one event type once, at its highest severity", () => {
    const drop = (id: string, ts: number, severity: "notice" | "warning", prevScore: number, newScore: number) => makeTapeEvent({
      id, ts, type: "yield.pys_dropped", severity, coinId: "zchf-frankencoin", transition: "updated", sourceUrl: null,
      title: `ZCHF yield score ${prevScore} → ${newScore}`, summary: "Published yield score dropped.",
      payload: { prevScore, newScore },
    });
    mockEvents([
      drop("y3", NOW, "notice", 53, 43),
      lowBand("r1", true, NOW - 3_600_000),
      drop("y2", NOW - 7_200_000, "warning", 82, 53),
      drop("y1", NOW - 10 * 86_400_000, "notice", 81, 62),
    ]);
    render(<TapeForCoinTeaser coinId="zchf-frankencoin" />);
    // The 10-day-old drop starts its own entry; a run never stands for more than a week.
    expect(screen.getAllByText("Yield score dropped")).toHaveLength(2);
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("2 events · latest 53 → 43 · -10")).toBeTruthy();
  });

  it.each([
    ["a restored background tab", Date.UTC(2026, 10, 2, 9, 0), Date.UTC(2026, 10, 1, 22, 0), Date.UTC(2026, 10, 1, 22, 30)],
    ["the UTC midnight boundary", Date.UTC(2026, 10, 2, 0, 30), Date.UTC(2026, 10, 1, 23, 0), Date.UTC(2026, 10, 1, 23, 40)],
  ])("labels event days from the wall clock after %s", (_case, now, eventTs, dataUpdatedAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockEvents([other("m1", eventTs)], { dataUpdatedAt });

    render(<TapeForCoinTeaser coinId="usde-ethena" />);

    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.queryByText("Today")).toBeNull();
  });

  it("falls back to the absolute UTC date before the visitor clock is available", () => {
    mockEvents([other("m1", Date.UTC(2026, 10, 1, 22, 0))]);

    const html = renderToStaticMarkup(<TapeForCoinTeaser coinId="usde-ethena" />);

    expect(html).toContain("1 Nov");
    expect(html).not.toContain("Today");
  });

  it("shows loading and renders nothing when empty", () => {
    mockEvents([], { data: undefined, isLoading: true });
    const { unmount } = render(<TapeForCoinTeaser coinId="usde-ethena" />);
    // A skeleton, not a sentence; the status keeps it announced.
    expect(screen.getByRole("status", { name: "Loading recent events" })).toBeTruthy();
    expect(screen.queryByText("Loading recent events…")).toBeNull();
    unmount();

    mockEvents([]);
    const { container } = render(<TapeForCoinTeaser coinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the timeline link keyboard focusable", () => {
    mockEvents([other("m1", NOW)]);
    render(<TapeForCoinTeaser coinId="usde-ethena" />);
    const timeline = screen.getByRole("link", { name: "View all events on the timeline" });
    expect(timeline.tabIndex).toBe(0);
    timeline.focus();
    expect(document.activeElement).toBe(timeline);
    expect(timeline.getAttribute("href")).toMatch(/^\/timeline\/?\?coin=usde-ethena$/);
  });
});
