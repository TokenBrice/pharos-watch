import { describe, expect, it } from "vitest";
import {
  classifyPrimaryDepegTrust,
  getDexTrustPolicy,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
  isTrustedDexPriceRow,
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
});

describe("hasFreshMultiSourcePrimaryAgreement", () => {
  const nowSec = 1_700_000_000;

  it("accepts fresh corroborated multi-source agreement", () => {
    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.999,
      priceSource: "coingecko+defillama-list",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "defillama-list"],
    }, nowSec)).toBe(true);
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
