import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { IssuerNativeLiabilityScope } from "@shared/types/live-reserve-adapter-declarations";
import { buildChainRpcs } from "../chain-registry";
import {
  fetchEvmCallHexAtBlock, fetchEvmCodeStatusAtBlock, fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmRpcBatch, fetchEvmRpcBatchDetailed, fetchEvmStorageAtBlock, fetchJsonRpcHexAtUrl,
} from "../evm-rpc";
import { transferMaterialityObserverResolvesRpc } from "../safety-score-v9/transfer-materiality-observer";
import { pinnedBlockPlan } from "../../cron/reserve-adapters/evm-observation-plan";
import { fetchTronErc20TotalSupply } from "../../cron/reserve-adapters/onchain";
import { aggregateScopedLiabilitySupply, evaluateLiabilityCoverage } from "../../cron/reserve-adapters/multichain-supply";
import { runPinnedBlockCapture } from "../../cron/dex-liquidity/evm-capture-helpers";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"a".repeat(64)}` as const;
const WORD = `0x${"0".repeat(63)}1`;
const signal = new AbortController().signal;
function network() {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const payload: unknown = JSON.parse(String(init?.body));
    if (Array.isArray(payload)) return Response.json(payload.map((row: { id: number }) => ({ id: row.id, result: WORD })));
    return Response.json({ result: WORD });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("TRON historical-state admission", () => {
  it.each([100, "latest"] as const)("rejects block/hash TRON state reads at %s before accepting a provider result", async block => {
    const fetcher = network();
    const options = { chainRpcs: buildChainRpcs(), stateBlockHash: HASH, multicallFallbackBlockHash: HASH };
    expect(await fetchEvmCallHexAtBlock("tron", ADDRESS, "0x18160ddd", block, options)).toBeNull();
    expect(await fetchEvmCodeStatusAtBlock("tron", ADDRESS, block, options)).toEqual({ status: "unavailable" });
    expect(await fetchEvmStorageAtBlock("tron", ADDRESS, HASH, block, options)).toBeNull();
    expect(await fetchEvmMulticall3Aggregate3AtBlock("tron", [{ label: "supply", target: ADDRESS, callData: "0x18160ddd" }], block, options)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects numbered calls without a hash and whole mixed pinned batches", async () => {
    const fetcher = network();
    const chainRpcs = buildChainRpcs();
    expect(await fetchEvmCallHexAtBlock("tron", ADDRESS, "0x18160ddd", 100, { chainRpcs })).toBeNull();
    const calls = [
      { method: "eth_getBlockByNumber", params: ["0x64", false] },
      { method: "eth_call", params: [{ to: ADDRESS, data: "0x18160ddd" }, { blockNumber: "0x64" }] },
    ];
    expect(await fetchEvmRpcBatch("tron", calls, { chainRpcs })).toBeNull();
    expect(await fetchEvmRpcBatchDetailed("tron", calls, { chainRpcs })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not trust custom TRON endpoint hosts or configured archive labels", async () => {
    const fetcher = network();
    const configured = buildChainRpcs();
    const tron = configured.get("tron")!;
    const chainRpcs = new Map(configured).set("custom-tron", { ...tron, chainId: "custom-tron", endpoints: [{ ...tron.endpoints[0]!, url: "https://custom.example/rpc" }] });
    expect(transferMaterialityObserverResolvesRpc("tron", configured)).toBe(false);
    expect(transferMaterialityObserverResolvesRpc("custom-tron", chainRpcs)).toBe(false);
    expect(await fetchEvmCallHexAtBlock("custom-tron", ADDRESS, "0x18160ddd", 100, { chainRpcs })).toBeNull();
    await expect(pinnedBlockPlan({ chain: "tron", signal, ctx: { observedBlock: { chain: "tron", number: 100, timestamp: 1000 } } })).rejects.toThrow("historical-state-unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects URL-only TRON EIP-1898 reads but preserves latest and non-TRON pins", async () => {
    const fetcher = network();
    for (const url of ["https://api.trongrid.io/jsonrpc", "https://tron-mainnet.g.alchemy.com/v2/test", "https://lb.drpc.org/ogrpc?network=tron"]) {
      expect(await fetchJsonRpcHexAtUrl(url, "eth_call", [{ to: ADDRESS }, { blockHash: HASH, requireCanonical: true }])).toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await fetchEvmCallHexAtBlock("tron", ADDRESS, "0x18160ddd", "latest", { extraRpcUrls: ["https://api.trongrid.io/jsonrpc"] })).toBe(WORD);
    expect(await fetchEvmCallHexAtBlock("ethereum", ADDRESS, "0x18160ddd", 100, { extraRpcUrls: ["https://ethereum.example"], stateBlockHash: HASH })).toBe(WORD);
    const sent = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { params: unknown[] };
    expect(sent.params[1]).toEqual({ blockHash: HASH, requireCanonical: true });
    expect(await fetchEvmRpcBatch("tron", [{ method: "eth_getBlockByNumber", params: ["0x64", false] }], { extraRpcUrls: ["https://api.trongrid.io/jsonrpc"] })).toEqual([WORD]);
  });
  it("never publishes a TRON DEX capture as pinned even with matching headers", async () => {
    let accepted = false;
    let failed = false;
    await runPinnedBlockCapture({
      chain: "tron", rpcOptions: {},
      verifyDeployment: async () => ({ ok: true }),
      buildCalls: async () => ({ ok: true, value: 1 }),
      onResults: () => { accepted = true; }, onFailure: () => { failed = true; },
    });
    expect({ accepted, failed }).toEqual({ accepted: false, failed: true });
  });
  it("withholds constant-contract supply when a TRON observedBlock is required", async () => {
    const fetcher = network();
    const contract = ACTIVE_META_BY_ID.get("usdt-tether")!.contracts!.find(row => row.chain === "tron")!;
    expect(await fetchTronErc20TotalSupply(contract.address, signal, { observedBlock: { chain: "tron", number: 100, timestamp: 1000 } })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("measures latest TRON supply at completion, so an old reserve clock cannot hide skew", async () => {
    const start = 1791184000;
    vi.spyOn(Date, "now").mockReturnValue((start + 301) * 1000);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: { result: true }, constant_result: ["01"] })));
    const meta = ACTIVE_META_BY_ID.get("usdt-tether")!;
    const coin = { ...meta, contracts: meta.contracts!.filter(row => row.chain === "tron") };
    const scope: IssuerNativeLiabilityScope = { basis: "issuer-native-supply", reviewedAt: "2026-10-05", evidenceRef: "test census", included: [{ chain: "tron", reader: "tron-trc20" }], excluded: [], maxReserveSupplySkewSec: 300 };
    const supply = await aggregateScopedLiabilitySupply({ coin, scope, adapterKey: "test", signal, nowSec: start, readEvmToken: async () => ({ raw: null, decimals: null }) });
    expect(supply.contributions[0]?.observedAt).toBe(start + 301);
    expect(evaluateLiabilityCoverage({ supply, reserveObservedAt: start })).toMatchObject({ supplyReadComplete: true, supplyCoverageComplete: true, ratioUnavailableReason: "reserve-supply-time-skew" });
  });
});
