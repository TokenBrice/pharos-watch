// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeMarketStateLine } from "@/components/home-market-state-line";

const { usePegSummaryMock, useStabilityIndexMock } = vi.hoisted(() => ({
  usePegSummaryMock: vi.fn(),
  useStabilityIndexMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: usePegSummaryMock,
  useStabilityIndex: useStabilityIndexMock,
}));

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

vi.mock("@/lib/stablecoin-static-data", () => ({
  ACTIVE_STABLECOIN_ID_SET: new Set(["usdc-circle", "pmusd-piedmont"]),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function freshMeta() {
  return { updatedAt: Math.floor(Date.now() / 1000), ageSeconds: 0, status: "fresh" };
}

describe("HomeMarketStateLine", () => {
  it("states the PSI band and the /depeg/ hero's confirmed-depeg count with rail links", () => {
    useStabilityIndexMock.mockReturnValue({
      data: { current: { score: 91.2, band: "BEDROCK", avg24h: 91.9, avg24hBand: "BEDROCK", computedAt: Math.floor(Date.now() / 1000) } },
      dataUpdatedAt: Date.now(),
      meta: freshMeta(),
      error: null,
      isLoading: false,
    });
    usePegSummaryMock.mockReturnValue({
      data: {
        coins: [
          { id: "usdc-circle", activeDepeg: false },
          { id: "pmusd-piedmont", activeDepeg: true },
          { id: "retired-coin", activeDepeg: true },
        ],
        // The peg summary's own (non-NAV) count is the authority, as on /depeg/.
        summary: { activeDepegCount: 1 },
      },
      dataUpdatedAt: Date.now(),
      meta: freshMeta(),
      error: null,
      isLoading: false,
    });

    render(<HomeMarketStateLine />);
    const psiLink = screen.getByRole("link", { name: /PSI/ });
    expect(psiLink.getAttribute("href")).toMatch(/^\/stability-index\/?$/);
    expect(psiLink.textContent).toContain("Bedrock");
    expect(psiLink.textContent).toContain("91.9");
    const depegLink = screen.getByRole("link", { name: /active depeg/ });
    expect(depegLink.getAttribute("href")).toMatch(/^\/depeg\/?$/);
    expect(depegLink.textContent).toContain("1active depeg");
  });

  it("does not present a retained PSI sample in a fresh response as current", () => {
    useStabilityIndexMock.mockReturnValue({
      data: { current: { score: 91.2, band: "BEDROCK", computedAt: Math.floor(Date.now() / 1000) - 7 * 86_400 } },
      dataUpdatedAt: Date.now(),
      meta: freshMeta(),
      error: null,
      isLoading: false,
    });
    usePegSummaryMock.mockReturnValue({ data: undefined, dataUpdatedAt: 0, meta: undefined, error: null, isLoading: true });

    render(<HomeMarketStateLine />);
    const psiLink = screen.getByRole("link", { name: /PSI/ });
    const band = screen.getByText("Bedrock");
    expect(band.className).toContain("text-foreground");
    expect(band.className).not.toContain("text-green");
    expect(psiLink.textContent).toMatch(/\((stale|degraded|unavailable|error)\)/);
  });

  it("says unavailable instead of reading a failed source as calm", () => {
    useStabilityIndexMock.mockReturnValue({ data: undefined, dataUpdatedAt: 0, meta: undefined, error: new Error("x"), isLoading: false });
    usePegSummaryMock.mockReturnValue({ data: undefined, dataUpdatedAt: 0, meta: undefined, error: new Error("x"), isLoading: false });

    render(<HomeMarketStateLine />);
    expect(screen.getByRole("link", { name: /PSI/ }).textContent).toContain("unavailable");
    expect(screen.getByRole("link", { name: /Active depegs/ }).textContent).toContain("unavailable");
    expect(screen.queryByText("0")).toBeNull();
  });
});
