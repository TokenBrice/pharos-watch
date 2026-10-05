import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem/utils";
import { runAdapter, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";

const POOL = "0x1116898dda4015ed8ddefb84b6e8bc24528af2d8";
const TOKENS = [
  { name: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18, price: 0.9995 },
  { name: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, price: 1.0001 },
  { name: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, price: 1.0002 },
];
const LP_BALANCE = toFunctionSelector("getTokenBalance(uint8)");

// Real pinned reads from W3R31 research.json and R19 pinned-research.json.
// Prices are deliberately non-par fixture quotes, not historical price evidence.
const SNAPSHOTS = [
  {
    label: "W3R31", block: 26_122_495, timestamp: 1_791_160_000,
    lp: [617389085826156595665681n, 566903163736n, 789980651321n],
    admin: [97384663098483469878n, 89102822n, 171511020n],
    raw: [617486470489255079135559n, 566992266558n, 790152162341n],
  },
  {
    label: "R19", block: 26_124_986, timestamp: 1_791_189_059,
    lp: [548198898201131974057105n, 558846038023n, 867241759398n],
    admin: [104303681860985932031n, 90039784n, 171511020n],
    raw: [548303201882992959989136n, 558936077807n, 867413270418n],
  },
];

type Snapshot = typeof SNAPSHOTS[number];
function networkFor(snapshot: Snapshot, options: {
  multicall?: boolean; missingBalance?: number; missingPrice?: number; wrongDecimals?: number;
} = {}): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {};
  const coins: Record<string, unknown> = {};
  for (const [index, token] of TOKENS.entries()) {
    const args = BigInt(index).toString(16).padStart(64, "0");
    rpc[`${POOL}:${LP_BALANCE}${args}`] = index === options.missingBalance ? null : snapshot.lp[index];
    // Positive raw balances remain available: failed LP reads must never use them.
    rpc[`${token.address}:balanceOf(address)`] = snapshot.raw[index];
    rpc[`${token.address}:decimals()`] = index === options.wrongDecimals ? 18n : BigInt(token.decimals);
    if (index !== options.missingPrice) {
      coins[`ethereum:${token.address}`] = { price: token.price, timestamp: snapshot.timestamp, confidence: 0.99 };
    }
  }
  return {
    block: { number: snapshot.block, timestamp: snapshot.timestamp },
    multicall: options.multicall,
    rpc,
    json: {
      [`https://coins.llama.fi/prices/current/${TOKENS.filter((_, index) => index !== options.missingBalance).map(token => `ethereum:${token.address}`).sort().join(",")}`]: { coins },
    },
  };
}

function pricedValue(amount: bigint, index: number): number {
  return Number(amount) / 10 ** TOKENS[index].decimals * TOKENS[index].price;
}

describe("nUSD LP-attributable reserve observation", () => {
  for (const snapshot of SNAPSHOTS) {
    it.each([true, false])(`excludes ${snapshot.label} admin balances with multicall=%s at one pinned block`, async (multicall) => {
      const { result, network } = await runAdapter("evm-branch-balances", "nusd-nexus", {
        network: networkFor(snapshot, { multicall }), nowSec: snapshot.timestamp,
      });
      const lpValue = snapshot.lp.reduce((sum, amount, index) => sum + pricedValue(amount, index), 0);
      const adminValue = snapshot.admin.reduce((sum, amount, index) => sum + pricedValue(amount, index), 0);
      const rawValue = snapshot.raw.reduce((sum, amount, index) => sum + pricedValue(amount, index), 0);
      expect(rawValue - lpValue).toBeCloseTo(adminValue, 7);
      const details = result.metadata!.details as {
        knownReserveValueUsd: number;
        branchObservations: Array<{ name: string; balanceRaw: string }>;
      };
      // The production valuation rounds each of the three values to USD micros.
      expect(Math.abs(details.knownReserveValueUsd - lpValue)).toBeLessThanOrEqual(0.0000015);
      expect(details.branchObservations.map(row => row.balanceRaw)).toEqual(snapshot.lp.map(String));
      expect(result.slices).toHaveLength(3);
      expect(result.slices).toEqual(expect.arrayContaining(TOKENS.map((token, index) => expect.objectContaining({
        name: token.name, pct: Number((pricedValue(snapshot.lp[index], index) / lpValue * 100).toFixed(1)),
      }))));
      expect(result.metadata).toMatchObject({
        observedBlock: { chain: "ethereum", number: snapshot.block, timestamp: snapshot.timestamp },
        valuationComplete: true, censusComplete: false,
        unknownExposureUnavailableReason: "configured-branches-not-certified-census",
      });
      expect(result.metadata!.collateralizationRatio).toBeUndefined();
      const reads = network.rpcCalls.filter(call => call.method === "eth_call");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(call => call.block === `0x${snapshot.block.toString(16)}`)).toBe(true);
    });
  }

  for (const missingBalance of [0, 1, 2]) {
    it.each([true, false])(`withholds weights when LP branch ${missingBalance} is unavailable, multicall=%s`, async (multicall) => {
      const snapshot = SNAPSHOTS[1];
      const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
        network: networkFor(snapshot, { multicall, missingBalance }), nowSec: snapshot.timestamp,
      });
      expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
      expect(result.metadata).toMatchObject({ valuationComplete: false, censusComplete: false, unknownExposurePct: 100 });
      expect(result.metadata!.details).toMatchObject({
        contextualObservationsOnly: true,
        unavailableBranches: [{ name: TOKENS[missingBalance].name, reason: "balance-unavailable" }],
      });
      expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch-reserve-book-partial" })]));
    });
  }

  it("withholds weights when a positive LP constituent is unpriced", async () => {
    const snapshot = SNAPSHOTS[1];
    const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
      network: networkFor(snapshot, { missingPrice: 1 }), nowSec: snapshot.timestamp,
    });
    expect(result.slices).toEqual([{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" }]);
    expect(result.metadata).toMatchObject({ valuationComplete: false, unknownExposurePct: 100 });
    expect(result.metadata!.details).toMatchObject({ unavailableBranches: [{ name: "USDC", reason: "price-unavailable" }] });
  });

  it("rejects a changed token-decimals identity instead of admitting LP amounts at the wrong scale", async () => {
    const snapshot = SNAPSHOTS[1];
    const { result } = await runAdapter("evm-branch-balances", "nusd-nexus", {
      network: networkFor(snapshot, { wrongDecimals: 1 }), nowSec: snapshot.timestamp,
    });
    expect(result.metadata).toMatchObject({ valuationComplete: false, unknownExposurePct: 100 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch-token-decimals-mismatch", effect: "fatal" })]));
  });
});
