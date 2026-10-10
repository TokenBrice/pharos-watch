import { describe, expect, it } from "vitest";
import type { PegReferenceTrustInput } from "@shared/lib/peg-reference-trust";
import { makePythDepegPrice, makeSoftAgreementDepegPrice } from "./depeg-price.test-support";
import {
  chooseIndependentOffchainDepegConfirmer,
  classifyPrimaryDepegTrust,
  getDexTrustPolicy,
  getFreshIndependentPrimarySourceFamilies,
  getPrimaryDepegSourceFamilies,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
  isTrustedDexPriceRow,
  resolveDepegSourceFamily,
} from "../depeg-trust-policy";

describe("classifyPrimaryDepegTrust", () => {
  const nowSec = 1_700_000_000;
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
    { name: "soft single-source", priceSource: "coingecko", priceConfidence: "single-source", agreeSources: ["coingecko"], expected: "confirm_required" },
    { name: "upstream hard single-source", priceSource: "pyth", priceConfidence: "single-source", priceObservedAtMode: "upstream", agreeSources: ["pyth"], expected: "authoritative" },
    { name: "local-fetch hard single-source", priceSource: "kraken", priceConfidence: "single-source", priceObservedAtMode: "local_fetch", agreeSources: ["kraken"], expected: "confirm_required" },
    { name: "soft-only agreement", priceSource: "coingecko+defillama-list", priceConfidence: "high", agreeSources: ["coingecko", "defillama-list"], expected: "confirm_required" },
    { name: "upstream hard source with soft corroboration", priceSource: "coingecko+pyth", priceConfidence: "high", agreeSources: ["coingecko", "pyth"], expected: "authoritative" },
    { name: "lone local-fetch hard source with soft corroboration", priceSource: "coingecko+kraken", priceConfidence: "high", agreeSources: ["coingecko", "kraken"], expected: "confirm_required" },
    { name: "two local-fetch hard sources", priceSource: "binance+kraken", priceConfidence: "high", agreeSources: ["binance", "kraken"], expected: "authoritative" },
    { name: "legacy upstream-capable hard source", priceSource: "pyth", priceConfidence: "single-source", agreeSources: ["pyth"], expected: "authoritative" },
  ] as const)("classifies fresh $name evidence", ({ name: _name, expected, ...provenance }) => {
    expect(classifyPrimaryDepegTrust({
      price: 0.998,
      priceObservedAt: nowSec - 60,
      ...provenance,
      agreeSources: [...provenance.agreeSources],
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

  it("rejects non-high-confidence or fallback-only agreement", () => {
    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.42,
      priceSource: "dexscreener-address+alchemy-address",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      agreeSources: ["dexscreener-address", "alchemy-address"],
    }, nowSec)).toBe(false);

    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.42,
      priceSource: "dexscreener-address+alchemy-address",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["dexscreener-address", "alchemy-address"],
    }, nowSec)).toBe(false);
  });

  it("rejects low-confidence clusters", () => {
    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec, {
      priceConfidence: "low",
    }), nowSec)).toBe(false);
  });

  it.each([[1800, true], [1801, false], [1860, false]] as const)("checks corroborated agreement age at %s seconds", (age, accepted) => {
    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec, {
      priceObservedAt: nowSec - age,
    }), nowSec)).toBe(accepted);
  });
});

describe("isAuthoritativeDepegPegReference", () => {
  it.each([
    { name: "thin fiat median", pegCurrency: "BRL", pegType: "peggedREAL", pegRateSource: "median", pegRateContributorCount: 2, expected: false },
    { name: "fallback-backed thin fiat", pegCurrency: "BRL", pegType: "peggedREAL", pegRateSource: "fallback", pegRateContributorCount: 2, expected: true },
    { name: "robust fiat median", pegCurrency: "EUR", pegType: "peggedEUR", pegRateSource: "median", pegRateContributorCount: 4, expected: true },
    { name: "USD reference", pegCurrency: "USD", pegType: "peggedUSD", pegRateSource: "median", pegRateContributorCount: 1, expected: true },
    { name: "commodity reference", pegCurrency: "GOLD", pegType: "peggedGOLD", pegRateSource: "median", pegRateContributorCount: 1, expected: true },
  ] as const satisfies ReadonlyArray<PegReferenceTrustInput & { name: string; expected: boolean }>)("checks $name authority", ({ name: _name, expected, ...reference }) => {
    expect(isAuthoritativeDepegPegReference(reference)).toBe(expected);
  });
});

describe("DEX trust policy", () => {
  const nowSec = 1_700_000_000;

  it("keeps UI and depeg trust floors explicit", () => {
    expect(getDexTrustPolicy("ui")).toEqual({
      maxAgeSec: 3600,
      minTvlUsd: 250_000,
    });
    expect(getDexTrustPolicy("depeg")).toEqual({
      maxAgeSec: 4500,
      minTvlUsd: 1_000_000,
    });
  });

  it("trusts only rows that satisfy the requested tier", () => {
    const thinFreshRow = {
      updated_at: nowSec - 60,
      source_total_tvl: 300_000,
    };

    expect(isTrustedDexPriceRow(thinFreshRow, nowSec, "ui")).toBe(true);
    expect(isTrustedDexPriceRow(thinFreshRow, nowSec, "depeg")).toBe(false);
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
  it("normalizes correlated CoinGecko and DefiLlama source variants", () => {
    expect(resolveDepegSourceFamily("coingecko")).toBe("coingecko");
    expect(resolveDepegSourceFamily("cg-ticker")).toBe("coingecko");
    expect(resolveDepegSourceFamily("defillama-list")).toBe("defillama");
    expect(resolveDepegSourceFamily("defillama-contract")).toBe("defillama");
    expect(resolveDepegSourceFamily("balancer-dex")).toBe("dex:balancer");
    expect(resolveDepegSourceFamily("coingecko+geckoterminal")).toBe("coingecko+dex:geckoterminal");
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
