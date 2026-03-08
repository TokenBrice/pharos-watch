---
title: "Create ticker resolution and command parsing module"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Create `worker/src/lib/telegram-alerts.ts` with ticker resolution, command argument parsing, and disambiguation helpers.

## Task

1. **Create `worker/src/lib/telegram-alerts.ts`** with these exports:

```typescript
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

// ---------- Types ----------

export interface ResolvedCoin {
  id: string;
  symbol: string;
  name: string;
}

export interface TickerMatch {
  status: "unique" | "ambiguous" | "not_found";
  matches: ResolvedCoin[];
  /** For not_found: suggested ticker if a close match exists */
  suggestion?: ResolvedCoin;
}

export interface ParsedSubscribeArgs {
  alertTypes: Set<string>;
  tickers: string[];
  invalidTypes: string[];
}

// ---------- Constants ----------

const ALERT_TYPES = new Set(["dews", "depeg", "safety"]);

// ---------- Ticker Resolution ----------

/** Build a map of lowercase symbol → matching coins. Precomputed once at module load. */
const SYMBOL_INDEX: Map<string, ResolvedCoin[]> = (() => {
  const map = new Map<string, ResolvedCoin[]>();
  for (const meta of TRACKED_STABLECOINS) {
    const key = meta.symbol.toLowerCase();
    const coin: ResolvedCoin = { id: meta.id, symbol: meta.symbol, name: meta.name };
    const existing = map.get(key);
    if (existing) {
      existing.push(coin);
    } else {
      map.set(key, [coin]);
    }
  }
  return map;
})();

/** Resolve a user-provided ticker to matching coin(s). Case-insensitive. */
export function resolveTicker(ticker: string): TickerMatch {
  const key = ticker.toLowerCase();
  const matches = SYMBOL_INDEX.get(key);
  if (matches && matches.length === 1) {
    return { status: "unique", matches };
  }
  if (matches && matches.length > 1) {
    return { status: "ambiguous", matches };
  }
  // Not found — try prefix match for suggestion
  const suggestion = findClosestMatch(key);
  return { status: "not_found", matches: [], suggestion: suggestion ?? undefined };
}

/** Find a coin whose symbol starts with the given prefix, or null. */
function findClosestMatch(lowerTicker: string): ResolvedCoin | null {
  for (const [key, coins] of SYMBOL_INDEX) {
    if (key.startsWith(lowerTicker) || lowerTicker.startsWith(key)) {
      return coins[0];
    }
  }
  return null;
}

// ---------- Command Parsing ----------

/**
 * Parse `/subscribe` arguments. Tokens are classified as:
 * 1. Known alert type (dews/depeg/safety) → alertTypes
 * 2. Known ticker (exists in SYMBOL_INDEX) → tickers
 * 3. Neither → invalidTypes (unknown token)
 * Order-independent.
 */
export function parseSubscribeArgs(argsText: string): ParsedSubscribeArgs {
  const tokens = argsText.trim().split(/\s+/).filter(Boolean);
  const alertTypes = new Set<string>();
  const tickers: string[] = [];
  const invalidTypes: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (ALERT_TYPES.has(lower)) {
      alertTypes.add(lower);
    } else if (SYMBOL_INDEX.has(lower)) {
      tickers.push(token);
    } else {
      invalidTypes.push(token);
    }
  }

  return { alertTypes, tickers, invalidTypes };
}

/**
 * Validate parsed subscribe args. Returns an error message string if invalid, or null if valid.
 * Checks invalidTypes first — contextual error message depends on whether alert types were provided.
 */
export function validateSubscribeArgs(parsed: ParsedSubscribeArgs): string | null {
  if (parsed.invalidTypes.length > 0) {
    const unknown = parsed.invalidTypes.join(", ");
    if (parsed.alertTypes.size === 0) {
      return `Unknown alert type: ${unknown}. Valid types: dews, depeg, safety.`;
    }
    return `Unknown ticker: ${unknown}. Check spelling — use the coin's symbol (e.g. USDC, BOLD).`;
  }
  if (parsed.alertTypes.size === 0 && parsed.tickers.length === 0) {
    return "Specify alert types and tickers. Example: /subscribe dews USDC BOLD";
  }
  if (parsed.alertTypes.size === 0) {
    return "Specify at least one alert type: dews, depeg, safety. Example: /subscribe dews USDC";
  }
  if (parsed.tickers.length === 0) {
    return "Specify at least one ticker. Example: /subscribe dews USDC BOLD";
  }
  return null;
}

// ---------- Disambiguation Formatting ----------

/** Format a disambiguation prompt for the user. */
export function formatDisambiguation(ticker: string, candidates: ResolvedCoin[]): string {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${c.symbol} — ${c.name} (${c.id})`,
  );
  return [
    `"${ticker}" matches ${candidates.length} coins:`,
    ...lines,
    `Reply with the number(s) you want (e.g. "1" or "1,2")`,
  ].join("\n");
}

/** Parse a disambiguation reply (e.g. "1", "1,2", "1, 3"). Returns selected indices (0-based). */
export function parseDisambiguationReply(text: string, candidateCount: number): number[] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  const indices: number[] = [];
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 1 || n > candidateCount) return null;
    indices.push(n - 1);
  }
  return indices.length > 0 ? indices : null;
}
```

2. **Create `worker/src/lib/__tests__/telegram-alerts.test.ts`** with tests:

```typescript
import { describe, it, expect } from "vitest";
import {
  resolveTicker,
  parseSubscribeArgs,
  validateSubscribeArgs,
  formatDisambiguation,
  parseDisambiguationReply,
} from "../telegram-alerts";

describe("resolveTicker", () => {
  it("resolves unique ticker", () => {
    const result = resolveTicker("USDC");
    expect(result.status).toBe("unique");
    expect(result.matches[0].id).toBe("usdc-circle");
  });

  it("is case-insensitive", () => {
    const result = resolveTicker("usdc");
    expect(result.status).toBe("unique");
    expect(result.matches[0].id).toBe("usdc-circle");
  });

  it("returns ambiguous for duplicate tickers", () => {
    const result = resolveTicker("GUSD");
    expect(result.status).toBe("ambiguous");
    expect(result.matches.length).toBe(2);
  });

  it("returns not_found for unknown ticker", () => {
    const result = resolveTicker("ZZZZZ");
    expect(result.status).toBe("not_found");
    expect(result.matches).toEqual([]);
  });
});

describe("parseSubscribeArgs", () => {
  it("separates alert types from tickers", () => {
    const result = parseSubscribeArgs("dews depeg USDC BOLD");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.tickers).toEqual(["USDC", "BOLD"]);
  });

  it("is order-independent", () => {
    const result = parseSubscribeArgs("USDC dews BOLD depeg");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.tickers).toEqual(["USDC", "BOLD"]);
  });

  it("handles all three types", () => {
    const result = parseSubscribeArgs("dews depeg safety USDT");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg", "safety"]));
  });

  it("classifies unknown tokens as invalidTypes", () => {
    const result = parseSubscribeArgs("foo dews USDC");
    expect(result.alertTypes).toEqual(new Set(["dews"]));
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTypes).toEqual(["foo"]);
  });

  it("classifies completely unknown tokens when no types present", () => {
    const result = parseSubscribeArgs("foo USDC");
    expect(result.alertTypes.size).toBe(0);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTypes).toEqual(["foo"]);
  });
});

describe("validateSubscribeArgs", () => {
  it("returns null for valid args", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      tickers: ["USDC"],
      invalidTypes: [],
    });
    expect(result).toBeNull();
  });

  it("returns error when no types", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      tickers: ["USDC"],
      invalidTypes: [],
    });
    expect(result).toContain("alert type");
  });

  it("returns error when no tickers", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      tickers: [],
      invalidTypes: [],
    });
    expect(result).toContain("ticker");
  });

  it("returns unknown alert type error when no types and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      tickers: ["USDC"],
      invalidTypes: ["foo"],
    });
    expect(result).toContain("Unknown alert type: foo");
    expect(result).toContain("Valid types");
  });

  it("returns unknown ticker error when types present and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      tickers: [],
      invalidTypes: ["XYZZY"],
    });
    expect(result).toContain("Unknown ticker: XYZZY");
  });
});

describe("parseDisambiguationReply", () => {
  it("parses single number", () => {
    expect(parseDisambiguationReply("1", 3)).toEqual([0]);
  });

  it("parses comma-separated numbers", () => {
    expect(parseDisambiguationReply("1,2", 3)).toEqual([0, 1]);
  });

  it("parses space-separated numbers", () => {
    expect(parseDisambiguationReply("1 3", 3)).toEqual([0, 2]);
  });

  it("returns null for out-of-range", () => {
    expect(parseDisambiguationReply("5", 3)).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseDisambiguationReply("abc", 3)).toBeNull();
  });
});

describe("formatDisambiguation", () => {
  it("formats numbered list", () => {
    const result = formatDisambiguation("GUSD", [
      { id: "gusd-gate", symbol: "GUSD", name: "Gate USD" },
      { id: "gusd-gemini", symbol: "GUSD", name: "Gemini Dollar" },
    ]);
    expect(result).toContain("1. GUSD — Gate USD");
    expect(result).toContain("2. GUSD — Gemini Dollar");
  });
});
```

## Acceptance Criteria

- `worker/src/lib/telegram-alerts.ts` exists with exports: `resolveTicker`, `parseSubscribeArgs`, `validateSubscribeArgs`, `formatDisambiguation`, `parseDisambiguationReply`
- `worker/src/lib/__tests__/telegram-alerts.test.ts` exists
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0 (all new tests pass)
