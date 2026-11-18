import { describe, expect, it } from "vitest";
import { parseUsdInput, rankExceptionalHoldings } from "./model";
import type { CoinState } from "@shared/lib/coin-state";
import { mergeCoinsParam } from "@/lib/portfolio-codec";

describe("portfolio page model", () => {
  it("parses supported USD input formats", () => {
    expect(parseUsdInput("$1,234.50")).toBe(1234.5);
    expect(parseUsdInput("2500")).toBe(2500);
    expect(parseUsdInput("12abc")).toBe(0);
  });

  it("merges the shared coins param as zero-amount holdings without overriding amounts", () => {
    expect(mergeCoinsParam("usdt-tether:25000", "usdt-tether,usds-sky")).toBe("usdt-tether:25000,usds-sky:0");
    expect(mergeCoinsParam("", "usdc-circle")).toBe("usdc-circle:0");
    expect(mergeCoinsParam("usdc-circle:5", "")).toBe("usdc-circle:5");
    expect(mergeCoinsParam("", "")).toBe("");
  });

  it("ranks exceptional holdings by entered exposure and skips calm ones", () => {
    const states = new Map<string, readonly CoinState[]>([
      ["usdx-kava", [{ kind: "depeg", deviationBps: -900, ddrTier: null, ddrMethodologyVersion: null }]],
      ["iusd-initia", [{ kind: "critical", notice: { type: "danger", title: "Chain halted" } }]],
    ]);
    const ranked = rankExceptionalHoldings([
      { coinId: "usdc-circle", amount: 50_000 },
      { coinId: "usdx-kava", amount: 10_000 },
      { coinId: "iusd-initia", amount: 20_000 },
    ], states);
    expect(ranked.map((holding) => [holding.coinId, holding.amount])).toEqual([["iusd-initia", 20_000], ["usdx-kava", 10_000]]);
  });
});
