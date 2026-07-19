import { describe, expect, it } from "vitest";
import {
  chooseIndependentOffchainDepegConfirmer,
  classifyPrimaryDepegTrust,
  getDexTrustPolicy,
  getPrimaryDepegSourceFamilies,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
  isTrustedDexPriceRow,
  resolveDepegSourceFamily,
} from "../depeg-trust-policy";

describe("classifyPrimaryDepegTrust", () => {
  const nowSec = 1_700_000_000;

  it("requires confirmation for fresh soft single-source prices", () => {
    expect(classifyPrimaryDepegTrust({
      price: 1.01,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko"],
    }, nowSec)).toBe("confirm_required");
  });

  it("allows fresh hard single-source prices to remain authoritative", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.998,
      priceSource: "pyth",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      priceObservedAtMode: "upstream",
      agreeSources: ["pyth"],
    }, nowSec)).toBe("authoritative");
  });

  it("requires confirmation for future-dated primary observations", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.998,
      priceSource: "pyth",
      priceConfidence: "single-source",
      priceObservedAt: nowSec + 60,
      priceObservedAtMode: "upstream",
      agreeSources: ["pyth"],
    }, nowSec)).toBe("confirm_required");
  });

  it("uses source observation time rather than sync-write time for freshness", () => {
    expect(classifyPrimaryDepegTrust({
      price: 1,
      priceSource: "pyth",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - (31 * 60),
      priceUpdatedAt: nowSec - 30,
      agreeSources: ["pyth"],
    }, nowSec)).toBe("confirm_required");
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
    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.999,
      priceSource: "coingecko+defillama-list",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "defillama-list"],
    }, nowSec)).toBe(true);
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

  it("rejects stale or low-confidence clusters", () => {
    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.999,
      priceSource: "coingecko+defillama-list",
      priceConfidence: "low",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "defillama-list"],
    }, nowSec)).toBe(false);

    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.999,
      priceSource: "coingecko+defillama-list",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - (31 * 60),
      agreeSources: ["coingecko", "defillama-list"],
    }, nowSec)).toBe(false);
  });
});

describe("isAuthoritativeDepegPegReference", () => {
  it("rejects thin fiat peer medians without fallback", () => {
    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "BRL",
      pegType: "peggedREAL",
      pegRateSource: "median",
      pegRateContributorCount: 2,
    })).toBe(false);
  });

  it("accepts fallback-backed thin fiat references and robust medians", () => {
    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "BRL",
      pegType: "peggedREAL",
      pegRateSource: "fallback",
      pegRateContributorCount: 2,
    })).toBe(true);

    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "EUR",
      pegType: "peggedEUR",
      pegRateSource: "median",
      pegRateContributorCount: 4,
    })).toBe(true);
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
      maxAgeSec: 2100,
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
    ["coingecko+pyth", undefined, "defillama-confirm"],
    ["pyth+coingecko", undefined, "defillama-confirm"],
    ["defillama-list+coingecko", undefined, null],
    ["pyth", ["pyth", "coingecko"], "defillama-confirm"],
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
    })).toBe("defillama-confirm");
  });
});
