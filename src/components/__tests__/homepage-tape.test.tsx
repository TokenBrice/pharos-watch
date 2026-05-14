// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RecentEventsResponse } from "@shared/types/tape";

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
});

describe("HomepageTape", () => {
  it("renders nothing when there are no events", () => {
    useRecentEventsMock.mockReturnValue({
      data: { events: [] },
      isLoading: false,
      error: null,
    });
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on error", () => {
    useRecentEventsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("fetch failed"),
    });
    const { container } = render(<HomepageTape />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a loading state when the hook is loading", () => {
    useRecentEventsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<HomepageTape />);
    expect(screen.getByText(/loading recent events/i)).toBeTruthy();
  });

  it("renders each event with a link to its source and a severity label", () => {
    useRecentEventsMock.mockReturnValue({
      data: {
        events: [
          {
            id: "depeg.opened:1",
            type: "depeg.opened",
            severity: "severe",
            ts: Math.floor(Date.now() / 1000) - 120,
            stablecoinId: "usdc-circle",
            symbol: "USDC",
            title: "USDC depeg opened (−1200 bps)",
            href: "/stablecoin/usdc-circle/#peg-history",
          },
          {
            id: "freeze.destroyed:eth-0xabc",
            type: "freeze.destroyed",
            severity: "critical",
            ts: Math.floor(Date.now() / 1000) - 3600,
            stablecoinId: null,
            symbol: "USDT",
            title: "USDT $15.0M destroyed · Ethereum",
            href: "/freezewatch/",
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<HomepageTape />);
    // Items are duplicated for the scrolling loop; expect 2 occurrences per event.
    expect(screen.getAllByText("USDC depeg opened (−1200 bps)")).toHaveLength(2);
    expect(screen.getAllByText(/USDT \$15\.0M destroyed/)).toHaveLength(2);
    // Severity dots carry an accessible label for each tier.
    expect(screen.getAllByLabelText("Severe").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Critical").length).toBeGreaterThan(0);
    // Source links are present.
    const links = screen.getAllByRole("link");
    const hrefs = links.map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
  });

  it("applies the pause-on-hover shell class on the outer wrapper", () => {
    useRecentEventsMock.mockReturnValue({
      data: {
        events: [
          {
            id: "depeg.opened:1",
            type: "depeg.opened",
            severity: "warning",
            ts: Math.floor(Date.now() / 1000),
            stablecoinId: "usdc-circle",
            symbol: "USDC",
            title: "USDC depeg opened (−500 bps)",
            href: "/stablecoin/usdc-circle/#peg-history",
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    const { container } = render(<HomepageTape />);
    const root = container.querySelector(".pharos-tape-shell");
    expect(root).toBeTruthy();
    expect(container.querySelector(".pharos-tape-track")).toBeTruthy();
  });
});
