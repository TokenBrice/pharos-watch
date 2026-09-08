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

  it("natively shares the rendered file and keeps loading until the share settles", async () => {
    let resolveShare!: () => void;
    const share = vi.fn((_data: { title: string; url: string; files: File[] }) => new Promise<void>((resolve) => { resolveShare = resolve; }));
    Object.assign(navigator, { canShare: vi.fn(() => true), share });
    const { result } = renderShareActions();

    let call!: Promise<void>;
    act(() => {
      call = result.current.handleWebShare();
    });
    // Drain microtasks until the hook reaches the pending navigator.share call.
    await act(async () => {
      for (let i = 0; i < 50 && share.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
    });

    expect(share).toHaveBeenCalledTimes(1);
    // The native share sheet is still open — the button must stay disabled.
    expect(result.current.shareLoading).toBe(true);
    const envelope = share.mock.calls[0]?.[0] as {
      title: string;
      url: string;
      files: File[];
    };
    expect(envelope.files).toHaveLength(1);
    expect(envelope.files[0]?.name).toBe("pharos-compare.png");
    expect(envelope.files[0]?.type).toBe("image/png");
    expect(envelope.title).toBe("USDC vs USDT on Pharos Compare");
    expect(envelope.url).toBe(window.location.href);

    await act(async () => {
      resolveShare();
      await call;
    });
    expect(result.current.shareLoading).toBe(false);
  });

  it("falls back to clipboard image copy when native file sharing is unsupported", async () => {
    const write = vi.fn(async (_items: [{ items: Record<string, Blob> }]) => undefined);
    Object.assign(navigator, {
      canShare: vi.fn(() => false),
      share: vi.fn(),
      clipboard: { write, writeText: vi.fn(async () => undefined) },
    });
    const { result } = renderShareActions();

    await act(async () => {
      await result.current.handleWebShare();
    });

    expect(navigator.share).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0]?.[0] as [{ items: Record<string, Blob> }];
    expect(Object.keys(written[0].items)).toEqual(["image/png"]);
    expect(result.current.toast).toBe("Image copied to clipboard");
    expect(result.current.shareLoading).toBe(false);
  });

  it("copies the link when the image clipboard write fails, and toasts failure when that fails too", async () => {
    const write = vi.fn(async () => {
      throw new Error("clipboard blocked");
    });
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.assign(navigator, {
      canShare: vi.fn(() => false),
      share: vi.fn(),
      clipboard: { write, writeText },
    });
    const { result } = renderShareActions();

    // jsdom has no document.execCommand, so writeText success is the only copy path.
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.handleWebShare();
    });
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(result.current.toast).toBe("Link copied to clipboard");

    writeText.mockRejectedValueOnce(new Error("permission denied"));
    await act(async () => {
      await result.current.handleWebShare();
    });
    expect(result.current.toast).toBe("Could not copy to clipboard");
    expect(result.current.shareLoading).toBe(false);
  });

  it("treats a user-cancelled share sheet as silent and resets loading", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = Object.assign(new Error("user cancelled"), { name: "AbortError" });
    Object.assign(navigator, { canShare: vi.fn(() => true), share: vi.fn(async () => {
      throw abort;
    }) });
    const { result } = renderShareActions();

    await act(async () => {
      await result.current.handleWebShare();
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result.current.toast).toBeNull();
    expect(result.current.shareLoading).toBe(false);
  });

  it("resets loading when the share image cannot be rendered", async () => {
    const write = vi.fn(async () => undefined);
    Object.assign(navigator, {
      canShare: vi.fn(() => false),
      share: vi.fn(),
      clipboard: { write, writeText: vi.fn(async () => undefined) },
    });
    shareImageMocks.renderCompareShareImage.mockReturnValue(null);
    const { result } = renderShareActions();

    await act(async () => {
      await result.current.handleWebShare();
    });

    expect(navigator.share).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(result.current.toast).toBeNull();
    expect(result.current.shareLoading).toBe(false);
  });

});
