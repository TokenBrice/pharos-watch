import { describe, expect, it } from "vitest";
import { CRON_INTERVALS, DEX_LIQUIDITY_STAGE_LEAD_SEC } from "@shared/lib/cron-jobs";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { CURVE_NAV_SPOT_QUOTE_POLICY } from "../../cron/dex-liquidity/types";
import { makeClockedCurveNavPayload } from "../../api/__tests__/p4-route-response.test-support";
import {
  chooseIndependentOffchainDepegConfirmer as chooseConf,
  classifyPrimaryDepegTrust as classify,
  getDexAggregateObservedAt as getAggAt,
  getDexAggregateRejectionReason as getAggRej,
  getDexTrustPolicy as dexPol,
  getFreshIndependentPrimarySourceFamilies as freshInd,
  getPrimaryDepegSourceFamilies as priFams,
  hasFreshMultiSourcePrimaryAgreement as multiAgree,
  isAffirmativeDexPriceRow as isAffDex,
  isAuthoritativeDepegPegReference as isAuthRef,
  isTrustedDexPriceRow as isTrustDex,
  mapClockedCurveNavReasonToApiUnavailableReason as mapNavApiReason,
  readDexAggregateObservedAt as readAggAt,
  resolveDepegSourceFamily as resFam,
} from "../depeg-trust-policy";

type PF = Parameters<typeof classify>[0];
const N = 1_700_000_000;
const pyth = (ov: PF = {}): PF => ({ price: 0.999, priceSource: "pyth", priceConfidence: "single-source", priceObservedAt: N - 60, agreeSources: ["pyth"], ...ov });
const soft = (ov: PF = {}): PF => ({ price: 0.999, priceSource: "coingecko+defillama-list", priceConfidence: "high", priceObservedAt: N - 60, agreeSources: ["coingecko", "defillama-list"], ...ov });

describe("classifyPrimaryDepegTrust", () => {
  it.each([60, 901])("requires confirmation for local-fetch native Hive at age %i", (age) => {
    const inp = { price: 0.98662, priceSource: "hive-native-cg", priceConfidence: "single-source" as const, priceObservedAt: N - age, priceObservedAtMode: "local_fetch" as const, agreeSources: ["hive-native-cg", "coingecko"] };
    expect(classify(inp, N)).toBe("confirm_required"); expect(multiAgree(inp, N)).toBe(false); expect(resFam("hive-native-cg")).toBe("coingecko");
  });

  it.each([
    { priceSource: "pyth", priceObservedAtMode: "nominal_reference" as const }, { priceSource: "protocol-par", priceObservedAtMode: "upstream" as const },
    { priceSource: "protocol-par" }, { priceSource: "pyth", priceObservedAtMode: "unsupported" as const },
  ])("never admits nominal or unsupported prices despite fresh confident evidence: %j", (prov) => {
    const inp = { price: 0.98, priceConfidence: "high" as const, priceObservedAt: N - 60, agreeSources: ["pyth", "coingecko"], ...prov };
    expect(classify(inp, N)).toBe("unusable"); expect(multiAgree(inp, N)).toBe(false); expect([...freshInd(inp, N, "other")]).toEqual([]);
  });

  it.each([undefined, "unknown", "upstream", "local_fetch"] as const)("keeps legacy redemption evidence usable but requiring confirmation with mode %s", (m) => {
    expect(classify({ price: 0.98, priceSource: "protocol-redeem", priceObservedAtMode: m, priceConfidence: "high", priceObservedAt: N - 60 }, N)).toBe("confirm_required");
  });

  it.each([
    ["soft single-source", "coingecko", "single-source", undefined, "confirm_required"],
    ["upstream hard single-source", "pyth", "single-source", "upstream", "authoritative"],
    ["local-fetch hard single-source", "kraken", "single-source", "local_fetch", "confirm_required"],
    ["soft-only agreement", "coingecko+defillama-list", "high", undefined, "confirm_required"],
    ["upstream hard source with soft corroboration", "coingecko+pyth", "high", undefined, "authoritative"],
    ["lone local-fetch hard source with soft corroboration", "coingecko+kraken", "high", undefined, "confirm_required"],
    ["two local-fetch hard sources", "binance+kraken", "high", undefined, "authoritative"],
    ["legacy upstream-capable hard source", "pyth", "single-source", undefined, "authoritative"],
  ] as const)("classifies fresh %s evidence", (_n, priceSource, priceConfidence, priceObservedAtMode, exp) => {
    expect(classify({ price: 0.998, priceObservedAt: N - 60, priceSource, priceConfidence, priceObservedAtMode, agreeSources: priceSource.split("+") }, N)).toBe(exp);
  });

  it("requires confirmation for future-dated primary observations", () => {
    expect(classify(pyth({ price: 0.998, priceObservedAt: N + 60, priceObservedAtMode: "upstream" }), N)).toBe("confirm_required");
  });
  it("uses source observation time rather than sync-write time for freshness", () => {
    expect(classify(pyth({ price: 1, priceObservedAt: N - 31 * 60, priceUpdatedAt: N - 30 }), N)).toBe("confirm_required");
  });
  it("requires confirmation for composite soft-source agreement labels", () => {
    expect(classify({ price: 0.999, priceSource: "coingecko+geckoterminal", priceConfidence: "high", priceObservedAt: N - 60, agreeSources: ["coingecko+geckoterminal"] }, N)).toBe("confirm_required");
  });
});

describe("hasFreshMultiSourcePrimaryAgreement", () => {
  it("accepts fresh high-confidence corroborated independent-family agreement", () => { expect(multiAgree(soft(), N)).toBe(true); });
  it.each(["single-source", "high"] as const)("rejects non-high-confidence or fallback-only agreement (%s)", (c) => {
    expect(multiAgree({ price: 0.42, priceSource: "dexscreener-address+alchemy-address", priceConfidence: c, priceObservedAt: N - 60, agreeSources: ["dexscreener-address", "alchemy-address"] }, N)).toBe(false);
  });
  it("rejects low-confidence clusters", () => { expect(multiAgree(soft({ priceConfidence: "low" }), N)).toBe(false); });
  it.each([[1800, true], [1801, false]] as const)("checks corroborated agreement age at %s seconds", (age, ok) => {
    expect(multiAgree(soft({ priceObservedAt: N - age }), N)).toBe(ok);
  });
});

describe("isAuthoritativeDepegPegReference", () => {
  it.each([
    ["thin fiat median", "BRL", "peggedREAL", "median", 2, false], ["fallback-backed thin fiat", "BRL", "peggedREAL", "fallback", 2, true],
    ["robust fiat median", "EUR", "peggedEUR", "median", 4, true], ["USD reference", "USD", "peggedUSD", "median", 1, true],
    ["thin commodity median", "SILVER", "peggedSILVER", "median", 2, false], ["commodity reference", "GOLD", "peggedGOLD", "median", 3, true],
    ["commodity spot fallback", "SILVER", "peggedSILVER", "fallback", 0, true],
  ] as const)("checks %s authority", (_n, pegCurrency, pegType, pegRateSource, pegRateContributorCount, exp) => {
    expect(isAuthRef({ pegCurrency, pegType, pegRateSource, pegRateContributorCount })).toBe(exp);
  });
});

describe("DEX trust policy", () => {
  it.each([undefined, null, 0, -1, NaN, Infinity, N + 1])("rejects contributor clock %s", (clk) => {
    const r = clk == null ? "aggregate-clock-unavailable" : Number.isFinite(clk) && clk > N ? "aggregate-clock-future" : "aggregate-clock-invalid";
    for (const p of [[{ aggregateObservedAt: N }, { aggregateObservedAt: clk }], { aggregateObservedAt: clk, sources: [] }]) {
      const parsed = getAggAt(p, N);
      expect(parsed).toEqual({ aggregateObservedAt: null, aggregateClockReason: r });
      expect(getAggRej({ updated_at: N, source_total_tvl: 5e6, ...parsed }, N, "depeg")).toBe(r);
    }
  });
  it.each([null, undefined, "{", "{}", "[]", "[null]"])("fails closed on clock JSON %s", (j) => { expect(readAggAt(j, N)).toBeNull(); });
  it("uses the oldest repeated clock regardless of source observation clocks", () => {
    expect(readAggAt(JSON.stringify([60, 300].map((a) => ({ aggregateObservedAt: N - a, observedAt: N - 21_600 }))), N)).toBe(N - 300);
    expect(getAggAt({ aggregateObservedAt: N - 60, sources: [] }, N)).toEqual({ aggregateObservedAt: N - 60, aggregateClockReason: null });
  });
  it.each(["ui", "depeg"] as const)("keeps %s aggregate age strict and TVL inclusive without weakening vetoes", (tier) => {
    const { maxAgeSec, minTvlUsd } = dexPol(tier), row = { updated_at: N, source_total_tvl: minTvlUsd, aggregateObservedAt: N - maxAgeSec + 1 };
    expect(isAffDex(row, N, tier)).toBe(true); expect(isAffDex({ ...row, source_total_tvl: minTvlUsd - 1 }, N, tier)).toBe(false);
    for (const a of [N - maxAgeSec, N - 21_600, null]) {
      expect(isAffDex({ ...row, aggregateObservedAt: a }, N, tier)).toBe(false);
      expect(getAggRej({ ...row, aggregateObservedAt: a }, N, tier)).toBe(a == null ? "aggregate-clock-unavailable" : "aggregate-clock-stale");
      expect(isTrustDex(row, N, tier)).toBe(true);
    }
  });
  it("trusts only rows that satisfy the requested tier", () => {
    const r = { updated_at: N - 60, source_total_tvl: 300_000 };
    expect(isTrustDex(r, N, "ui")).toBe(true); expect(isTrustDex(r, N, "depeg")).toBe(false);
  });
  it("derives the UI window from the hourly DEX producer cadence plus its stage lead", () => {
    expect(dexPol("ui").maxAgeSec).toBe(CRON_INTERVALS["sync-dex-liquidity"] * 2 + DEX_LIQUIDITY_STAGE_LEAD_SEC);
    expect(isTrustDex({ updated_at: N - 3_960, source_total_tvl: 10e6 }, N, "ui")).toBe(true);
  });
  it("rejects future-dated and non-finite rows for every tier", () => {
    const f = { updated_at: N + 86_400, source_total_tvl: 50e6 };
    expect([isTrustDex(f, N, "ui"), isTrustDex(f, N, "depeg"), isTrustDex({ updated_at: NaN, source_total_tvl: 50e6 }, N, "ui"), isTrustDex({ updated_at: N - 60, source_total_tvl: NaN }, N, "ui")]).toEqual([false, false, false, false]);
  });
  it("enforces shared clocked Curve NAV <4500s and <=600s capture rules across ui and depeg tiers", () => {
    const pub = N - 200;
    const cap = CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec;
    const valid = makeClockedCurveNavPayload({
      poolRatioObservedAt: pub - 120,
      quoteMarkObservedAt: pub - 180,
      captureEvaluatedAtSec: pub - 60,
      quotePublishedAtSec: pub,
    });
    const row = { updated_at: pub, source_total_tvl: 2_500_000, aggregateObservedAt: pub - 180, pricePayload: valid };
    expect([isTrustDex(row, N, "ui"), isAffDex(row, N, "ui"), isAffDex(row, N, "depeg")]).toEqual([true, true, true]);
    const exp = pub - 180 + DEX_FRESHNESS_SEC;
    expect([isTrustDex(row, exp, "ui"), getAggRej(row, exp, "ui"), getAggRej(row, exp, "depeg")])
      .toEqual([false, "aggregate-clock-stale", "aggregate-clock-stale"]);

    // Opus #6: capture-stale unifies under staleness across trust policy and API contracts.
    const late = makeClockedCurveNavPayload({
      poolRatioObservedAt: pub - cap - 1,
      quoteMarkObservedAt: pub - 60,
      captureEvaluatedAtSec: pub - cap - 1,
      quotePublishedAtSec: pub,
    });
    expect(getAggAt(late, N)).toEqual({ aggregateObservedAt: pub - cap - 1, aggregateClockReason: null });
    expect(mapNavApiReason("capture-stale")).toBe("stale-price");
    expect([
      isTrustDex({ updated_at: pub, source_total_tvl: 2_500_000, pricePayload: late }, N, "ui"),
      getAggRej({ updated_at: pub, source_total_tvl: 2_500_000, aggregateObservedAt: pub - cap - 1, pricePayload: late }, N, "depeg"),
    ]).toEqual([false, "aggregate-clock-stale"]);
  });
});

describe("depeg confirmation source families", () => {
  it.each([["coingecko", "coingecko"], ["cg-ticker", "coingecko"], ["defillama-list", "defillama"], ["defillama-contract", "defillama"], ["balancer-dex", "dex:balancer"], ["coingecko+geckoterminal", "coingecko+dex:geckoterminal"]])(
    "normalizes correlated CoinGecko and DefiLlama source variants (%s)", (s, exp) => { expect(resFam(s)).toBe(exp); },
  );
  it.each([["coingecko+pyth", undefined, null], ["pyth+coingecko", undefined, null], ["defillama-list+coingecko", undefined, null], ["pyth", ["pyth", "coingecko"], null], ["pyth", ["pyth"], "coingecko-confirm"]])(
    "chooses an independent off-chain confirmer for %s", (priceSource, agreeSources, exp) => { expect(chooseConf({ priceSource, agreeSources })).toBe(exp); },
  );
  it("derives source families from agreeSources before falling back to priceSource order", () => {
    expect([...priFams({ priceSource: "pyth", agreeSources: ["defillama-list", "coingecko"] })].sort()).toEqual(["coingecko", "defillama"]);
  });
  it("expands composite agreeSources before choosing off-chain confirmation family", () => {
    expect(chooseConf({ priceSource: "pyth", agreeSources: ["coingecko+geckoterminal"] })).toBeNull();
  });
  it("keeps only fresh primary families independent from a native CoinGecko quote", () => {
    expect([...freshInd({ price: 1.15, priceSource: "defillama-list+coingecko", priceConfidence: "high", priceObservedAt: N - 60, agreeSources: ["defillama-list", "coingecko"] }, N, "coingecko")]).toEqual(["defillama"]);
    expect([...freshInd({ price: 1.15, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: N - 60, agreeSources: ["coingecko"] }, N, "coingecko")]).toEqual([]);
  });
});
