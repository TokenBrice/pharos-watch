import { describe, expect, it } from "vitest";
import { CRON_INTERVALS, DEX_LIQUIDITY_STAGE_LEAD_SEC } from "@shared/lib/cron-jobs";
import { makePythDepegPrice, makeSoftAgreementDepegPrice } from "./depeg-price.test-support";
import {
  chooseIndependentOffchainDepegConfirmer,
  classifyPrimaryDepegTrust,
  getDexTrustPolicy,
  getFreshIndependentPrimarySourceFamilies,
  getPrimaryDepegSourceFamilies,
  getDexAggregateObservedAt,
  getDexAggregateRejectionReason,
  hasFreshMultiSourcePrimaryAgreement,
  isAffirmativeDexPriceRow,
  isAuthoritativeDepegPegReference,
  isTrustedDexPriceRow,
  readDexAggregateObservedAt,
  resolveDepegSourceFamily,
} from "../depeg-trust-policy";

describe("classifyPrimaryDepegTrust", () => {
  const nowSec = 1_700_000_000;
  it.each([60, 901])("requires confirmation for local-fetch native Hive at age %i", (age) => {
    const input = { price: 0.98662, priceSource: "hive-native-cg", priceConfidence: "single-source" as const,
      priceObservedAt: nowSec - age, priceObservedAtMode: "local_fetch" as const, agreeSources: ["hive-native-cg", "coingecko"] };
    expect(classifyPrimaryDepegTrust(input, nowSec)).toBe("confirm_required");
    expect(hasFreshMultiSourcePrimaryAgreement(input, nowSec)).toBe(false);
    expect(resolveDepegSourceFamily("hive-native-cg")).toBe("coingecko");
  });
  it.each([
    { priceSource: "pyth", priceObservedAtMode: "nominal_reference" as const },
    { priceSource: "protocol-par", priceObservedAtMode: "upstream" as const },
    { priceSource: "protocol-par" },
    { priceSource: "pyth", priceObservedAtMode: "unsupported" as const },
  ])("never admits nominal or unsupported prices despite fresh confident evidence: %j", (provenance) => {
    const input = {
      price: 0.98,
      priceConfidence: "high" as const,
      priceObservedAt: nowSec - 60,
      agreeSources: ["pyth", "coingecko"],
      ...provenance,
    };
    expect(classifyPrimaryDepegTrust(input, nowSec)).toBe("unusable");
    expect(hasFreshMultiSourcePrimaryAgreement(input, nowSec)).toBe(false);
    expect([...getFreshIndependentPrimarySourceFamilies(input, nowSec, "other")]).toEqual([]);
  });

  it.each([undefined, "unknown", "upstream", "local_fetch"] as const)(
    "keeps legacy redemption evidence usable but requiring confirmation with mode %s",
    (priceObservedAtMode) => {
      expect(classifyPrimaryDepegTrust({
        price: 0.98,
        priceSource: "protocol-redeem",
        priceObservedAtMode,
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
      }, nowSec)).toBe("confirm_required");
    },
  );

  it.each([
    ["soft single-source", "coingecko", "single-source", undefined, "confirm_required"],
    ["upstream hard single-source", "pyth", "single-source", "upstream", "authoritative"],
    ["local-fetch hard single-source", "kraken", "single-source", "local_fetch", "confirm_required"],
    ["soft-only agreement", "coingecko+defillama-list", "high", undefined, "confirm_required"],
    ["upstream hard source with soft corroboration", "coingecko+pyth", "high", undefined, "authoritative"],
    ["lone local-fetch hard source with soft corroboration", "coingecko+kraken", "high", undefined, "confirm_required"],
    ["two local-fetch hard sources", "binance+kraken", "high", undefined, "authoritative"],
    ["legacy upstream-capable hard source", "pyth", "single-source", undefined, "authoritative"],
  ] as const)("classifies fresh %s evidence", (_name, priceSource, priceConfidence, priceObservedAtMode, expected) => {
    expect(classifyPrimaryDepegTrust({
      price: 0.998, priceObservedAt: nowSec - 60, priceSource, priceConfidence, priceObservedAtMode,
      agreeSources: priceSource.split("+"),
    }, nowSec)).toBe(expected);
  });

  it("requires confirmation for future-dated primary observations", () => {
    expect(classifyPrimaryDepegTrust(makePythDepegPrice(nowSec, {
      price: 0.998,
      priceObservedAt: nowSec + 60,
      priceObservedAtMode: "upstream",
    }), nowSec)).toBe("confirm_required");
  });

  it("uses source observation time rather than sync-write time for freshness", () => {
    expect(classifyPrimaryDepegTrust(makePythDepegPrice(nowSec, {
      price: 1,
      priceObservedAt: nowSec - (31 * 60),
      priceUpdatedAt: nowSec - 30,
    }), nowSec)).toBe("confirm_required");
  });

  it("requires confirmation for composite soft-source agreement labels", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "coingecko+geckoterminal",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko+geckoterminal"],
    }, nowSec)).toBe("confirm_required");
  });
});

describe("hasFreshMultiSourcePrimaryAgreement", () => {
  const nowSec = 1_700_000_000;

  it("accepts fresh high-confidence corroborated independent-family agreement", () => {
    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec), nowSec)).toBe(true);
  });

  it.each(["single-source", "high"] as const)("rejects non-high-confidence or fallback-only agreement (%s)", (priceConfidence) => {
    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.42,
      priceSource: "dexscreener-address+alchemy-address",
      priceConfidence,
      priceObservedAt: nowSec - 60,
      agreeSources: ["dexscreener-address", "alchemy-address"],
    }, nowSec)).toBe(false);
  });

  it("rejects low-confidence clusters", () => {
    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec, {
      priceConfidence: "low",
    }), nowSec)).toBe(false);
  });

  it.each([[1800, true], [1801, false]] as const)("checks corroborated agreement age at %s seconds", (age, accepted) => {
    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec, {
      priceObservedAt: nowSec - age,
    }), nowSec)).toBe(accepted);
  });
});

describe("isAuthoritativeDepegPegReference", () => {
  it.each([
    ["thin fiat median", "BRL", "peggedREAL", "median", 2, false],
    ["fallback-backed thin fiat", "BRL", "peggedREAL", "fallback", 2, true],
    ["robust fiat median", "EUR", "peggedEUR", "median", 4, true],
    ["USD reference", "USD", "peggedUSD", "median", 1, true],
    ["thin commodity median", "SILVER", "peggedSILVER", "median", 2, false],
    ["commodity reference", "GOLD", "peggedGOLD", "median", 3, true],
    ["commodity spot fallback", "SILVER", "peggedSILVER", "fallback", 0, true],
  ] as const)("checks %s authority", (_name, pegCurrency, pegType, pegRateSource, pegRateContributorCount, expected) => {
    expect(isAuthoritativeDepegPegReference({ pegCurrency, pegType, pegRateSource, pegRateContributorCount })).toBe(expected);
  });
});

describe("DEX trust policy", () => {
  const nowSec = 1_700_000_000;

  it.each([undefined, null, 0, -1, NaN, Infinity, nowSec + 1])("rejects contributor clock %s", (clock) => {
    const reason = clock == null ? "aggregate-clock-unavailable" : Number.isFinite(clock) && clock > nowSec ? "aggregate-clock-future" : "aggregate-clock-invalid";
    for (const payload of [[{ aggregateObservedAt: nowSec }, { aggregateObservedAt: clock }], { aggregateObservedAt: clock, sources: [] }]) {
      const parsed = getDexAggregateObservedAt(payload, nowSec);
      expect(parsed).toEqual({ aggregateObservedAt: null, aggregateClockReason: reason });
      expect(getDexAggregateRejectionReason({ updated_at: nowSec, source_total_tvl: 5e6, ...parsed }, nowSec, "depeg")).toBe(reason);
    }
  });
  it.each([null, undefined, "{", "{}", "[]", "[null]"])("fails closed on clock JSON %s", (json) => {
    expect(readDexAggregateObservedAt(json, nowSec)).toBeNull();
  });
  it("uses the oldest repeated clock regardless of source observation clocks", () => {
    expect(readDexAggregateObservedAt(JSON.stringify([60, 300].map((age) => ({
      aggregateObservedAt: nowSec - age, observedAt: nowSec - 21_600,
    }))), nowSec)).toBe(nowSec - 300);
    expect(getDexAggregateObservedAt({ aggregateObservedAt: nowSec - 60, sources: [] }, nowSec))
      .toEqual({ aggregateObservedAt: nowSec - 60, aggregateClockReason: null });
  });
  it.each(["ui", "depeg"] as const)("keeps %s aggregate age strict and TVL inclusive without weakening vetoes", (tier) => {
    const { maxAgeSec, minTvlUsd } = getDexTrustPolicy(tier);
    const row = { updated_at: nowSec, source_total_tvl: minTvlUsd, aggregateObservedAt: nowSec - maxAgeSec + 1 };
    expect(isAffirmativeDexPriceRow(row, nowSec, tier)).toBe(true);
    expect(isAffirmativeDexPriceRow({ ...row, source_total_tvl: minTvlUsd - 1 }, nowSec, tier)).toBe(false);
    for (const aggregateObservedAt of [nowSec - maxAgeSec, nowSec - 21_600, null]) {
      expect(isAffirmativeDexPriceRow({ ...row, aggregateObservedAt }, nowSec, tier)).toBe(false);
      expect(getDexAggregateRejectionReason({ ...row, aggregateObservedAt }, nowSec, tier))
        .toBe(aggregateObservedAt == null ? "aggregate-clock-unavailable" : "aggregate-clock-stale");
      expect(isTrustedDexPriceRow(row, nowSec, tier)).toBe(true);
    }
  });

  it("trusts only rows that satisfy the requested tier", () => {
    const thinFreshRow = {
      updated_at: nowSec - 60,
      source_total_tvl: 300_000,
    };

    expect(isTrustedDexPriceRow(thinFreshRow, nowSec, "ui")).toBe(true);
    expect(isTrustedDexPriceRow(thinFreshRow, nowSec, "depeg")).toBe(false);
  });

  it("derives the UI window from the hourly DEX producer cadence plus its stage lead", () => {
    expect(getDexTrustPolicy("ui").maxAgeSec).toBe(
      CRON_INTERVALS["sync-dex-liquidity"] * 2 + DEX_LIQUIDITY_STAGE_LEAD_SEC,
    );
    const stageClock = nowSec - 3_960;
    expect(isTrustedDexPriceRow({ updated_at: stageClock, source_total_tvl: 10_000_000 }, nowSec, "ui")).toBe(true);
  });

  it("rejects future-dated and non-finite rows for every tier", () => {
    const futureRow = {
      updated_at: nowSec + 86_400,
      source_total_tvl: 50_000_000,
    };

    expect(isTrustedDexPriceRow(futureRow, nowSec, "ui")).toBe(false);
    expect(isTrustedDexPriceRow(futureRow, nowSec, "depeg")).toBe(false);
    expect(isTrustedDexPriceRow({ updated_at: Number.NaN, source_total_tvl: 50_000_000 }, nowSec, "ui")).toBe(false);
    expect(isTrustedDexPriceRow({ updated_at: nowSec - 60, source_total_tvl: Number.NaN }, nowSec, "ui")).toBe(false);
  });
});

describe("depeg confirmation source families", () => {
  it.each([
    ["coingecko", "coingecko"], ["cg-ticker", "coingecko"],
    ["defillama-list", "defillama"], ["defillama-contract", "defillama"],
    ["balancer-dex", "dex:balancer"], ["coingecko+geckoterminal", "coingecko+dex:geckoterminal"],
  ])("normalizes correlated CoinGecko and DefiLlama source variants (%s)", (source, expected) => {
    expect(resolveDepegSourceFamily(source)).toBe(expected);
  });

  it.each([
    ["coingecko+pyth", undefined, null],
    ["pyth+coingecko", undefined, null],
    ["defillama-list+coingecko", undefined, null],
    ["pyth", ["pyth", "coingecko"], null],
    ["pyth", ["pyth"], "coingecko-confirm"],
  ])("chooses an independent off-chain confirmer for %s", (priceSource, agreeSources, expected) => {
    expect(chooseIndependentOffchainDepegConfirmer({ priceSource, agreeSources })).toBe(expected);
  });

  it("derives source families from agreeSources before falling back to priceSource order", () => {
    expect([...getPrimaryDepegSourceFamilies({
      priceSource: "pyth",
      agreeSources: ["defillama-list", "coingecko"],
    })].sort()).toEqual(["coingecko", "defillama"]);
  });

  it("expands composite agreeSources before choosing off-chain confirmation family", () => {
    expect(chooseIndependentOffchainDepegConfirmer({
      priceSource: "pyth",
      agreeSources: ["coingecko+geckoterminal"],
    })).toBeNull();
  });

  it("keeps only fresh primary families independent from a native CoinGecko quote", () => {
    const nowSec = 1_700_000_000;
    expect([...getFreshIndependentPrimarySourceFamilies({
      price: 1.15,
      priceSource: "defillama-list+coingecko",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["defillama-list", "coingecko"],
    }, nowSec, "coingecko")]).toEqual(["defillama"]);

    expect([...getFreshIndependentPrimarySourceFamilies({
      price: 1.15,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko"],
    }, nowSec, "coingecko")]).toEqual([]);
  });
});
