import { expect, vi } from "vitest";
import type { EvmRpcOptions } from "../lib/evm-rpc";
import type * as Rpc from "../lib/evm-rpc";
import type { ChainRpcConfig } from "../lib/chain-registry";

const { fetchEvmRpcBatch } = await vi.importActual<typeof Rpc>("../lib/evm-rpc");

/** Exercise the real resolver with a consumer's exact metadata and a recent-only route. */
export async function expectRecentPinRouting(options: EvmRpcOptions): Promise<void> {
  const pin = options.recentStatePin;
  expect(pin).toBeDefined();
  if (!pin) throw new Error("Expected an authenticated consumer pin");
  const urls: string[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    urls.push(String(input));
    const requests = JSON.parse(String(init?.body)) as Array<{ id: number }>;
    return new Response(JSON.stringify(requests.map(row => ({ jsonrpc: "2.0", id: row.id, result: "0x6000" }))));
  });
  const clock = vi.spyOn(Date, "now").mockReturnValue(pin.observedAtSec * 1000);
  const chainRpcs = new Map<string, ChainRpcConfig>([[pin.chainId, {
    chainId: pin.chainId, chainName: pin.chainId, type: "evm", explorerUrl: "https://explorer.example",
    endpoints: [
      { url: "https://recent.example", operator: "dwellir", keyed: false, position: "registry", stateHistory: "recent", logsHistory: "none" },
      { url: "https://archive.example", operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" },
    ],
  }]]);
  const current = { method: "eth_getCode", params: ["0x0000000000000000000000000000000000000001", { blockHash: pin.header.hash, requireCanonical: true }] };
  try {
    expect(await fetchEvmRpcBatch(pin.chainId, [current], { chainRpcs, recentStatePin: pin, maxRetries: 0 })).toEqual(["0x6000"]);
    expect(urls).toEqual(["https://recent.example"]);
    urls.length = 0;
    await fetchEvmRpcBatch(pin.chainId, [current], { chainRpcs, maxRetries: 0 });
    expect(urls).toEqual(["https://archive.example"]);
    urls.length = 0;
    await fetchEvmRpcBatch(pin.chainId, [current, { ...current, params: [current.params[0], "0x1"] }], { chainRpcs, recentStatePin: pin, maxRetries: 0 });
    expect(urls).toEqual(["https://archive.example"]);
  } finally {
    fetcher.mockRestore();
    clock.mockRestore();
  }
}
