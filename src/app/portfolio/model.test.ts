import { describe, expect, it } from "vitest";
import {
  computePortfolioConcentrations,
  groupDependencyExposure,
  parseUsdInput,
  rankExceptionalHoldings,
} from "./model";
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

  it("groups dependencyExposure by upstream coin without coercing unknown basket shares to zero", () => {
    const grouped = groupDependencyExposure(
      [
        {
          upstreamAssetId: "usdc-circle",
          dependentAssetId: "dai-makerdao",
          kind: "basket",
          materiality: "basket-weighted",
          exposureUsd: 1500,
        },
        {
          upstreamAssetId: "usdc-circle",
          dependentAssetId: "frax-frax",
          kind: "basket",
          materiality: "basket-bounded-unknown",
          exposureUsd: null,
        },
        {
          upstreamAssetId: "usdt-tether",
          dependentAssetId: "susde-ethena",
          kind: "basket",
          materiality: "basket-bounded-unknown",
          exposureUsd: null,
        },
      ],
      10_000,
    );

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      upstreamAssetId: "usdc-circle",
      knownExposureUsd: 1500,
      pctOfPortfolio: 15,
      unknownRouteCount: 1,
      hasUnknownShareRoutes: true,
      routeCount: 2,
    });
    expect(grouped[0]!.contributors.map((c) => [c.dependentAssetId, c.exposureUsd])).toEqual([
      ["dai-makerdao", 1500],
      ["frax-frax", null],
    ]);
    expect(grouped[1]).toMatchObject({
      upstreamAssetId: "usdt-tether",
      knownExposureUsd: null,
      pctOfPortfolio: null,
      unknownRouteCount: 1,
      hasUnknownShareRoutes: true,
      routeCount: 1,
    });
  });

  it("computes Freeze, Governance, Custody, and Peg concentration strips while isolating unknown/unreviewed members", () => {
    expect(computePortfolioConcentrations([{ coinId: "usdc-circle", amount: 0 }])).toEqual([]);

    const strips = computePortfolioConcentrations([
      { coinId: "usdc-circle", amount: 600 },
      { coinId: "lusd-liquity", amount: 200 },
      { coinId: "unknown-synthetic-id", amount: 200 },
    ]);

    expect(strips.map((strip) => strip.id)).toEqual(["freeze", "governance", "custody", "peg"]);
    const freeze = strips.find((strip) => strip.id === "freeze")!;
    expect(freeze.knownUsd).toBe(800);
    expect(freeze.unavailableUsd).toBe(200);
    expect(freeze.unavailableIds).toEqual(["unknown-synthetic-id"]);
    expect(freeze.buckets.find((bucket) => bucket.key === "direct")?.sharePct).toBeCloseTo(60, 5);
    expect(freeze.buckets.find((bucket) => bucket.key === "unfreezable")?.sharePct).toBeCloseTo(20, 5);

    const peg = strips.find((strip) => strip.id === "peg")!;
    expect(peg.buckets[0]).toMatchObject({ key: "USD", label: "USD", amountUsd: 800, sharePct: 80 });
    expect(peg.unavailableIds).toEqual(["unknown-synthetic-id"]);
  });
});
