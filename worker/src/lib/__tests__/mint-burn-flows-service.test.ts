import { describe, expect, it } from "vitest";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { buildCoinCoverageMap } from "../mint-burn-flows-service";
import { mintBurnConfigKey } from "../mint-burn-pipeline/sync-state";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { makeMintBurnScanSegments } from "../../test-helpers/__shared/mint-burn";
import type { MintBurnScanSegment } from "../mint-burn-pipeline/scan-coverage";

const DAY = 86400;
const END = 200 * DAY + 12 * 3600;
function segmentMap(rows: MintBurnScanSegment[]) {
  const result = new Map<string, MintBurnScanSegment[]>();
  for (const row of rows) result.set(row.config_key, [...(result.get(row.config_key) ?? []), row]);
  return result;
}

describe("buildCoinCoverageMap", () => {
  it("does not treat an Ethereum-sized one-day block span as 24 hours on Base", () => {
    const config = MINT_BURN_CONFIGS.find((entry) => entry.chain.chainId === "base")!;
    const lastSyncedBlock = config.startBlock + (24 * 60 * 60) / 12;
    const coverage = buildCoinCoverageMap(END, new Map(),
      new Map([[mintBurnConfigKey(config), lastSyncedBlock]]), new Map([["base", lastSyncedBlock]]));
    expect(coverage.get(config.stablecoinId)?.has24hWindow).toBe(false);
  });

  const config = makeMintBurnConfig();
  const other = makeMintBurnConfig({ chain: { chainId: "arbitrum" } });
  const configs = [config, other];
  function coverage(rows: MintBurnScanSegment[]) {
    return buildCoinCoverageMap(END + 1799, segmentMap(rows), new Map(), new Map(), null, configs).get(config.stablecoinId)!;
  }

  it("never infers bootstrap or legacy windows from cursor positions", () => {
    const result = coverage([]);
    expect(result).toMatchObject({ has24hWindow: false, has7dWindow: false, has30dWindow: false, has90dWindow: false,
      historyStartAt: null, unavailableReason: "scan-coverage-incomplete" });
  });

  it("requires every configured contract and chain even when the scanned member is quiet", () => {
    expect(coverage(makeMintBurnScanSegments(END, 90, [config])).has24hWindow).toBe(false);
    const complete = coverage(makeMintBurnScanSegments(END, 90, configs));
    expect(complete).toMatchObject({ has24hWindow: true, has7dWindow: true, has30dWindow: true, has90dWindow: true,
      unavailableReason: null });
  });

  it("admits each closed window independently instead of promoting a recent scan into long history", () => {
    for (const days of [1, 7, 30, 90]) {
      const result = coverage(makeMintBurnScanSegments(END, days, configs));
      expect([result.has24hWindow, result.has7dWindow, result.has30dWindow, result.has90dWindow])
        .toEqual([1, 7, 30, 90].map((window) => window <= days));
    }
  });

  it("withholds a lagging last hour and an old gapped window without losing the complete 24h window", () => {
    const lagging = makeMintBurnScanSegments(END, 90, configs).map((row) => ({ ...row, to_timestamp: END - 1 }));
    expect(coverage(lagging).has24hWindow).toBe(false);
    const rows = configs.flatMap((source) => {
      const [recent] = makeMintBurnScanSegments(END, 1, [source]);
      return [{ ...recent, from_block: 300, to_block: 400 },
        { ...recent, from_block: 100, to_block: 298, from_timestamp: END - 90 * DAY, to_timestamp: END - DAY }];
    }).sort((a, b) => a.from_block - b.from_block);
    expect(coverage(rows)).toMatchObject({ has24hWindow: true, has7dWindow: false, has30dWindow: false, has90dWindow: false });
  });
});
