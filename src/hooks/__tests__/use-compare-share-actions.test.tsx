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
    safetyCard: { grade: "A" },
  } as unknown as ComparisonCoinEntry;
}

function renderShareActions() {
  return renderHook(() => useCompareShareActions({
    comparisonCoins: [makeCoin("usdc-circle", "USDC"), makeCoin("usdt-tether", "USDT")],
    logos: {},
    pegRates: {},
    radarCards: [],
    axisOrder: [],
    axisLabels: {},
  }));
}

describe("useCompareShareActions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/compare/usdc-vs-usdt/");
    Object.assign(navigator, {
      clipboard: {
        write: vi.fn(async () => undefined),
        writeText: vi.fn(async () => undefined),
      },
      canShare: vi.fn(() => false),
      share: vi.fn(),
    });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    });
    vi.spyOn(window, "open").mockImplementation(() => null);
    shareImageMocks.loadImage.mockResolvedValue({} as HTMLImageElement);
    shareImageMocks.renderCompareShareImage.mockReturnValue({} as HTMLCanvasElement);
    shareImageMocks.canvasToBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("revokes downloads synchronously and clears pending toast timers on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:pharos-compare", revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { result, unmount } = renderShareActions();

    await act(async () => {
      await result.current.handleTwitterShare();
    });

    expect(result.current.toast).toBe("Image copied! Paste it in your tweet (Ctrl+V)");

    await act(async () => result.current.handleDownload());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-compare");

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("surfaces an error toast when the share image fails to render", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    shareImageMocks.renderCompareShareImage.mockImplementation(() => {
      throw new Error("canvas allocation failed");
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const { result } = renderShareActions();

    await act(async () => {
      await result.current.handleTwitterShare();
    });

    expect(result.current.toast).toBe("Couldn't generate the share image");
    expect(warnSpy).toHaveBeenCalled();
    // The Twitter intent still opens so the user can tweet without the image.
    expect(openSpy).toHaveBeenCalled();
  });

});
