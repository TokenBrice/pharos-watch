import {
  buildCompareHrefFromCoinIds,
  type ParsedVerb,
} from "@/lib/command-palette-verbs";

export interface CommandPaletteVerbPreview {
  label: string;
  sublabel: string;
  runnable: boolean;
}

export interface CommandPaletteVerbExecutor {
  push: (href: string) => void;
  closePalette: () => void;
  addToWatchlist: (stablecoinId: string) => void;
  removeFromWatchlist: (stablecoinId: string) => void;
  clearWatchlist: () => void;
}

export function executeParsedVerb(
  parsedVerb: ParsedVerb,
  executor: CommandPaletteVerbExecutor,
): boolean {
  switch (parsedVerb.kind) {
    case "compare": {
      if (parsedVerb.resolvedCoinIds.length === 0) return false;
      executor.push(buildCompareHrefFromCoinIds(parsedVerb.resolvedCoinIds));
      executor.closePalette();
      return true;
    }
    case "screen": {
      executor.push(parsedVerb.href);
      executor.closePalette();
      return true;
    }
    case "pin": {
      if (!parsedVerb.resolvedCoinId) return false;
      executor.addToWatchlist(parsedVerb.resolvedCoinId);
      executor.closePalette();
      return true;
    }
    case "unpin": {
      if (parsedVerb.coinSymbol === "all") {
        executor.clearWatchlist();
        executor.closePalette();
        return true;
      }
      if (!parsedVerb.resolvedCoinId) return false;
      executor.removeFromWatchlist(parsedVerb.resolvedCoinId);
      executor.closePalette();
      return true;
    }
    case "tape": {
      executor.push(parsedVerb.href);
      executor.closePalette();
      return true;
    }
    case "none":
      return false;
  }
}

export function buildVerbPreview(parsedVerb: ParsedVerb): CommandPaletteVerbPreview | null {
  switch (parsedVerb.kind) {
    case "compare": {
      const ids = parsedVerb.resolvedCoinIds;
      if (ids.length === 0) {
        return {
          label: "Compare —",
          sublabel: "Type tickers separated by spaces",
          runnable: false,
        };
      }
      const upperSymbols = parsedVerb.coinSymbols.map((s) => s.toUpperCase()).join(", ");
      const unresolvedNote = parsedVerb.unresolved.length
        ? ` · skipped: ${parsedVerb.unresolved.join(", ")}`
        : "";
      return {
        label: `Compare ${upperSymbols}`,
        sublabel: `Open /compare with ${ids.length} stablecoin${ids.length === 1 ? "" : "s"}${unresolvedNote}`,
        runnable: true,
      };
    }
    case "screen": {
      const keys = Object.keys(parsedVerb.filters);
      if (keys.length === 0) {
        return {
          label: "Screen —",
          sublabel: "Fields: safety, dews, supply, peg, mechanism, type · operators >= <= =",
          runnable: false,
        };
      }
      return {
        label: `Screen ${keys.length} filter${keys.length === 1 ? "" : "s"}`,
        sublabel: `Open /screener with ${keys.join(", ")}`,
        runnable: true,
      };
    }
    case "pin": {
      if (!parsedVerb.coinSymbol) {
        return {
          label: "Pin —",
          sublabel: "Type a ticker to add to your watchlist",
          runnable: false,
        };
      }
      if (!parsedVerb.resolvedCoinId) {
        return {
          label: `Pin ${parsedVerb.coinSymbol.toUpperCase()}`,
          sublabel: "No matching stablecoin",
          runnable: false,
        };
      }
      return {
        label: `Pin ${parsedVerb.coinSymbol.toUpperCase()}`,
        sublabel: "Add to your watchlist",
        runnable: true,
      };
    }
    case "unpin": {
      if (parsedVerb.coinSymbol === "all") {
        return { label: "Unpin all", sublabel: "Clear your watchlist", runnable: true };
      }
      if (!parsedVerb.coinSymbol) {
        return { label: "Unpin —", sublabel: "Type a ticker or 'all'", runnable: false };
      }
      if (!parsedVerb.resolvedCoinId) {
        return {
          label: `Unpin ${parsedVerb.coinSymbol.toUpperCase()}`,
          sublabel: "No matching stablecoin",
          runnable: false,
        };
      }
      return {
        label: `Unpin ${parsedVerb.coinSymbol.toUpperCase()}`,
        sublabel: "Remove from your watchlist",
        runnable: true,
      };
    }
    case "tape": {
      const keys = Object.keys(parsedVerb.filters);
      if (keys.length === 0) {
        return { label: "Tape:", sublabel: "e.g. tape: severity=warning", runnable: false };
      }
      return {
        label: `Tape: ${keys.length} filter${keys.length === 1 ? "" : "s"}`,
        sublabel: `Open /timeline with ${keys.join(", ")}`,
        runnable: true,
      };
    }
    case "none":
      return null;
  }
}

export function clampCommandPaletteSelectedIndex(
  selectedIndex: number,
  resultCount: number,
): number {
  if (resultCount <= 0 || selectedIndex < 0) return 0;
  return Math.min(selectedIndex, resultCount - 1);
}
