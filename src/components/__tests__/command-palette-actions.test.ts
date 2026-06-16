import { describe, expect, it, vi } from "vitest";
import {
  buildVerbPreview,
  clampCommandPaletteSelectedIndex,
  executeParsedVerb,
} from "@/components/command-palette-actions";
import type { ParsedVerb } from "@/lib/command-palette-verbs";

function makeExecutor() {
  return {
    push: vi.fn(),
    closePalette: vi.fn(),
    addToWatchlist: vi.fn(),
    removeFromWatchlist: vi.fn(),
    clearWatchlist: vi.fn(),
  };
}

describe("command palette action helpers", () => {
  it("builds the same runnable compare preview outside the component", () => {
    const preview = buildVerbPreview({
      kind: "compare",
      coinSymbols: ["usdc", "bad"],
      resolvedCoinIds: ["usdc-circle"],
      unresolved: ["bad"],
    });

    expect(preview).toEqual({
      label: "Compare USDC, BAD",
      sublabel: "Open /compare with 1 stablecoin · skipped: bad",
      runnable: true,
    });
  });

  it("executes compare and watchlist verbs through injected side-effect handlers", () => {
    const compareExecutor = makeExecutor();
    const didCompare = executeParsedVerb(
      {
        kind: "compare",
        coinSymbols: ["usdc", "usdt"],
        resolvedCoinIds: ["usdc-circle", "usdt-tether"],
        unresolved: [],
      },
      compareExecutor,
    );

    expect(didCompare).toBe(true);
    expect(compareExecutor.push).toHaveBeenCalledWith("/compare/?coins=usdc-circle,usdt-tether");
    expect(compareExecutor.closePalette).toHaveBeenCalledTimes(1);

    const pinExecutor = makeExecutor();
    const didPin = executeParsedVerb(
      { kind: "pin", coinSymbol: "usdc", resolvedCoinId: "usdc-circle" },
      pinExecutor,
    );

    expect(didPin).toBe(true);
    expect(pinExecutor.addToWatchlist).toHaveBeenCalledWith("usdc-circle");
    expect(pinExecutor.closePalette).toHaveBeenCalledTimes(1);
  });

  it("executes screen, tape, and unpin-all verbs through injected side-effect handlers", () => {
    const screenExecutor = makeExecutor();
    expect(
      executeParsedVerb(
        {
          kind: "screen",
          filters: { dewsMax: "20" },
          href: "/screener/?dewsMax=20",
        },
        screenExecutor,
      ),
    ).toBe(true);
    expect(screenExecutor.push).toHaveBeenCalledWith("/screener/?dewsMax=20");
    expect(screenExecutor.closePalette).toHaveBeenCalledTimes(1);

    const tapeExecutor = makeExecutor();
    expect(
      executeParsedVerb(
        {
          kind: "tape",
          filters: { coin: "usdc-circle" },
          href: "/timeline/?coin=usdc-circle",
        },
        tapeExecutor,
      ),
    ).toBe(true);
    expect(tapeExecutor.push).toHaveBeenCalledWith("/timeline/?coin=usdc-circle");
    expect(tapeExecutor.closePalette).toHaveBeenCalledTimes(1);

    const unpinExecutor = makeExecutor();
    expect(
      executeParsedVerb(
        { kind: "unpin", coinSymbol: "all", resolvedCoinId: null },
        unpinExecutor,
      ),
    ).toBe(true);
    expect(unpinExecutor.clearWatchlist).toHaveBeenCalledTimes(1);
    expect(unpinExecutor.closePalette).toHaveBeenCalledTimes(1);
  });

  it("keeps unresolved or not-yet-backed verbs as no-ops", () => {
    const executor = makeExecutor();

    expect(executeParsedVerb({ kind: "pin", coinSymbol: "zzz", resolvedCoinId: null }, executor)).toBe(false);
    expect(executor.closePalette).not.toHaveBeenCalled();
  });

  it("clamps selected index when the result set shrinks or empties", () => {
    expect(clampCommandPaletteSelectedIndex(4, 2)).toBe(1);
    expect(clampCommandPaletteSelectedIndex(1, 0)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(-1, 5)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(2, 5)).toBe(2);
  });

  it("returns null preview for non-verb input", () => {
    expect(buildVerbPreview({ kind: "none" } satisfies ParsedVerb)).toBeNull();
  });
});
