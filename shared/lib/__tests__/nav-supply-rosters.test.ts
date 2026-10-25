import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "../stablecoins/registry";
import { CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS, getOnchainSupplyHoldReason, onchainSupplyProbeFamily, selectCuratedAggregateOnchainSupplyProbeContracts } from "../onchain-supply-probe";

describe("NAV native supply rosters", () => {
  for (const meta of TRACKED_META_BY_ID.values()) {
    if (!meta.id.endsWith("-spiko") && meta.id !== "safo-spiko-usd" && meta.id !== "usdy-ondo-finance") continue;
    it(`requires every reviewed ${meta.symbol} leg or exact IBC representation accounting`, () => {
      if (!["ustbl-spiko", "eurspkcc-spiko", "usdy-ondo-finance"].includes(meta.id)) {
        expect(selectCuratedAggregateOnchainSupplyProbeContracts(meta)).toBeNull();
        return;
      }
      const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta)!;
      const excluded = CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS[meta.id] ?? [];
      expect(selected).not.toBeNull();
      expect(selected.length + excluded.length).toBe(meta.contracts!.length);
      for (const contract of meta.contracts!) {
        expect(selected.some((leg) => leg.contract === contract)
          || excluded.some((leg) => leg.chain === contract.chain && leg.address === contract.address)).toBe(true);
        expect(selectCuratedAggregateOnchainSupplyProbeContracts({ ...meta, contracts: meta.contracts!.filter((entry) => entry !== contract) })).toBeNull();
      }
      expect(selectCuratedAggregateOnchainSupplyProbeContracts({ ...meta,
        contracts: [...meta.contracts!, { chain: "unknown", address: "unreviewed", decimals: 7 }],
      })).toBeNull();
    });
  }
  it.each(["eursafo-spiko", "safo-spiko-usd", "gbpsafo-spiko", "chfsafo-spiko"])("withholds %s until its issuer-listed ArbitrumUk perimeter is reconciled", (id) => {
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(TRACKED_META_BY_ID.get(id)!)).toBeNull();
    expect(getOnchainSupplyHoldReason(id)).toBeNull();
  });
  it("does not excuse mutated IBC denominations or omit their canonical backing leg", () => {
    const meta = TRACKED_META_BY_ID.get("usdy-ondo-finance")!;
    expect(selectCuratedAggregateOnchainSupplyProbeContracts({ ...meta,
      contracts: meta.contracts!.map((contract) => contract.chain === "osmosis" ? { ...contract, address: "ibc/other" } : contract),
    })).toBeNull();
  });
  it("recognizes only supported Stellar identities, native Noble and the reviewed Sui coin", () => {
    for (const meta of TRACKED_META_BY_ID.values()) {
      if (meta.id !== "usdy-ondo-finance" && !meta.id.includes("spiko")) continue;
      for (const contract of meta.contracts ?? []) {
        if (["stellar", "noble", "sui"].includes(contract.chain)) expect(onchainSupplyProbeFamily(contract)).toBe(contract.chain);
      }
    }
    expect(onchainSupplyProbeFamily({ chain: "stellar", address: "USDY-Cbad", decimals: 7 })).toBeNull();
    expect(onchainSupplyProbeFamily({ chain: "noble", address: "ibc/unknown", decimals: 18 })).toBeNull();
    expect(onchainSupplyProbeFamily({ chain: "sui", address: "0x123::unknown::COIN", decimals: 6 })).toBeNull();
  });
});
