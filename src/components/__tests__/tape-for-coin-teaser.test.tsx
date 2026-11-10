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

import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";

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

  it("condenses low-band reversals so older stories become visible", () => {
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
    expect(links.map((link) => link.getAttribute("href")?.split("event=")[1])).toEqual(["r5", "m1"]);

    expect(screen.getByText("DEWS CALM/WATCH changes")).toBeTruthy();
    expect(screen.getByText("In the latest 6 events: CALM → WATCH 3 · WATCH → CALM 2")).toBeTruthy();
    expect(screen.getByText("Most recent: CALM → WATCH")).toBeTruthy();
    const groupTime = links[0]!.querySelector("time")!;
    expect(groupTime.getAttribute("dateTime")).toBe("2026-10-26T12:00:00.000Z");
    expect(groupTime.getAttribute("title")).toBe("Between 2026-10-25 12:00 and 2026-10-26 12:00 UTC");
    expect(screen.queryByText("Escalated")).toBeNull();
    expect(screen.queryByText("Deescalated")).toBeNull();
    expect(screen.getByText("Minted")).toBeTruthy();
  });

  it("keeps ordinary rendering for a single low-band change", () => {
    mockEvents([lowBand("r1", false, NOW - 60_000)]);
    render(<TapeForCoinTeaser coinId="usde-ethena" />);
    expect(screen.getByText("Deescalated")).toBeTruthy();
    expect(screen.queryByText("DEWS CALM/WATCH changes")).toBeNull();
  });

  it("caps at five logical entries", () => {
    mockEvents(Array.from({ length: 8 }, (_, i) => other(`m${i}`, NOW - i * 60_000)));
    render(<TapeForCoinTeaser coinId="usde-ethena" />);
    expect(screen.getAllByText("Minted")).toHaveLength(5);
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
    expect(screen.getByText("Loading recent events…")).toBeTruthy();
    unmount();

    mockEvents([]);
    const { container } = render(<TapeForCoinTeaser coinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the timeline link keyboard focusable", () => {
    mockEvents([other("m1", NOW)]);
    render(<TapeForCoinTeaser coinId="usde-ethena" />);
    const timeline = screen.getByRole("link", { name: "View all events on the timeline" });
    timeline.focus();
    expect(document.activeElement).toBe(timeline);
    expect(timeline.getAttribute("href")).toMatch(/^\/timeline\/?\?coin=usde-ethena$/);
  });
});
