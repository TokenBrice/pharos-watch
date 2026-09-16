import { describe, expect, it } from "vitest";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { buildCoinCoverageMap } from "../mint-burn-flows-service";

describe("buildCoinCoverageMap", () => {
  it("does not treat an Ethereum-sized one-day block span as 24 hours on Base", () => {
    const config = MINT_BURN_CONFIGS.find((entry) => entry.chain.chainId === "base");
    expect(config).toBeDefined();
    if (!config) return;

    const configsForCoin = MINT_BURN_CONFIGS.filter(
      (entry) => entry.stablecoinId === config.stablecoinId,
    );
    expect(configsForCoin).toHaveLength(1);

    const ethereumOneDayBlocks = (24 * 60 * 60) / 12;
    const lastSyncedBlock = config.startBlock + ethereumOneDayBlocks;
    const coverage = buildCoinCoverageMap(
      200 * 24 * 60 * 60,
      [],
      new Map([[`${config.chain.chainId}-${config.contractAddress}`, lastSyncedBlock]]),
      new Map([[config.chain.chainId, lastSyncedBlock]]),
    );

    expect(coverage.get(config.stablecoinId)?.has24hWindow).toBe(false);
  });
});
