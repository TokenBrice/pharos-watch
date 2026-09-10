import { describe, expect, it } from "vitest";
import { capabilityForPool } from "../p4-exit-route-capability-policy";

const DL_POOL = {
  poolId: "ethereum:0xabc",
  project: "uniswap-v3",
  chain: "ethereum",
  tvlUsd: 1_000_000,
  symbol: "USDC-USDT",
  poolType: "uniswap-v3-5bp",
  source: "dl" as const,
};

describe("capabilityForPool", () => {
  it("classifies a decayed dl row as discovery-pool-shaped, not defillama-pool-shaped", () => {
    expect(capabilityForPool({ ...DL_POOL, extra: { measurement: { decayed: true } } }).id).toBe(
      "discovery-pool-shaped",
    );
    expect(capabilityForPool({ ...DL_POOL, extra: { measurement: { decayed: false } } }).id).toBe(
      "defillama-pool-shaped",
    );
  });
});
