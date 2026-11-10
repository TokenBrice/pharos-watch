import { afterEach, describe, expect, it, vi } from "vitest";
import { JournaledEthCaller, pinBlock } from "../lib/mechanism-measurement/core";
import { JournaledShockCaller } from "../lib/mechanism-measurement/shock-journal";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const SPEC = { name: "supply", to: ADDRESS, selector: "0x18160ddd", signature: "totalSupply()" };
const HASH = `0x${"a".repeat(64)}`;
afterEach(() => { vi.unstubAllGlobals(); });
describe("measurement journals cannot manufacture state pins", () => {
  it.each(["https://rpc.hyperliquid.xyz/evm", "https://rpc.hypurrscan.io"])("rejects latest-only %s despite a correct header", async url => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json({ result:
      JSON.parse(String(init?.body)).method === "eth_getBlockByNumber"
        ? { number: "0x64", hash: HASH, timestamp: "0x64" } : "0xdead" }));
    vi.stubGlobal("fetch", fetcher);
    expect((await pinBlock(url)).number).toBe(100);
    const caller = new JournaledEthCaller(url, "0x64");
    await expect(caller.call(SPEC)).rejects.toThrow("historical-state-unsupported");
    expect(caller.calls).toEqual([]);
    expect(() => new JournaledShockCaller(url, { blockHash: HASH, requireCanonical: true })).toThrow("historical-state-unsupported");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["https://api.trongrid.io/jsonrpc", "https://tron-mainnet.g.alchemy.com/v2/test"])("rejects the historical journal on %s", async url => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const blockTag of ["0x64", "latest"]) {
      const caller = new JournaledEthCaller(url, blockTag);
      await expect(caller.call(SPEC)).rejects.toThrow("historical-state-unsupported");
      expect(caller.calls).toEqual([]);
    }
    expect(() => new JournaledShockCaller(url, { blockHash: HASH, requireCanonical: true })).toThrow("historical-state-unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains a real non-TRON hash selector in the shock journal", async () => {
    const word = `0x${"0".repeat(63)}1`;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json([{ id: 1, result: word }]));
    const caller = new JournaledShockCaller("https://ethereum.example", { blockHash: HASH, requireCanonical: true }, fetcher);
    expect(await caller.call(SPEC)).toBe(word);
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Array<{ params: unknown[] }>;
    expect(sent[0]?.params[1]).toEqual({ blockHash: HASH, requireCanonical: true });
    expect(caller.calls).toHaveLength(1);
  });
});
