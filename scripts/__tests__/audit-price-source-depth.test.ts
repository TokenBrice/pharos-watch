import { describe, expect, it } from "vitest";
import activeStablecoinsFixture from "./fixtures/audit-price-source-depth/active-stablecoins.json";
import pegSummaryFixture from "./fixtures/audit-price-source-depth/peg-summary.json";
import stablecoinsFixture from "./fixtures/audit-price-source-depth/stablecoins.json";
import { getCirculatingRaw } from "@shared/lib/supply";
import { circulatingForStablecoinRow } from "../lib/coverage-audit-cli";
import {
  bucketSourceDepth,
  buildPriceSourceDepthAudit,
  classifySourceFamily,
  type AuditStablecoinMeta,
} from "../maintenance/audit-price-source-depth";

describe("audit-price-source-depth", () => {
  it("uses canonical circulating normalization for mixed peg buckets", () => {
    const row = {
      circulating: {
        peggedUSD: 100,
        peggedEUR: 25,
        invalid: Number.NaN,
      },
    };
    expect(circulatingForStablecoinRow(row)).toBe(getCirculatingRaw(row));
    expect(circulatingForStablecoinRow(undefined)).toBe(0);
  });

  it("buckets source depths with a 5+ overflow bucket", () => {
    expect(bucketSourceDepth(-1)).toBe("0");
    expect(bucketSourceDepth(0)).toBe("0");
    expect(bucketSourceDepth(1)).toBe("1");
    expect(bucketSourceDepth(2)).toBe("2");
    expect(bucketSourceDepth(3)).toBe("3");
    expect(bucketSourceDepth(4)).toBe("4");
    expect(bucketSourceDepth(5)).toBe("5+");
    expect(bucketSourceDepth(7)).toBe("5+");
  });

  it("classifies source families from pricing registry metadata", () => {
    expect(classifySourceFamily("pyth")).toBe("oracle");
    expect(classifySourceFamily("binance")).toBe("market");
    expect(classifySourceFamily("dex-promoted")).toBe("dex");
    expect(classifySourceFamily("protocol-redeem")).toBe("protocol-override");
    expect(classifySourceFamily("coingecko")).toBe("list-aggregator");
    expect(classifySourceFamily("coinmarketcap")).toBe("fallback-search");
    expect(classifySourceFamily("unknown-feed")).toBe("unknown");
  });

  it("reduces missing, null, empty, 1, 2, 3, and 5+ source rows", () => {
    const audit = buildPriceSourceDepthAudit({
      activeStablecoins: activeStablecoinsFixture as AuditStablecoinMeta[],
      pegSummary: pegSummaryFixture,
      stablecoins: stablecoinsFixture,
      generatedAt: "2026-05-12T00:00:00.000Z",
      mode: "input",
    });

    expect(audit.activeCount).toBe(7);
    expect(audit.sourceDepthDistribution).toEqual({
      "0": 3,
      "1": 1,
      "2": 1,
      "3": 1,
      "4": 0,
      "5+": 1,
    });
    expect(audit.agreeDepthDistribution).toEqual({
      "0": 3,
      "1": 1,
      "2": 1,
      "3": 1,
      "4": 0,
      "5+": 1,
    });
    expect(audit.authoritativeAgreeDepthDistribution).toEqual({
      "0": 4,
      "1": 1,
      "2": 1,
      "3": 0,
      "4": 1,
      "5+": 0,
    });
    expect(audit.mcapWeightedReach.sourceAtLeast3MarketCapUsd).toBe(800);
    expect(audit.mcapWeightedReach.totalMarketCapUsd).toBe(1280);
    expect(audit.cohorts.exact2.map((row) => row.coinId)).toEqual(["two-source"]);
    expect(audit.cohorts.exact1.map((row) => row.coinId)).toEqual(["one-source"]);
    expect(audit.cohorts.zeroOrMissing.map((row) => row.coinId)).toEqual([
      "missing-property",
      "null-sources",
      "empty-sources",
    ]);
    expect(audit.cohorts.fallbackOnly.map((row) => row.coinId)).toEqual(["null-sources"]);
    expect(audit.sourceFrequency.unknownSources).toEqual(["unknown-feed"]);
    expect(audit.warnings).toContain("Unknown source key 'unknown-feed' counted as non-authoritative.");
  });

  it("sorts exact-2 and exact-1 cohorts by descending market cap", () => {
    const audit = buildPriceSourceDepthAudit({
      activeStablecoins: [
        { id: "small-two", name: "Small Two", symbol: "STWO" },
        { id: "large-two", name: "Large Two", symbol: "LTWO" },
        { id: "small-one", name: "Small One", symbol: "SONE" },
        { id: "large-one", name: "Large One", symbol: "LONE" },
      ],
      pegSummary: {
        coins: [
          { id: "small-two", priceSource: "binance+coingecko", consensusSources: ["binance", "coingecko"] },
          { id: "large-two", priceSource: "binance+coingecko", consensusSources: ["binance", "coingecko"] },
          { id: "small-one", priceSource: "coingecko", consensusSources: ["coingecko"] },
          { id: "large-one", priceSource: "coingecko", consensusSources: ["coingecko"] },
        ],
      },
      stablecoins: {
        peggedAssets: [
          { id: "small-two", price: 1, priceSource: "binance+coingecko", circulating: { peggedUSD: 2 } },
          { id: "large-two", price: 1, priceSource: "binance+coingecko", circulating: { peggedUSD: 20 } },
          { id: "small-one", price: 1, priceSource: "coingecko", circulating: { peggedUSD: 1 } },
          { id: "large-one", price: 1, priceSource: "coingecko", circulating: { peggedUSD: 10 } },
        ],
      },
      generatedAt: "2026-05-12T00:00:00.000Z",
      mode: "input",
    });

    expect(audit.cohorts.exact2.map((row) => row.coinId)).toEqual(["large-two", "small-two"]);
    expect(audit.cohorts.exact1.map((row) => row.coinId)).toEqual(["large-one", "small-one"]);
  });

  it("expands composite source keys for classification without changing source depth", () => {
    const audit = buildPriceSourceDepthAudit({
      activeStablecoins: [{ id: "composite", name: "Composite", symbol: "COMP" }],
      pegSummary: {
        coins: [{
          id: "composite",
          priceSource: "coingecko+geckoterminal",
          consensusSources: ["coingecko+geckoterminal"],
          agreeSources: ["coingecko+geckoterminal"],
        }],
      },
      stablecoins: {
        peggedAssets: [{
          id: "composite",
          price: 1,
          priceSource: "coingecko+geckoterminal",
          circulating: { peggedUSD: 1 },
        }],
      },
      generatedAt: "2026-05-12T00:00:00.000Z",
      mode: "input",
    });

    expect(audit.rows[0].candidateSourceCount).toBe(1);
    expect(audit.rows[0].sourceClassifications.map((row) => row.source)).toEqual([
      "coingecko",
      "geckoterminal",
    ]);
    expect(audit.sourceFrequency.bySource.map((row) => row.source)).toEqual([
      "coingecko",
      "geckoterminal",
    ]);
    expect(audit.warnings).toContain(
      "Composite consensus source key 'coingecko+geckoterminal' on composite expanded for source-frequency classification but counted as one candidate source.",
    );
  });

  it("does not count priceSource fallback as authoritative agreeing depth", () => {
    const audit = buildPriceSourceDepthAudit({
      activeStablecoins: [{ id: "fallback", name: "Fallback", symbol: "FALL" }],
      pegSummary: {
        coins: [{
          id: "fallback",
          priceSource: "pyth+binance",
          consensusSources: ["pyth", "binance"],
        }],
      },
      stablecoins: {
        peggedAssets: [{
          id: "fallback",
          price: 1,
          priceSource: "pyth+binance",
          circulating: { peggedUSD: 1 },
        }],
      },
      generatedAt: "2026-05-12T00:00:00.000Z",
      mode: "input",
    });

    expect(audit.rows[0].agreeSourceCount).toBe(0);
    expect(audit.rows[0].authoritativeAgreeSourceCount).toBe(0);
    expect(audit.authoritativeAgreeDepthDistribution).toMatchObject({ "0": 1 });
  });
});
