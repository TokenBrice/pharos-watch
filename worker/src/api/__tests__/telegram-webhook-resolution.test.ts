import { describe, it, expect } from "vitest";
import { resolveCoinTargets } from "../telegram-webhook-resolution";
import { resolveTicker } from "../../lib/telegram/alerts";

describe("resolveCoinTargets", () => {
  it("resolves a single unique ticker", () => {
    const result = resolveCoinTargets(["USDC"]);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.coins).toHaveLength(1);
      expect(result.coins[0].symbol).toBe("USDC");
    }
  });

  it("deduplicates repeated tickers", () => {
    const result = resolveCoinTargets(["USDC", "USDC"]);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.coins).toHaveLength(1);
    }
  });

  it("returns not_found for unknown ticker", () => {
    const result = resolveCoinTargets(["XYZZY"]);
    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") {
      expect(result.ticker).toBe("XYZZY");
    }
  });

  it("returns ambiguous with candidates and remaining tickers", () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      // Skip if no ambiguous ticker available in test dataset
      return;
    }
    const result = resolveCoinTargets(["USDF", "USDC"]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.ticker).toBe("USDF");
      expect(result.candidates.length).toBeGreaterThan(1);
      expect(result.remainingTickers).toEqual(["USDC"]);
    }
  });

  it("includes initialCoins in the result", () => {
    const initial = [{ id: "dai-maker", symbol: "DAI", name: "Dai" }];
    const result = resolveCoinTargets(["USDC"], initial);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.coins.length).toBe(2);
      expect(result.coins.map((c) => c.symbol).sort()).toEqual(["DAI", "USDC"]);
    }
  });

  it("stops at first not_found ticker", () => {
    const result = resolveCoinTargets(["USDC", "XYZZY", "DAI"]);
    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") {
      expect(result.ticker).toBe("XYZZY");
    }
  });
});
