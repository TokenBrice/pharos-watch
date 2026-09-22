import { describe, expect, it } from "vitest";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { buildCoinCoverageMap, invalidateMintBurnFlowCaches } from "../mint-burn-flows-service";
import { mockD1 } from "@shared/test-utils/mock-d1";

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

describe("invalidateMintBurnFlowCaches", () => {
  const cacheDeleteTable = { match: "DELETE FROM cache WHERE key >= ? AND key < ?", rows: [] };

  it("purges the whole flow cache range by default", async () => {
    const db = mockD1([cacheDeleteTable]);

    await invalidateMintBurnFlowCaches(db);

    expect(db.getHistory()).toContainEqual({
      sql: "DELETE FROM cache WHERE key >= ? AND key < ?",
      binds: ["mint-burn-flows:v3:", "mint-burn-flows:v3:\uffff"],
    });
  });

  it("keeps the published aggregate gauge rows when includeAggregate is false", async () => {
    const db = mockD1([cacheDeleteTable]);

    await invalidateMintBurnFlowCaches(db, { includeAggregate: false });

    const deletes = db.getHistory().filter(({ sql }) => sql.includes("DELETE FROM cache"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].binds).toEqual(["mint-burn-flows:v3:coin:", "mint-burn-flows:v3:coin:\uffff"]);
  });
});
