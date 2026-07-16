import { describe, it, expect } from "vitest";
import { PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import { CIRCUIT_SOURCE } from "../constants";
import { PRICING_SOURCE_CIRCUIT_METADATA, PRICING_SOURCE_TO_CIRCUIT } from "../pricing-circuit-map";

describe("PRICING_SOURCE_TO_CIRCUIT contract", () => {
  it("every registry source has an entry in PRICING_SOURCE_TO_CIRCUIT", () => {
    for (const entry of PRICING_SOURCE_REGISTRY) {
      expect(PRICING_SOURCE_TO_CIRCUIT).toHaveProperty(entry.key);
      expect(PRICING_SOURCE_CIRCUIT_METADATA).toHaveProperty(entry.key);
    }
  });

  it("every mapped breaker value exists in CIRCUIT_SOURCE", () => {
    const circuitValues = new Set(Object.values(CIRCUIT_SOURCE));
    for (const value of Object.values(PRICING_SOURCE_TO_CIRCUIT)) {
      if (value == null) continue;
      expect(circuitValues).toContain(value);
    }
  });

  it("PRICING_SOURCE_TO_CIRCUIT has no keys missing from registry", () => {
    const registryKeys = new Set(PRICING_SOURCE_REGISTRY.map((e) => e.key));
    for (const key of Object.keys(PRICING_SOURCE_TO_CIRCUIT)) {
      expect(registryKeys).toContain(key);
    }
    for (const key of Object.keys(PRICING_SOURCE_CIRCUIT_METADATA)) {
      expect(registryKeys).toContain(key);
    }
  });

  it("distinguishes directly enforced sources from synthesized and cached sources", () => {
    expect(PRICING_SOURCE_CIRCUIT_METADATA["dexscreener-exact"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.DEXSCREENER_PRICES,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["dexscreener-search"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.DEXSCREENER_SEARCH,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["dexpaprika-address"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.DEXPAPRIKA_PRICES,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["moralis-address"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.MORALIS_PRICES,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["birdeye-address"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.BIRDEYE_PRICES,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["coingecko-native-implied"]).toMatchObject({
      circuit: null,
      enforced: false,
      enforcementPath: "synthesized",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["protocol-redeem"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["kava-pricefeed"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.KAVA_PRICEFEED,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["aerodrome-onchain"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.USX_STABLE_POOLS,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["velodrome-onchain"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.USX_STABLE_POOLS,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA["curve-thin-onchain"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.AZND_CURVE_POOL,
      enforced: true,
      enforcementPath: "direct-provider",
    });
    expect(PRICING_SOURCE_CIRCUIT_METADATA.cached).toMatchObject({
      circuit: null,
      enforced: false,
      enforcementPath: "cache",
    });
  });

  it("maps coingecko-mirror to the DefiLlama coins circuit that actually serves it", () => {
    expect(PRICING_SOURCE_CIRCUIT_METADATA["coingecko-mirror"]).toMatchObject({
      circuit: CIRCUIT_SOURCE.DL_COINS,
      enforced: true,
    });
  });
});
