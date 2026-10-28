// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareShareActions } from "../use-compare-share-actions";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";
import type { StablecoinData, StablecoinMeta } from "@shared/types";

const shareImageMocks = vi.hoisted(() => ({
  loadImage: vi.fn(),
  renderCompareShareImage: vi.fn(),
  canvasToBlob: vi.fn(),
}));

vi.mock("@/lib/compare-share-image", () => shareImageMocks);
vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

function makeCoin(id: string, symbol: string): ComparisonCoinEntry {
  return {
    id,
    symbol,
    name: symbol,
    data: {
      price: 1,
      pegType: "peggedUSD",
      circulating: { peggedUSD: 1_000_000 },
      circulatingPrevWeek: { peggedUSD: 900_000 },
    } as unknown as StablecoinData,
    meta: {
      id,
      symbol,
      name: symbol,
      flags: {
        governance: "centralized",
        backing: "fiat",
        pegCurrency: "USD",
      },
    } as unknown as StablecoinMeta,
    pegDetails: { pegScore: 99 },
    liquidity: { liquidityScore: 88 },
    safetyCard: { grade: "A", ratingStatus: "rated", partialEvidence: null },
  } as unknown as ComparisonCoinEntry;
}


describe("useCompareShareActions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/compare/usdc-vs-usdt/");
    shareImageMocks.loadImage.mockResolvedValue({} as HTMLImageElement);
    shareImageMocks.renderCompareShareImage.mockReturnValue({} as HTMLCanvasElement);
    shareImageMocks.canvasToBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["unavailable", "partial"])("withholds %s supply changes while preserving observed zero", async (coverage) => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:pharos-compare", revokeObjectURL: vi.fn() });
    const missing = makeCoin("usdc-circle", "USDC");
    missing.data = coverage === "unavailable" ? { ...missing.data, circulating: {} } : {
      ...missing.data,
      supplyChainGuard: {
        reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage: true,
        chains: [{ chainId: "ethereum", chainLabel: "Ethereum", listCurrentUsd: 0,
          baselineUsd: 50, baselineObservedAt: 1_792_700_000, baselineSource: "state", resolution: "unavailable" }],
      },
    };
    const zero = makeCoin("usdt-tether", "USDT");
    zero.data = { ...zero.data, circulating: { peggedUSD: 0 } };
    const { result } = renderHook(() => useCompareShareActions({
      comparisonCoins: [missing, zero],
      logos: {},
      pegRates: {},
      radarCards: [],
      axisOrder: [],
      axisLabels: {},
    }));

    await act(async () => result.current.handleDownload());

    const [coins] = shareImageMocks.renderCompareShareImage.mock.calls.at(-1) as [Array<{ symbol: string; marketCap: string; weeklyChange: string }>];
    expect(coins.find((coin) => coin.symbol === "USDC")).toMatchObject({ marketCap: coverage === "unavailable" ? "—" : "$1.00M", weeklyChange: "—" });
    expect(coins.find((coin) => coin.symbol === "USDT")).toMatchObject({ marketCap: "$0.00", weeklyChange: "-100.00%" });
  });

});
