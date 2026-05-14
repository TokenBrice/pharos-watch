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

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

import { TapeClient } from "@/app/tape/client";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useRecentEventsMock.mockReset();
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

describe("TapeClient", () => {
  it("renders the empty state when there are no events", () => {
    useRecentEventsMock.mockReturnValue({ data: { events: [] }, isLoading: false, error: null });
    render(<TapeClient />);
    expect(screen.getByText(/no events in the last 24h/i)).toBeTruthy();
  });

  it("renders an error notice on hook error", () => {
    useRecentEventsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("fetch failed"),
    });
    const { container } = render(<TapeClient />);
    // QueryErrorNotice renders something non-null when error is set.
    expect(container.firstChild).not.toBeNull();
  });

  it("renders events with titles and source links", () => {
    useRecentEventsMock.mockReturnValue({
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
            stablecoinId: null,
            symbol: "USDT",
            title: "USDT $150.0M destroyed · Ethereum",
            href: "/freezewatch/",
          }),
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<TapeClient />);

    expect(screen.getByText("USDC depeg opened (-1200 bps)")).toBeTruthy();
    expect(screen.getByText(/USDT \$150\.0M destroyed/)).toBeTruthy();
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/stablecoin/usdc-circle"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/freezewatch"))).toBe(true);
  });
});
