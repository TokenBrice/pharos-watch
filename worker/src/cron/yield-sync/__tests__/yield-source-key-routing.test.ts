import { describe, expect, it } from "vitest";
import {
  resolveYieldSourceKeyRoute,
  YIELD_SOURCE_KEY_ROUTES,
} from "../yield-source-key-routing";
import { buildYieldSourceRisk, resolveYieldVenueProtocol } from "../source-risk";
import type { EvaluatedYieldSource } from "../evaluation-types";
import { getSupplementalCandidateFamily } from "../supplemental-source-families";
import { DIRECT_PROTOCOL_API_SOURCE_KEYS } from "../../../lib/yield-config/yield-config-rate-sources";

/**
 * Audit R-080: the prefix-routing consumers (the venue resolver,
 * `inferVenueChain`, `getSupplementalCandidateFamily`) derive from one table.
 * This locks the prefix -> {protocol, family, chain-segment} mapping so the
 * functions cannot drift apart again.
 */
describe("yield source-key routing table", () => {
  const cases: Array<{
    sourceKey: string;
    venueProtocol: string;
    family: string | null;
    chain: string | null;
  }> = [
    { sourceKey: "protocol-api:morpho-vault:ethereum:0xabc", venueProtocol: "morpho-blue", family: "morpho", chain: "ethereum" },
    { sourceKey: "protocol-api:pendle:arbitrum:0xdef", venueProtocol: "pendle", family: "pendle", chain: "arbitrum" },
    { sourceKey: "protocol-api:yearn:ethereum:0x111", venueProtocol: "yearn", family: "yearnKong", chain: "ethereum" },
    { sourceKey: "protocol-api:kong:base:0x222", venueProtocol: "kong", family: "yearnKong", chain: "base" },
    { sourceKey: "protocol-api:k3:ethereum:0x333", venueProtocol: "k3", family: "yearnKong", chain: "ethereum" },
    { sourceKey: "protocol-api:beefy:optimism:0x444", venueProtocol: "beefy", family: "beefy", chain: "optimism" },
    { sourceKey: "protocol-api:vaults-fyi:base:0x777", venueProtocol: "vaults-fyi", family: "vaultsFyi", chain: "base" },
    { sourceKey: "protocol-api:compound-v3-supply:ethereum:0x555", venueProtocol: "compound-v3", family: "compoundV3", chain: "ethereum" },
    { sourceKey: "aave-v3-onchain:base:0x666", venueProtocol: "aave-v3", family: "aaveV3", chain: "base" },
    { sourceKey: "royco-dawn:ethereum:tranche-1", venueProtocol: "royco-dawn", family: "roycoDawn", chain: "ethereum" },
    // B29: standalone first-party readers — no chain segment, no supplemental family.
    { sourceKey: "protocol-api:bima-susbd", venueProtocol: "bima", family: null, chain: null },
    { sourceKey: "protocol-api:etherfuse-cetes-current-issuance", venueProtocol: "etherfuse", family: null, chain: null },
    { sourceKey: "protocol-api:hashnote-usyc", venueProtocol: "hashnote", family: null, chain: null },
    { sourceKey: "protocol-api:ondo-usdy-oracle", venueProtocol: "ondo-yield-assets", family: null, chain: null },
    { sourceKey: "protocol-api:midas-mmev-nav-oracle", venueProtocol: "midas-rwa", family: null, chain: null },
    { sourceKey: "protocol-api:re-protocol-reusd", venueProtocol: "re-protocol", family: null, chain: null },
    { sourceKey: "protocol-api:zys-zephyr-protocol", venueProtocol: "zephyr-protocol", family: null, chain: null },
    { sourceKey: "onchain:scrvusd-curve:scrvusd-current-rate", venueProtocol: "curve-llamalend", family: null, chain: null },
    { sourceKey: "onchain:lusd-liquity", venueProtocol: "liquity-v1", family: null, chain: null },
    { sourceKey: "onchain:bold-liquity", venueProtocol: "liquity-v2", family: null, chain: null },
    { sourceKey: "onchain:bd-basedollar", venueProtocol: "base-dollar", family: null, chain: null },
  ];

  it.each(cases)(
    "routes $sourceKey to the correct protocol, family, and chain segment",
    ({ sourceKey, venueProtocol, family, chain }) => {
      const route = resolveYieldSourceKeyRoute(sourceKey);
      expect(route).not.toBeNull();
      expect(route?.venueProtocol).toBe(venueProtocol);
      expect(route?.family).toBe(family);
      expect(buildYieldSourceRisk({
        source: { sourceKey, dataSource: "protocol-api", sourceRiskPenalty: 1 } as EvaluatedYieldSource,
        provenance: null,
        isBest: true,
      }).venueChain).toBe(chain);

      // The public consumers stay in lockstep with the table.
      expect(resolveYieldVenueProtocol({ sourceKey })).toBe(venueProtocol);
      expect(getSupplementalCandidateFamily(sourceKey)).toBe(family);
    },
  );

  it("routes every emitted first-party protocol-api source key", () => {
    // B29: these keys are emitted by the adapter registry; an unrouted key loses
    // venue attribution and can never reach evidence completeness 1.
    for (const sourceKey of Object.values(DIRECT_PROTOCOL_API_SOURCE_KEYS)) {
      expect(resolveYieldSourceKeyRoute(sourceKey), sourceKey).not.toBeNull();
    }
    // The three `onchain:<coinId>` readers are part of the same set.
    expect(resolveYieldSourceKeyRoute("onchain:lusd-liquity")).not.toBeNull();
    expect(resolveYieldSourceKeyRoute("onchain:bold-liquity")).not.toBeNull();
    expect(resolveYieldSourceKeyRoute("onchain:bd-basedollar")).not.toBeNull();
  });

  it("never publishes the row's derivation method as a venue", () => {
    for (const dataSource of ["price-derived", "rate-derived"]) {
      expect(resolveYieldVenueProtocol({
        sourceKey: `dl-list:${dataSource}`,
        venueProtocol: dataSource,
        stablecoinId: "usdc-circle",
      })).toBeNull();
      // A stored value from an earlier publication cannot reintroduce the token.
      expect(buildYieldSourceRisk({
        source: {
          sourceKey: "dl-list:usdc",
          dataSource,
          sourceRiskPenalty: 1,
          sourceRisk: { venueProtocol: dataSource },
        } as EvaluatedYieldSource,
        provenance: null,
        isBest: true,
      }).venueProtocol).toBeNull();
    }
    expect(resolveYieldVenueProtocol({ sourceKey: "dl-list:usdc", project: "rate-derived" })).toBeNull();
  });

  it("prefers existing risk chain, then explicit source chain, over routed chain", () => {
    const source = {
      sourceKey: "protocol-api:pendle:arbitrum:0xdef",
      dataSource: "protocol-api",
      sourceRiskPenalty: 1,
      venueChain: "base",
    } as EvaluatedYieldSource;
    expect(buildYieldSourceRisk({ source, provenance: null, isBest: true }).venueChain).toBe("base");
    expect(buildYieldSourceRisk({
      source: { ...source, sourceRisk: { venueChain: "ethereum" } as EvaluatedYieldSource["sourceRisk"] },
      provenance: null,
      isBest: true,
    }).venueChain).toBe("ethereum");
  });

  it("returns null for unmatched and empty source keys", () => {
    expect(resolveYieldSourceKeyRoute("dl-list:usdc")).toBeNull();
    expect(resolveYieldSourceKeyRoute(null)).toBeNull();
    expect(resolveYieldSourceKeyRoute(undefined)).toBeNull();
    expect(getSupplementalCandidateFamily("dl-list:usdc")).toBeNull();
    expect(getSupplementalCandidateFamily(null)).toBeNull();
  });

  it("has no duplicate prefixes", () => {
    const prefixes = YIELD_SOURCE_KEY_ROUTES.map((route) => route.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
