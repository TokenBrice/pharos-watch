import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem/utils";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { captureQuoterV2Pools, QUOTER_V2_CAPTURE_MAX_REQUESTS, QUOTER_V2_CAPTURE_XDC_MAX_POOLS } from "../quoter-v2-pool-capture";
import { createDexMeasuredExecutionRpcBudget } from "../../measured-execution/profiles";
import { getDexMeasuredExecutionDeployment } from "../../measured-execution/registry";

const transport = vi.hoisted(() => ({ fetchJsonWithRetry: vi.fn() }));
vi.mock("../../../lib/fetch-retry", () => transport);
const POOL = "0x3416cf6c708da44db2624d63ea0aaef7113527c6";
const TOKEN0 = "0x0000000000000000000000000000000000000001";
const TOKEN1 = "0x0000000000000000000000000000000000000002";
const HASH = `0x${"11".repeat(32)}`;
const ABI = parseAbi([
  "function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)",
  "function fee() view returns (uint24)", "function slot0() view returns (uint160 sqrtPriceX96,int24 tick)",
  "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)",
  "function getPool(address,address,uint24) view returns (address)",
]);
function input(poolCount = 1, fallback = false): Parameters<typeof captureQuoterV2Pools>[0] {
  const chainRpcs = new Map<string, ChainRpcConfig>([["xdc", {
    chainId: "xdc", chainName: "XDC", type: "evm", explorerUrl: "https://explorer.example",
    endpoints: (fallback ? ["https://primary.example", "https://fallback.example"] : ["https://fallback.example"]).map((url) => ({
      url, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full",
    })),
  }]]);
  return { chain: "xdc", adapterProfileId: "xswap-v3-quoter-v2", candidates: Array.from({ length: poolCount }, () => ({ poolAddress: POOL })),
    chainAddressToId: new Map([[`xdc:${TOKEN0}`, "usdc-circle"], [`xdc:${TOKEN1}`, "usdt-tether"]]),
    trackedStablecoinPrices: new Map([["usdc-circle", 1], ["usdt-tether", 1]]), chainRpcs };
}
beforeEach(() => {
  transport.fetchJsonWithRetry.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    if (url === "https://primary.example") return { response: new Response("{}", { status: 503 }), body: {} };
    const request = JSON.parse(String(init.body));
    let result: unknown;
    if (request.method === "eth_blockNumber") result = "0x10";
    else if (request.method === "eth_getBlockByNumber") result = { number: "0x10", timestamp: "0x64", hash: HASH };
    else if (request.method === "eth_getCode") result = "0x";
    else {
      const { functionName } = decodeFunctionData({ abi: ABI, data: request.params[0].data });
      const values: Record<string, unknown> = {
        factory: getDexMeasuredExecutionDeployment("xswap-v3-quoter-v2", "xdc")!.factoryAddress,
        token0: TOKEN0, token1: TOKEN1, fee: 500, slot0: [1n << 96n, 0],
        decimals: 6, balanceOf: 1_000_000n * 10n ** 6n, getPool: POOL,
      };
      result = encodeFunctionResult({ abi: ABI, functionName, result: values[functionName] as never });
    }
    const body = { jsonrpc: "2.0", id: request.id, result };
    return { response: new Response(JSON.stringify(body)), body };
  });
});
describe("physical XDC capture request budget", () => {
  it("keeps the maximum admitted XDC capture below the shared physical-request allowance", async () => {
    const result = await captureQuoterV2Pools(input(QUOTER_V2_CAPTURE_XDC_MAX_POOLS));
    expect(result.ok).toBe(true);
    expect(result.pools).toHaveLength(QUOTER_V2_CAPTURE_XDC_MAX_POOLS);
    expect(transport.fetchJsonWithRetry).toHaveBeenCalledTimes(126);
  });
  it("refuses an oversized direct capture before any request", async () => {
    const result = await captureQuoterV2Pools(input(128));
    expect(result).toMatchObject({ ok: false, pools: [], errors: ["quoter-v2-capture-pool-budget"] });
    expect(transport.fetchJsonWithRetry).not.toHaveBeenCalled();
  });
  it("counts failed endpoint attempts and refuses partial exact pools once exhausted", async () => {
    const result = await captureQuoterV2Pools(input(QUOTER_V2_CAPTURE_XDC_MAX_POOLS, true));
    expect(result.ok).toBe(false);
    expect(result.pools).toEqual([]);
    expect(transport.fetchJsonWithRetry).toHaveBeenCalledTimes(QUOTER_V2_CAPTURE_MAX_REQUESTS);
  });
  it("shares the caller allowance across separate captures rather than resetting it", async () => {
    const rpcBudget = createDexMeasuredExecutionRpcBudget({ maxRequests: 20, deadlineMs: Date.now() + 90_000 });
    expect((await captureQuoterV2Pools({ ...input(), rpcBudget })).pools).toHaveLength(1);
    expect((await captureQuoterV2Pools({ ...input(), rpcBudget })).pools).toEqual([]);
    expect(transport.fetchJsonWithRetry).toHaveBeenCalledTimes(20);
    expect(rpcBudget.remainingRequests).toBe(0);
  });
});
