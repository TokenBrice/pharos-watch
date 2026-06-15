import { describe, expect, it } from "vitest";
import {
  resolveYieldSourceKeyRoute,
  YIELD_SOURCE_KEY_ROUTES,
} from "../yield-source-key-routing";
import { inferVenueProtocol } from "../source-risk";
import { getSupplementalCandidateFamily } from "../supplemental-source-families";

/**
 * Audit R-080: the three prefix-routing consumers (inferVenueProtocol,
 * inferVenueChain, getSupplementalCandidateFamily) now derive from one table.
 * This locks the prefix -> {protocol, family, chain-segment} mapping so the
 * functions cannot drift apart again.
 */
describe("yield source-key routing table", () => {
  const cases: Array<{
    sourceKey: string;
    venueProtocol: string;
    family: string;
    chain: string;
  }> = [
    { sourceKey: "protocol-api:morpho-vault:ethereum:0xabc", venueProtocol: "morpho-blue", family: "morpho", chain: "ethereum" },
    { sourceKey: "protocol-api:pendle:arbitrum:0xdef", venueProtocol: "pendle", family: "pendle", chain: "arbitrum" },
    { sourceKey: "protocol-api:yearn:ethereum:0x111", venueProtocol: "yearn", family: "yearnKong", chain: "ethereum" },
    { sourceKey: "protocol-api:kong:base:0x222", venueProtocol: "kong", family: "yearnKong", chain: "base" },
    { sourceKey: "protocol-api:k3:ethereum:0x333", venueProtocol: "k3", family: "yearnKong", chain: "ethereum" },
    { sourceKey: "protocol-api:beefy:optimism:0x444", venueProtocol: "beefy", family: "beefy", chain: "optimism" },
    { sourceKey: "protocol-api:compound-v3-supply:ethereum:0x555", venueProtocol: "compound-v3", family: "compoundV3", chain: "ethereum" },
    { sourceKey: "aave-v3-onchain:base:0x666", venueProtocol: "aave-v3", family: "aaveV3", chain: "base" },
    { sourceKey: "royco-dawn:ethereum:tranche-1", venueProtocol: "royco-dawn", family: "roycoDawn", chain: "ethereum" },
  ];

  it.each(cases)(
    "routes $sourceKey to the correct protocol, family, and chain segment",
    ({ sourceKey, venueProtocol, family, chain }) => {
      const route = resolveYieldSourceKeyRoute(sourceKey);
      expect(route).not.toBeNull();
      expect(route?.venueProtocol).toBe(venueProtocol);
      expect(route?.family).toBe(family);
      expect(sourceKey.split(":")[route!.chainSegmentIndex]).toBe(chain);

      // The public consumers stay in lockstep with the table.
      expect(inferVenueProtocol({ sourceKey, dataSource: "protocol-api" })).toBe(venueProtocol);
      expect(getSupplementalCandidateFamily(sourceKey)).toBe(family);
    },
  );

  it("returns null for unmatched and empty source keys", () => {
    expect(resolveYieldSourceKeyRoute("dl-list:usdc")).toBeNull();
    expect(resolveYieldSourceKeyRoute(null)).toBeNull();
    expect(resolveYieldSourceKeyRoute(undefined)).toBeNull();
    expect(getSupplementalCandidateFamily("dl-list:usdc")).toBeNull();
    expect(getSupplementalCandidateFamily(null)).toBeNull();
  });

  it("falls back to derived dataSource for inferVenueProtocol when no prefix matches", () => {
    expect(inferVenueProtocol({ sourceKey: "dl-list:usdc", dataSource: "rate-derived" })).toBe("rate-derived");
    expect(inferVenueProtocol({ sourceKey: "dl-list:usdc", dataSource: "price-derived" })).toBe("price-derived");
    expect(inferVenueProtocol({ sourceKey: "dl-list:usdc", dataSource: "protocol-api" })).toBeNull();
  });

  it("has no duplicate prefixes", () => {
    const prefixes = YIELD_SOURCE_KEY_ROUTES.map((route) => route.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
