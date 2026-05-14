// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegFeed } from "@/components/depeg-feed";
import type { DepegEvent } from "@shared/types";
import type { ReactNode } from "react";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(cleanup);

function makeEvent(overrides: Partial<DepegEvent>): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -150,
    startedAt: 1_700_000_000,
    endedAt: 1_700_001_000,
    startPrice: 0.99,
    peakPrice: 0.985,
    recoveryPrice: 1,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    ...overrides,
  };
}

describe("DepegFeed", () => {
  it("renders ongoing incidents before newer closed events", () => {
    render(
      <DepegFeed
        events={[
          makeEvent({ id: 1, symbol: "NEW", startedAt: 1_700_100_000, endedAt: 1_700_101_000 }),
          makeEvent({ id: 2, symbol: "OLD", startedAt: 1_700_000_000, endedAt: null }),
        ]}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links[0].textContent).toContain("OLD");
    expect(links[0].textContent).toContain("LIVE");
  });

  it("renders an all-clear message when no events exist", () => {
    render(<DepegFeed events={[]} emptyMessage="No confirmed active depeg incidents." />);

    expect(screen.getByText("No confirmed active depeg incidents.")).toBeTruthy();
  });
});
