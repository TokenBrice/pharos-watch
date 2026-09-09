import { describe, expect, it } from "vitest";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

/**
 * Self-tests for the harness network boundary's block-method routing:
 * unrouted `eth_blockNumber` / `eth_getBlockBy*` calls are answered from the
 * `block` anchor without recording a table miss, while explicit rpc keys win.
 */

const ETHEREUM_RPC_URL = "https://ethereum-rpc.publicnode.com";

async function rpc(url: string, method: string, params: unknown[] = []): Promise<{ result?: unknown; error?: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as { result?: unknown; error?: unknown };
}

describe("installAdapterNetwork block-method routing", () => {
  it("answers unrouted block methods from the block anchor without recording unmatched", async () => {
    const network = installAdapterNetwork({
      block: { number: 12_345, timestamp: 1_700_000_000 },
    });

    const blockNumber = await rpc(ETHEREUM_RPC_URL, "eth_blockNumber");
    expect(blockNumber.result).toBe(`0x${(12_345).toString(16)}`);

    const header = await rpc(ETHEREUM_RPC_URL, "eth_getBlockByNumber", [`0x${(12_345).toString(16)}`]);
    expect(header.result).toMatchObject({
      number: `0x${(12_345).toString(16)}`,
      timestamp: `0x${(1_700_000_000).toString(16)}`,
    });

    expect(network.unmatched).toEqual([]);
  });

  it("lets an explicit eth_blockNumber rpc key override the anchor head", async () => {
    const network = installAdapterNetwork({
      block: { number: 12_345 },
      rpc: { eth_blockNumber: 99n },
    });

    const blockNumber = await rpc(ETHEREUM_RPC_URL, "eth_blockNumber");
    expect(blockNumber.result).toBe(`0x${(99n).toString(16)}`);
    expect(network.unmatched).toEqual([]);
  });

  it("answers an explicitly routed block tag with header gaps filled from the anchor", async () => {
    const network = installAdapterNetwork({
      block: { number: 12_345, timestamp: 1_700_000_000 },
      rpc: { "eth_getBlockByNumber:0x10": { timestamp: 999 } },
    });

    const routed = await rpc(ETHEREUM_RPC_URL, "eth_getBlockByNumber", ["0x10"]);
    expect(routed.result).toMatchObject({ number: "0x10", timestamp: `0x${(999).toString(16)}` });

    // Other tags still fall back to the anchor.
    const anchor = await rpc(ETHEREUM_RPC_URL, "eth_getBlockByNumber", [`0x${(12_345).toString(16)}`]);
    expect(anchor.result).toMatchObject({
      number: `0x${(12_345).toString(16)}`,
      timestamp: `0x${(1_700_000_000).toString(16)}`,
    });

    expect(network.unmatched).toEqual([]);
  });
});
