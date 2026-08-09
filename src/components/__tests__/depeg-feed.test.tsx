// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DepegFeed } from "@/components/depeg-feed";
import { installMatchMediaMock } from "@/test-utils/frontend";
import type { DepegEvent } from "@shared/types";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

beforeEach(() => {
  installMatchMediaMock(true);
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
    closeReason: null,
    provenance: null,
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

  it("reflects the current events set after the feed updates (seen-id scope follows events)", () => {
    const { rerender } = render(
      <DepegFeed events={[makeEvent({ id: 1, symbol: "ALPHA" })]} />,
    );
    expect(screen.getByText("ALPHA")).toBeTruthy();

    act(() => {
      rerender(<DepegFeed events={[makeEvent({ id: 2, symbol: "BETA" })]} />);
    });

    expect(screen.getByText("BETA")).toBeTruthy();
    expect(screen.queryByText("ALPHA")).toBeNull();
  });
});
