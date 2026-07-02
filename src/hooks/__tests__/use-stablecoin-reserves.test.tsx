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

import { fetchStablecoinReserves } from "@/lib/api";
import { useStablecoinReserves, toReserveResult } from "../use-stablecoin-reserves";

describe("useStablecoinReserves", () => {
  const fetchStablecoinReservesMock = vi.mocked(fetchStablecoinReserves);

  beforeEach(() => {
    useQueryMock.mockReset();
    fetchStablecoinReservesMock.mockReset();
  });

  it("maps the reserve payload into the public reserveResult shape", () => {
    const refetch = vi.fn().mockResolvedValue({ status: "success" });
    useQueryMock.mockReturnValue({
      data: {
        stablecoinId: "usdc-circle",
        reserves: [{ name: "T-Bills", pct: 100, risk: "very-low" }],
        estimated: false,
        mode: "live",
        liveAt: 1_700_000_000,
        source: "adapter",
        displayUrl: "https://example.com",
        evidenceUrls: ["https://example.com/evidence"],
        displayBadge: { kind: "live", label: "Live" },
        metadata: { yieldBasisCollateralPct: 89.7 },
        provenance: {
          evidenceClass: "independent",
          sourceModel: "dynamic-mix",
          scoringEligible: true,
        },
        sync: {
          enabled: true,
          status: "ok",
          stale: false,
          bootstrap: false,
          lastSuccessAt: 1_700_000_000,
        },
      },
      error: null,
      refetch,
      isFetching: true,
    });

    const { result } = renderHook(() => useStablecoinReserves("usdc-circle", true));

    expect(result.current.reserveResult).toMatchObject({
      reserves: [{ name: "T-Bills", pct: 100, risk: "very-low" }],
      mode: "live",
      source: "adapter",
      displayUrl: "https://example.com",
      evidenceUrls: ["https://example.com/evidence"],
      displayBadge: { kind: "live", label: "Live" },
      metadata: { yieldBasisCollateralPct: 89.7 },
    });
    expect(result.current.reserveResult).not.toHaveProperty("stablecoinId");
    expect(result.current.error).toBeNull();
    expect(result.current.refetch).toBe(refetch);
    expect(result.current.isFetching).toBe(true);
  });

  it("projects reserve API responses from the shared endpoint shape", () => {
    const result = toReserveResult({
      stablecoinId: "usdc-circle",
      reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      estimated: false,
      mode: "curated-fallback",
    });

    expect(result).toEqual({
      reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      estimated: false,
      mode: "curated-fallback",
    });
  });

  it("uses long polling for live reserve responses and short polling for fallback responses", () => {
    useQueryMock.mockReturnValue({ data: null, error: null, refetch: vi.fn(), isFetching: false });

    renderHook(() => useStablecoinReserves("usdc-circle", true));
    const options = useQueryMock.mock.calls[0][0] as {
      staleTime: (query: { state: { data?: { mode: string } | null } }) => number;
      refetchInterval: (query: { state: { data?: { mode: string } | null } }) => number;
      enabled: boolean;
      retry: number;
    };

    expect(options.enabled).toBe(true);
    expect(options.retry).toBe(1);
    // Reserve-sync cron cadence is 4h; staleTime = cadence, refetchInterval = 2× cadence.
    expect(options.staleTime({ state: { data: { mode: "live" } } })).toBe(4 * 60 * 60 * 1000);
    expect(options.refetchInterval({ state: { data: { mode: "live" } } })).toBe(2 * 4 * 60 * 60 * 1000);
    expect(options.staleTime({ state: { data: { mode: "curated-fallback" } } })).toBe(60 * 1000);
    expect(options.refetchInterval({ state: { data: { mode: "curated-fallback" } } })).toBe(2 * 60 * 1000);
  });

  it("uses recovery polling for live responses with active sync issues", () => {
    useQueryMock.mockReturnValue({ data: null, error: null, refetch: vi.fn(), isFetching: false });

    renderHook(() => useStablecoinReserves("usdc-circle", true));
    const options = useQueryMock.mock.calls[0][0] as {
      staleTime: (query: { state: { data?: { mode: string; sync?: { status: string; uncertainWrite?: boolean } } | null } }) => number;
      refetchInterval: (query: { state: { data?: { mode: string; sync?: { status: string; uncertainWrite?: boolean } } | null } }) => number;
    };

    const degradedLive = {
      mode: "live",
      sync: {
        status: "degraded",
      },
    };
    const uncertainLive = {
      mode: "live",
      sync: {
        status: "ok",
        uncertainWrite: true,
      },
    };

    expect(options.staleTime({ state: { data: degradedLive } })).toBe(60 * 1000);
    expect(options.refetchInterval({ state: { data: degradedLive } })).toBe(2 * 60 * 1000);
    expect(options.staleTime({ state: { data: uncertainLive } })).toBe(60 * 1000);
    expect(options.refetchInterval({ state: { data: uncertainLive } })).toBe(2 * 60 * 1000);
  });

  it("passes the TanStack query abort signal to the reserve API request", async () => {
    fetchStablecoinReservesMock.mockResolvedValue(null);
    useQueryMock.mockReturnValue({ data: null, error: null, refetch: vi.fn(), isFetching: false });

    renderHook(() => useStablecoinReserves("usdc-circle", true));
    const options = useQueryMock.mock.calls[0][0] as {
      queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
    };
    const controller = new AbortController();

    await expect(options.queryFn({ signal: controller.signal })).resolves.toBeNull();

    expect(fetchStablecoinReservesMock).toHaveBeenCalledWith("usdc-circle", { signal: controller.signal });
  });
});
