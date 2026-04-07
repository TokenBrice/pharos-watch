import { describe, expect, it } from "vitest";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
} from "../depeg-helpers";

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

  it("requires confirmation for hard single-source prices with local-fetch freshness", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "kraken",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      priceObservedAtMode: "local_fetch",
      agreeSources: ["kraken"],
    }, nowSec)).toBe("confirm_required");
  });

  it("requires confirmation for soft-only high-confidence agreement", () => {
    expect(classifyPrimaryDepegTrust({
      price: 1.0,
      priceSource: "coingecko+defillama-list",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "defillama-list"],
    }, nowSec)).toBe("confirm_required");
  });

  it("treats an upstream-capable hard source plus soft corroboration as authoritative", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.998,
      priceSource: "coingecko+pyth",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "pyth"],
    }, nowSec)).toBe("authoritative");
  });

  it("requires confirmation for a lone local-fetch hard source plus soft corroboration", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "coingecko+kraken",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "kraken"],
    }, nowSec)).toBe("confirm_required");
  });

  it("accepts two authoritative local-fetch hard sources in agreement", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "binance+kraken",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["binance", "kraken"],
    }, nowSec)).toBe("authoritative");
  });

  it("uses source observation time rather than sync-write time for freshness", () => {
    expect(classifyPrimaryDepegTrust({
      price: 1.0,
      priceSource: "pyth",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - (31 * 60),
      priceUpdatedAt: nowSec - 30,
      agreeSources: ["pyth"],
    }, nowSec)).toBe("confirm_required");
  });

  it("keeps legacy null freshness mode backward-compatible for upstream-capable hard sources", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "pyth",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      agreeSources: ["pyth"],
    }, nowSec)).toBe("authoritative");
  });
});

describe("hasFreshMultiSourcePrimaryAgreement", () => {
  const nowSec = 1_700_000_000;

  it("accepts fresh corroborated soft-source agreement for recovery handling", () => {
    expect(hasFreshMultiSourcePrimaryAgreement({
      price: 0.999,
      priceSource: "coingecko+defillama-list",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "defillama-list"],
    }, nowSec)).toBe(true);
  });

  it("rejects stale or low-confidence price clusters", () => {
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
  it("rejects thin fiat peer medians without an FX fallback", () => {
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

  it("leaves USD and commodity references unchanged", () => {
    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "USD",
      pegType: "peggedUSD",
      pegRateSource: "median",
      pegRateContributorCount: 1,
    })).toBe(true);

    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "GOLD",
      pegType: "peggedGOLD",
      pegRateSource: "median",
      pegRateContributorCount: 1,
    })).toBe(true);
  });
});
