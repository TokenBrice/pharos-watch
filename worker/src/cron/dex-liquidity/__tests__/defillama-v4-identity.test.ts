import { describe, expect, it } from "vitest";
import { attachDefiLlamaV4PoolIdentities } from "../defillama-v4-identity";
import type { LlamaPool } from "../types";

const UUID = "0899ff3d-adc8-4dae-a516-a94998db3332";
const POOL = "0xe63e32b2ae40601662f760d6bf5d771057324fbd97784fe1d3717069f7b75d45";
const TOKENS = ["0x6c3ea9036406852006290770bedfcaba0e23a0e8", "0xdc035d45d973e3ec169d2276ddab16f1e407384f"];
const row = { pool: UUID, project: "uniswap-v4", chain: "Ethereum", underlyingTokens: TOKENS, pool_old: `${POOL}-ethereum-uniswap-v4` };
function pool(): LlamaPool {
  return { ...row, poolMeta: "0.00%", tvlUsd: 100125999 } as unknown as LlamaPool;
}

describe("DefiLlama V4 exact UUID identity", () => {
  it("recovers the real 5-pip PYUSD/USDS identity without interpreting rounded fee metadata", () => {
    const pools = [pool()];
    expect(attachDefiLlamaV4PoolIdentities(pools, { data: [{ ...row, tvlUsd: 1 }] })).toBe(1);
    expect(pools[0]).toMatchObject({ pool: POOL, poolMeta: "0.00%", tvlUsd: 100125999 });
  });

  it.each([
    { ...row, pool: "another-uuid" },
    { ...row, chain: "Base" },
    { ...row, project: "uniswap-v3" },
    { ...row, pool_old: `${POOL}-base-uniswap-v4` },
    { ...row, underlyingTokens: [TOKENS[0], TOKENS[0]] },
    { ...row, underlyingTokens: [TOKENS[0], "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"] },
  ])("rejects mismatched source identity %#", (invalid) => {
    const pools = [pool()];
    expect(attachDefiLlamaV4PoolIdentities(pools, { data: [invalid] })).toBe(0);
    expect(pools[0]!.pool).toBe(UUID);
  });

  it("fails closed on duplicate UUIDs and malformed or over-budget payloads", () => {
    for (const payload of [{ data: [row, row] }, { data: Array(2001).fill(row) }, { data: null }, null]) {
      const pools = [pool()];
      expect(attachDefiLlamaV4PoolIdentities(pools, payload)).toBe(0);
      expect(pools[0]!.pool).toBe(UUID);
    }
  });
});
