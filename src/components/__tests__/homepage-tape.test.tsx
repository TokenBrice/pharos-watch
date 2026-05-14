// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RecentEvent, RecentEventsResponse } from "@shared/types/tape";

type UseRecentEventsResult = {
  data: RecentEventsResponse | undefined;
  isLoading: boolean;
  error: Error | null;
};

const useRecentEventsMock = vi.fn<() => UseRecentEventsResult>();

vi.mock("@/hooks/api-hooks", () => ({
  useRecentEvents: () => useRecentEventsMock(),
}));

import { HomepageTape } from "@/components/homepage-tape";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useRecentEventsMock.mockReset();
  mockRecentEvents();
});

function makeRecentEvent(overrides: Partial<RecentEvent> = {}): RecentEvent {
  return {
    id: "depeg.opened:1",
    type: "depeg.opened",
    severity: "warning",
    ts: Math.floor(Date.now() / 1000) - 120,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    title: "USDC depeg opened (-500 bps)",
    href: "/stablecoin/usdc-circle/#peg-history",
    ...overrides,
  };
}

function mockRecentEvents(overrides: Partial<UseRecentEventsResult> = {}) {
  useRecentEventsMock.mockReturnValue({
    data: { events: [] },
    isLoading: false,
    error: null,
    ...overrides,
  });
}

describe("HomepageTape", () => {
  it("renders nothing when there are no events", () => {
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on endpoint error", () => {
    mockRecentEvents({
      data: undefined,
      isLoading: false,
      error: new Error("fetch failed"),
    });
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a loading state when the hook is loading", () => {
    mockRecentEvents({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<HomepageTape />);
    expect(screen.getByText(/loading recent events/i)).toBeTruthy();
  });

  it("renders depeg, freeze, and score events with links and stablecoin logos", () => {
    mockRecentEvents({
      data: {
        events: [
          makeRecentEvent({
            id: "depeg.opened:1",
            type: "depeg.opened",
            severity: "severe",
            title: "USDC depeg opened (-1200 bps)",
            href: "/stablecoin/usdc-circle/#peg-history",
          }),
          makeRecentEvent({
            id: "freeze.destroyed:eth-0xabc",
            type: "freeze.destroyed",
            severity: "critical",
            ts: Math.floor(Date.now() / 1000) - 3600,
            stablecoinId: null,
            symbol: "USDT",
            title: "USDT $150.0M destroyed · Ethereum",
            href: "/freezewatch/",
          }),
          makeRecentEvent({
            id: "score.downgraded:usdt-tether:1747400000",
            type: "score.downgraded",
            severity: "warning",
            ts: Math.floor(Date.now() / 1000) - 7200,
            stablecoinId: "usdt-tether",
            symbol: "USDT",
            title: "USDT grade A -> B+",
            href: "/stablecoin/usdt-tether/#report-card",
          }),
        ],
      },
    });

    render(<HomepageTape />);

    // Items are duplicated for the scrolling loop; expect 2 occurrences per event.
    expect(screen.getAllByText("USDC depeg opened (-1200 bps)")).toHaveLength(2);
    expect(screen.getAllByText(/USDT \$150\.0M destroyed/)).toHaveLength(2);
    expect(screen.getAllByText("USDT grade A -> B+")).toHaveLength(2);
    // Events use stablecoin logos, including freeze events that resolve a logo from a unique symbol.
    expect(screen.getAllByAltText("USDC logo")).toHaveLength(2);
    expect(screen.getAllByAltText("USDT logo")).toHaveLength(4);
    // Source links are present.
    const links = screen.getAllByRole("link");
    const hrefs = links.map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdt-tether"))).toBe(true);
  });

  it("keeps a severity dot fallback when an event is not tied to a stablecoin", () => {
    mockRecentEvents({
      data: {
        events: [
          makeRecentEvent({
            stablecoinId: null,
            symbol: null,
            severity: "notice",
            title: "General market event",
            href: "/",
          }),
        ],
      },
    });

    render(<HomepageTape />);

    expect(screen.getAllByLabelText("Notice")).toHaveLength(2);
  });

  it("labels the strip as Events", () => {
    mockRecentEvents({ data: { events: [makeRecentEvent()] } });

    render(<HomepageTape />);

    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.queryByText("Live Tape")).toBeNull();
  });

  it("applies the pause-on-hover shell class on the outer wrapper", () => {
    mockRecentEvents({ data: { events: [makeRecentEvent()] } });

    const { container } = render(<HomepageTape />);
    const root = container.querySelector(".pharos-tape-shell");
    expect(root).toBeTruthy();
    expect(container.querySelector(".pharos-tape-track")).toBeTruthy();
  });

  it("can render as the full-width top strip", () => {
    mockRecentEvents({ data: { events: [makeRecentEvent()] } });

    const { container } = render(<HomepageTape placement="top" />);
    const root = container.querySelector(".pharos-tape-shell");
    expect(root?.className).toContain("w-full");
    expect(root?.className).toContain("border-b");
    expect(root?.className).toContain("md:ml-[var(--pharos-homepage-tape-offset)]");
    expect(root?.className).not.toContain("-mx-3");
  });
});
