// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@/lib/api", () => ({
  fetchStablecoinReserves: vi.fn(),
}));

import { useStablecoinReserves } from "../use-stablecoin-reserves";

describe("useStablecoinReserves", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
  });

  it("maps the reserve payload into the public reserveResult shape", () => {
    useQueryMock.mockReturnValue({
      data: {
        reserves: [{ name: "T-Bills", pct: 100, risk: "very-low" }],
        estimated: false,
        mode: "live",
        liveAt: 1_700_000_000,
        source: "adapter",
        displayUrl: "https://example.com",
        displayBadge: { kind: "live", label: "Live" },
        metadata: { yieldBasisCollateralPct: 89.7 },
        provenance: { method: "api" },
        sync: { lastSuccessfulSyncAt: 1_700_000_000 },
      },
      error: null,
    });

    const { result } = renderHook(() => useStablecoinReserves("usdc-circle", true));

    expect(result.current.reserveResult).toMatchObject({
      reserves: [{ name: "T-Bills", pct: 100, risk: "very-low" }],
      mode: "live",
      source: "adapter",
      displayUrl: "https://example.com",
      displayBadge: { kind: "live", label: "Live" },
      metadata: { yieldBasisCollateralPct: 89.7 },
    });
    expect(result.current.error).toBeNull();
  });

  it("uses long polling for live reserve responses and short polling for fallback responses", () => {
    useQueryMock.mockReturnValue({ data: null, error: null });

    renderHook(() => useStablecoinReserves("usdc-circle", true));
    const options = useQueryMock.mock.calls[0][0] as {
      staleTime: (query: { state: { data?: { mode: string } | null } }) => number;
      refetchInterval: (query: { state: { data?: { mode: string } | null } }) => number;
      enabled: boolean;
      retry: number;
    };

    expect(options.enabled).toBe(true);
    expect(options.retry).toBe(1);
    expect(options.staleTime({ state: { data: { mode: "live" } } })).toBe(60 * 60 * 1000);
    expect(options.refetchInterval({ state: { data: { mode: "live" } } })).toBe(2 * 60 * 60 * 1000);
    expect(options.staleTime({ state: { data: { mode: "fallback" } } })).toBe(60 * 1000);
    expect(options.refetchInterval({ state: { data: { mode: "fallback" } } })).toBe(2 * 60 * 1000);
  });
});
