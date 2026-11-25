import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "../stablecoins/registry";
import { CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS, onchainSupplyProbeFamily, selectCuratedAggregateOnchainSupplyProbeContracts } from "../onchain-supply-probe";

describe("NAV native supply rosters", () => {
  for (const id of ["eutbl-spiko", "ustbl-spiko"] as const) {
    const meta = TRACKED_META_BY_ID.get(id)!;
    it(`requires every reviewed ${meta.symbol} leg or exact representation accounting`, () => {
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
  it("recognizes only supported Stellar identities and the reviewed Sui coin", () => {
    for (const id of ["eutbl-spiko", "ustbl-spiko"] as const) {
      const meta = TRACKED_META_BY_ID.get(id)!;
      for (const contract of meta.contracts ?? []) {
        if (contract.chain === "stellar") expect(onchainSupplyProbeFamily(contract)).toBe("stellar");
      }
    }
    expect(onchainSupplyProbeFamily({ chain: "stellar", address: "USDY-Cbad", decimals: 7 })).toBeNull();
    expect(onchainSupplyProbeFamily({ chain: "noble", address: "ausdy", decimals: 18 })).toBeNull();
    expect(onchainSupplyProbeFamily({ chain: "sui", address: "0x123::unknown::COIN", decimals: 6 })).toBeNull();
  });
});
