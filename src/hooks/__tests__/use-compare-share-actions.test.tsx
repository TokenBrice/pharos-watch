// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { getQuoteMatchedNavPriceReference } from "@/lib/nav-price-reference";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { useCompareShareActions } from "../use-compare-share-actions";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";
import type { StablecoinData } from "@shared/types/supply";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

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
      supplySource: "defillama",
      supplyChangeBaselines: { week: { observedAt: 1_699_395_200, circulatingUsd: 800_000, circulatingNative: null } },
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
      comparisonCoins: [missing, zero, makeCoin("dai-makerdao", "DAI")],
      logos: {},
      radarCards: [],
      axisOrder: [],
      axisLabels: {},
      asOfUpdatedAt: 1_700_000_000,
    }));

    await act(async () => result.current.handleDownload());

    expect(shareImageMocks.renderCompareShareImage).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.anything(),
      undefined,
      1_700_000_000,
    );
    const [coins] = shareImageMocks.renderCompareShareImage.mock.calls.at(-1) as [Array<{ symbol: string; marketCap: string; weeklyChange: string }>];
    expect(coins.find((coin) => coin.symbol === "USDC")).toMatchObject({ marketCap: coverage === "unavailable" ? "—" : "$1.00M", weeklyChange: "—" });
    expect(coins.find((coin) => coin.symbol === "USDT")).toMatchObject({ marketCap: "$0.00", weeklyChange: "-100.00%" });
    expect(coins.find((coin) => coin.symbol === "DAI")?.weeklyChange).toBe("+25.00%");
  });

  async function renderSharedCoin(coin: ComparisonCoinEntry) {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:pharos-compare", revokeObjectURL: vi.fn() });
    const { result } = renderHook(() => useCompareShareActions({
      comparisonCoins: [coin, makeCoin("usdt-tether", "USDT")],
      logos: {}, radarCards: [], axisOrder: [], axisLabels: {}, asOfUpdatedAt: null,
    }));
    await act(async () => result.current.handleDownload());
    return shareImageMocks.renderCompareShareImage.mock.calls.at(-1)?.[0][0];
  }

  it.each([
    ["idrx-idrx", "IDRX", "IDR", "peggedIDR", 0.0000551640254, false, "$0.00005516"],
    ["eutbl-spiko", "EUTBL", "EUR", "peggedEUR", 1.21, true, "$1.2100"],
  ] as const)("keeps the %s quote in USD when conversion evidence is unavailable", async (id, symbol, currency, pegType, price, navToken, expected) => {
    const coin = makeCoin(id, symbol);
    coin.meta.flags.pegCurrency = currency;
    coin.meta.flags.navToken = navToken;
    coin.navPriceReference = navToken
      ? getQuoteMatchedNavPriceReference(currency, FX_REOPEN_QUOTE_AT, [{
          ...makePegSummaryCoin({ pegCurrency: "EUR", pegType: "peggedEUR", priceObservedAt: FX_REOPEN_QUOTE_AT }),
          ...makeFxCurrentPeg("stale-reference", null),
        }])
      : undefined;
    coin.data = { ...coin.data, pegType, price, priceSource: "coingecko", priceObservedAt: FX_REOPEN_QUOTE_AT };
    expect(await renderSharedCoin(coin)).toMatchObject({ symbol, price: expected });
  });

  it("uses the quote-matched rejection for a fixed-peg share price", async () => {
    const coin = makeCoin("eurc-circle", "EURC");
    const rejected = makeFxCurrentPeg("stale-reference", null);
    coin.meta.flags.pegCurrency = "EUR";
    coin.data = { ...coin.data, id: coin.id, pegType: "peggedEUR", price: 1.122, priceSource: "coingecko",
      priceObservedAt: FX_REOPEN_QUOTE_AT,
      currentPeg: { ...rejected, referenceAdmission: undefined, admittedDeviationBps: undefined } };
    coin.pegDetails = { ...makePegSummaryCoin({ id: coin.id, price: 1.122, priceObservedAt: FX_REOPEN_QUOTE_AT }), ...rejected };
    expect(await renderSharedCoin(coin)).toMatchObject({ symbol: "EURC", price: "$1.1220" });
  });
});
