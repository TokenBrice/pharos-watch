import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChainRpcs, type RpcEndpoint } from "../chain-registry";
import { createBudget } from "../evm-logs";
import { fetchMintBurnLogs, getMintBurnFinalizedHead, mintBurnRpcEndpoints, resolveMintBurnBlockTimestamps } from "../mint-burn-pipeline/rpc";
import { fetchConservationBoundaries, getMintBurnConservationRuntimeEntry } from "../mint-burn-conservation";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { classifyBridgeBurnRows } from "../mint-burn-pipeline/classification";
import type { MintBurnRow } from "../mint-burn-pipeline/types";
import * as credits from "../rpc-provider-budget";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { syncMintBurnConfig } from "../../cron/mint-burn/sync-config";
import { loadMintBurnChainContexts } from "../../cron/mint-burn/chain-context";

import { DWELLIR_CHAINS } from "@shared/lib/dwellir-chains";
import { buildAlchemyUrl } from "../alchemy-logs";
type Call = { id: number; method: string; params: unknown[] };
const word = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;
const RECENT_TIMESTAMP = Math.floor(Date.now() / 1000) - 60;
const RECENT_TIMESTAMP_HEX = `0x${RECENT_TIMESTAMP.toString(16)}`;
const unavailable = { error: { code: -32602, message: "provider unavailable" } };
function logRange(call: Call): { fromBlock: string; toBlock: string } {
  const range = call.params[0];
  if (!range || typeof range !== "object" || !("fromBlock" in range) || typeof range.fromBlock !== "string"
    || !("toBlock" in range) || typeof range.toBlock !== "string") throw new Error("invalid-test-log-range");
  return { fromBlock: range.fromBlock, toBlock: range.toBlock };
}
function recorder(answer: (url: string, call: Call) => object) {
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    const payload = JSON.parse(String(options.body)) as Call | Call[];
    const respond = (call: Call) => ({ jsonrpc: "2.0", id: call.id, ...answer(url, call) });
    return new Response(JSON.stringify(Array.isArray(payload) ? payload.map(respond) : respond(payload)));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function admitted(chainId = "base"): readonly RpcEndpoint[] {
  return mintBurnRpcEndpoints(chainId, "alchemy-test", buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: "dwellir-test" }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("mint/burn ordered RPC fallback", () => {
  it.each(["ethereum", "arbitrum", "base"])("keeps unadmitted %s contexts and 50k windows byte-identical", async (chain) => {
    const endpoint = mintBurnRpcEndpoints(chain, "alchemy-test");
    const registry = mintBurnRpcEndpoints(chain, "alchemy-test", buildChainRpcs("alchemy-test"));
    expect(JSON.stringify(registry)).toBe(JSON.stringify(endpoint));
    const fetcher = recorder(() => ({ result: [] }));
    const budget = createBudget(20);
    expect(await fetchMintBurnLogs(endpoint, "0xabc", [], 1, 50_000, budget)).toMatchObject({ complete: true, calls: 1 });
    expect(budget.count).toBe(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body)).params[0]).toMatchObject({ fromBlock: "0x1", toBlock: "0xc350" });
  });

  it.each(["ethereum", "base", "arbitrum"])("falls back from Dwellir to incumbent Alchemy on %s", async (chain) => {
    const endpoints = admitted(chain);
    expect(endpoints.map((endpoint) => endpoint.operator)).toEqual(["dwellir", "alchemy"]);
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    const fetcher = recorder((url, call) => call.method === "eth_blockNumber" ? { result: "0xc350" }
      : url === endpoints[0].url ? unavailable : { result: [] });
    const budget = createBudget(20);
    expect(await fetchMintBurnLogs(endpoints, "0xabc", [], 1, 50_000, budget))
      .toMatchObject({ complete: true, scannedToBlock: 50_000, calls: 2 });
    const pages = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options.body)) as Call)
      .filter((call) => call.method === "eth_getLogs").map(logRange);
    expect(pages.map((page) => Number(page.toBlock) - Number(page.fromBlock) + 1)).toEqual([10_000, 50_000]);
    expect(budget.count).toBe(4);
    expect(meter.mock.calls).toEqual([[1], [1]]);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Api-Key")).toBe("dwellir-test");
    expect(new Headers(fetcher.mock.calls[2][1].headers).get("X-Api-Key")).toBeNull();
  });

  it.each(["ethereum", "arbitrum", "base"])("keeps successful %s scans Dwellir-only with 10k pages", async (chain) => {
    const endpoints = admitted(chain);
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    const fetcher = recorder((_, call) => ({ result: call.method === "eth_blockNumber" ? "0xc350" : [] }));
    expect(await fetchMintBurnLogs(endpoints, "0xabc", [], 1, 50_000, createBudget(20)))
      .toMatchObject({ complete: true, scannedToBlock: 50_000, calls: 5 });
    expect(fetcher.mock.calls.every(([url]) => url === endpoints[0].url)).toBe(true);
    expect(meter).toHaveBeenCalledTimes(6);
  });

  it("reuses the initial preferred-provider head across the extended roster while accounting for smaller pages", async () => {
    const endpoints = admitted("ethereum");
    const fetcher = recorder((_, call) => ({ result: call.method === "eth_blockNumber" ? "0xc350" : [] }));
    const endpointHeads = new Map<string, number>();
    const budget = createBudget(1000);
    for (let i = 0; i < 65; i++) {
      for (let event = 0; event < 2; event++) {
        expect(await fetchMintBurnLogs(endpoints, "0xabc", [], 1, 50_000, budget, undefined, { endpointHeads }))
          .toMatchObject({ complete: true, scannedToBlock: 50_000 });
      }
    }
    expect(budget.count).toBe(651);
    const calls = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options.body)) as Call);
    expect(calls.filter((call) => call.method === "eth_blockNumber")).toHaveLength(1);
    expect(fetcher.mock.calls.every(([url]) => url === endpoints[0].url)).toBe(true);
  });

  it("keeps cached fallback and primary heads separate when the fallback lags", async () => {
    const endpoints = admitted();
    const endpointHeads = new Map<string, number>([[endpoints[0].url, 50_000]]);
    const fetcher = recorder((url, call) => call.method === "eth_blockNumber" ? { result: "0xc2ec" }
      : url === endpoints[0].url ? unavailable : { result: [] });
    const budget = createBudget(25);
    for (let i = 0; i < 2; i++) {
      expect(await fetchMintBurnLogs(endpoints, "0xabc", [], 49_000, 50_000, budget, undefined, { endpointHeads }))
        .toMatchObject({ complete: false, scannedToBlock: 49_900, failureReason: "provider-head-lag" });
    }
    expect(endpointHeads.get(endpoints[0].url)).toBe(50_000);
    expect(endpointHeads.get(endpoints[1].url)).toBe(49_900);
    const calls = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options.body)) as Call);
    expect(calls.filter((call) => call.method === "eth_blockNumber")).toHaveLength(1);
  });

  it("preserves the contiguous frontier when a provider switch fails mid-scan", async () => {
    const endpoints = admitted();
    const fetcher = recorder((url, call) => {
      if (call.method === "eth_blockNumber") return { result: "0xc350" };
      const range = call.params[0] as { fromBlock: string; toBlock: string };
      if (url === endpoints[0].url && Number(range.fromBlock) === 1) return { result: [] };
      return unavailable;
    });
    expect(await fetchMintBurnLogs(endpoints, "0xabc", [], 1, 50_000, createBudget(20)))
      .toMatchObject({ complete: false, scannedToBlock: 10_000 });
    const pages = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options.body)) as Call)
      .filter((call) => call.method === "eth_getLogs");
    expect(pages.map((call) => Number(logRange(call).fromBlock))).toEqual([1, 10_001, 10_001]);
  });

  it.each(["ethereum", "arbitrum", "base"])("does not advance %s's finalized scan cursor past a lagging fallback head", async (chain) => {
    const endpoints = admitted(chain);
    const fallbackHead = 49_900;
    const fetcher = recorder((url, call) => {
      if (call.method === "eth_blockNumber") {
        return { result: `0x${(url === endpoints[0].url ? 50_000 : fallbackHead).toString(16)}` };
      }
      if (call.method === "eth_getBlockByNumber" && url === endpoints[1].url) {
        return { result: { number: call.params[0], timestamp: RECENT_TIMESTAMP_HEX, hash: word(12) } };
      }
      // This provider would silently accept a future toBlock and return empty logs.
      return url === endpoints[0].url ? unavailable : { result: [] };
    });
    const config = MINT_BURN_CONFIGS.find((config) => config.chain.chainId === chain)!;
    const input = {
      db: mockD1([{ match: "INSERT INTO cache", rows: [] }]), config, key: `${chain}-fixture`, tier: "critical" as const, fromBlock: 1, scanTo: 50_000,
      chainHead: 50_000, rpcEndpoints: endpoints, configBudgetLimit: 60, runTimestamp: RECENT_TIMESTAMP + 60,
      priceContext: { priceObservations: new Map(), priceHistory: new Map() }, chainTimestampCache: new Map(),
      txContextCache: new Map(), affectedHours: new Map(),
    };
    const result = await syncMintBurnConfig(input);
    // A partial provider frontier alone is not proof, even when its head is safe.
    expect(result.newLastBlock).toBeNull();
    expect(result.scanCoverage).toBeUndefined();
    expect(result.summary.advanceReason).toBe("scan-coverage-unproven");
    expect(result.summary.coverageFrontier).toBe(fallbackHead);
    expect(result.summary.eventCoverage.every((coverage) => !coverage.complete && coverage.scannedToBlock === fallbackHead)).toBe(true);
    // A fully re-scanned range ending at that head can advance with real headers.
    const retry = await syncMintBurnConfig({ ...input, scanTo: fallbackHead });
    expect(retry.newLastBlock).toBe(fallbackHead);
    expect(retry.scanCoverage).toMatchObject({ fromBlock: 1, toBlock: fallbackHead, fromTimestamp: RECENT_TIMESTAMP, toTimestamp: RECENT_TIMESTAMP });
    const fallbackPages = fetcher.mock.calls.filter(([url]) => url === endpoints[1].url)
      .map(([, options]) => JSON.parse(String(options.body)) as Call).filter((call) => call.method === "eth_getLogs");
    expect(fallbackPages.every((call) => Number(logRange(call).toBlock) <= fallbackHead)).toBe(true);
  });

  it.each(["ethereum", "base", "arbitrum", "optimism"])("never reaches disabled %s Dwellir", async (chain) => {
    const map = buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: "dwellir-test", dwellirRoutingDisabledChains: new Set(["ethereum", "base", "arbitrum", "optimism"]) });
    const endpoints = mintBurnRpcEndpoints(chain, "alchemy-test", map);
    expect(endpoints).toHaveLength(1);
    const fetcher = recorder(() => unavailable);
    expect(await getMintBurnFinalizedHead(chain, endpoints, createBudget(20))).toBeNull();
    await fetchMintBurnLogs(endpoints, "0xabc", [], 1, 50_000, createBudget(20));
    expect(fetcher.mock.calls.every(([url]) => !url.includes("dwellir"))).toBe(true);
  });

  it.each(DWELLIR_CHAINS.filter(chain => chain.logsHistory === "full" && buildAlchemyUrl(chain.chainId, "alchemy-test"))
    .map(chain => chain.chainId))("prefers supported full-history %s logs independently of state history", chain => {
    expect(admitted(chain).map(endpoint => endpoint.operator)).toEqual(["dwellir", "alchemy"]);
  });

  it("does not route unsupported log history through Dwellir", () => {
    const map = buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: "dwellir-test" });
    const config = map.get("base")!;
    map.set("base", { ...config, endpoints: config.endpoints.map(endpoint =>
      endpoint.operator === "dwellir" ? { ...endpoint, logsHistory: "none" } : endpoint) });
    expect(mintBurnRpcEndpoints("base", "alchemy-test", map).map(endpoint => endpoint.operator)).toEqual(["alchemy"]);
  });

  it("falls back for heads and hash-bound timestamps, rejecting a mismatching fork", async () => {
    const endpoints = admitted();
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    recorder((url, call) => {
      if (url === endpoints[0].url) return unavailable;
      return { result: call.method === "eth_blockNumber" ? "0x66" : { number: "0x66", timestamp: RECENT_TIMESTAMP_HEX, hash: word(12) } };
    });
    expect(await getMintBurnFinalizedHead("base", endpoints, createBudget(20))).toMatchObject({ number: 102 });
    expect(await resolveMintBurnBlockTimestamps(endpoints, [102], createBudget(20), { blockHashes: new Map([[102, word(12)]]) })).toEqual(new Map([[102, RECENT_TIMESTAMP]]));
    expect(await resolveMintBurnBlockTimestamps(endpoints, [102], createBudget(20), { blockHashes: new Map([[102, word(13)]]) })).toEqual(new Map());
    expect(meter).toHaveBeenCalled();
  });

  it.each([true, false])("honors the head preparation deadline before an EVM request or fallback (expired=%s)", async (expired) => {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const deadlineMs = clock + (expired ? 0 : 1_000);
    const fetcher = recorder(() => { clock += 1_000; return unavailable; });
    const budget = createBudget(20);
    const contexts = await loadMintBurnChainContexts({
      configs: [MINT_BURN_CONFIGS.find((config) => config.chain.chainId === "base")!],
      apiKey: "alchemy-test", chainRpcs: buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: "dwellir-test" }),
      budget, deadlineMs,
    });
    expect(contexts.get("base")?.chainHead).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(expired ? 0 : 1);
    expect(budget.count).toBe(expired ? 0 : 1);
  });

  it("uses the ordered fallback for pinned conservation boundaries", async () => {
    const endpoints = admitted();
    const original = MINT_BURN_CONFIGS.find((config) => config.stablecoinId === "gusd-gemini")!;
    const config = { ...original, chain: { ...original.chain, chainId: "base" } };
    const entry = { ...getMintBurnConservationRuntimeEntry(original)!, chainId: "base" };
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    const fetcher = recorder((url, call) => {
      if (url === endpoints[0].url) return unavailable;
      if (call.method === "eth_getBlockByNumber") {
        const opening = call.params[0] === "0x64";
        return { result: { number: opening ? "0x64" : "0x66", timestamp: opening ? "0x3e8" : "0x400", hash: word(opening ? 10 : 12) } };
      }
      return { result: word(100) };
    });
    const budget = createBudget(20);
    const result = await fetchConservationBoundaries({ requests: [{ key: "one", config, fromBlock: 101, toBlock: 102 }],
      rpcEndpointsByChain: new Map([["base", endpoints]]), budget, checkedAt: 1100, lawFor: () => entry });
    expect(result.get("one")).toMatchObject({ status: "ready", fromBlockHash: word(10), toBlockHash: word(12) });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([endpoints[0].url, endpoints[1].url, endpoints[0].url, endpoints[1].url, endpoints[0].url, endpoints[1].url]);
    expect(budget.count).toBe(6);
    expect(meter.mock.calls).toEqual([[2], [2], [2]]);
  });

  it("uses recent-only BSC Dwellir for headers but not arbitrary historical conservation state", async () => {
    const endpoints = admitted("bsc");
    expect(endpoints[0]).toMatchObject({ operator: "dwellir", stateHistory: "recent", logsHistory: "full" });
    const original = MINT_BURN_CONFIGS.find(config => config.stablecoinId === "gusd-gemini")!;
    const config = { ...original, chain: { ...original.chain, chainId: "bsc", evmChainId: 56 } };
    const entry = { ...getMintBurnConservationRuntimeEntry(original)!, chainId: "bsc" };
    const fetcher = recorder((_, call) => {
      if (call.method === "eth_getBlockByNumber") {
        const opening = call.params[0] === "0x64";
        return { result: { number: opening ? "0x64" : "0x66", timestamp: opening ? "0x3e8" : "0x400",
          hash: word(opening ? 10 : 12) } };
      }
      return { result: word(100) };
    });
    const result = await fetchConservationBoundaries({ requests: [{ key: "bsc", config, fromBlock: 101, toBlock: 102 }],
      rpcEndpointsByChain: new Map([["bsc", endpoints]]), budget: createBudget(20), checkedAt: 1100, lawFor: () => entry });
    expect(result.get("bsc")).toMatchObject({ status: "ready" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([endpoints[0].url, endpoints[1].url, endpoints[0].url]);
    for (const [url, options] of fetcher.mock.calls) {
      const calls = JSON.parse(String(options.body)) as Call[];
      if (url === endpoints[0].url) expect(calls.every(call => call.method === "eth_getBlockByNumber")).toBe(true);
      else expect(calls.every(call => call.params[1] !== "latest")).toBe(true);
    }
  });

  it.each(["budget", "deadline"])("preserves the conservation %s reason when fallback cannot start", async (kind) => {
    const endpoints = admitted();
    const original = MINT_BURN_CONFIGS.find((config) => config.stablecoinId === "gusd-gemini")!;
    const config = { ...original, chain: { ...original.chain, chainId: "base" } };
    const entry = { ...getMintBurnConservationRuntimeEntry(original)!, chainId: "base" };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetcher = recorder(() => {
      if (kind === "deadline") clock.mockReturnValue(1100);
      return unavailable;
    });
    const result = await fetchConservationBoundaries({ requests: [{ key: "one", config, fromBlock: 101, toBlock: 102 }],
      rpcEndpointsByChain: new Map([["base", endpoints]]), budget: createBudget(kind === "budget" ? 1 : 20),
      checkedAt: 1100, deadlineMs: kind === "deadline" ? 1100 : undefined, lawFor: () => entry });
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-budget-or-deadline" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { logHash: 12, receiptHash: 12, shortfalls: 0 },
    { logHash: 13, receiptHash: 12, shortfalls: 1 },
    { logHash: 12, receiptHash: 13, shortfalls: 1 },
  ])("accepts only hash-consistent fallback receipts: $logHash/$receiptHash", async ({ logHash, receiptHash, shortfalls }) => {
    const endpoints = admitted();
    const config = MINT_BURN_CONFIGS.find((config) => config.bridgeDetection)!;
    const txHash = word(20);
    const row: MintBurnRow = {
      id: "event", stablecoin_id: config.stablecoinId, symbol: config.symbol, chain_id: "base",
      tx_hash: txHash, direction: "burn", counterparty: null, amount: 1, amount_usd: null,
      price_used: null, price_timestamp: null, price_source: null, burn_type: null,
      burn_review_reason: null, flow_type: "standard", block_number: 102, timestamp: 1024,
      explorer_tx_url: "https://basescan.org/tx/" + txHash,
    };
    const fetcher = recorder((url, call) => {
      if (url === endpoints[0].url) return unavailable;
      return { result: call.method === "eth_getTransactionByHash" ? { hash: txHash, to: null, input: "0x" }
        : { transactionHash: txHash, to: null, blockHash: word(receiptHash), logs: [{ address: config.contractAddress, topics: [], data: word(1),
          blockNumber: "0x66", transactionHash: txHash, transactionIndex: "0x0", logIndex: "0x0", blockHash: word(logHash), removed: false }] } };
    });
    expect(await classifyBridgeBurnRows([row], config, endpoints, createBudget(20), new Map(), undefined,
      { blockHashesByTx: new Map([[txHash, word(12)]]) })).toMatchObject({ txContextShortfalls: shortfalls, deferredTxHashes: shortfalls ? [txHash] : [] });
    expect(fetcher.mock.calls.some(([url]) => url === endpoints[1].url)).toBe(true);
  });

  it.each([...new Set(MINT_BURN_CONFIGS.filter(config => config.enabled !== false && config.chain.type === "evm")
    .map(config => config.chain.chainId))])
    ("uses %s's validated finalized header, not its raw tip or a common block margin", async (chain) => {
      const endpoints = admitted(chain);
      const fetcher = recorder((_url, call) => ({ result: call.method === "eth_blockNumber" ? "0xffff"
        : { number: "0x1234", timestamp: RECENT_TIMESTAMP_HEX, hash: word(12) } }));
      expect(await getMintBurnFinalizedHead(chain, endpoints, createBudget(20))).toEqual({
        number: 4660, timestamp: RECENT_TIMESTAMP, hash: word(12),
      });
      const calls = fetcher.mock.calls.map(([, options]) => JSON.parse(String(options.body)) as Call);
      expect(calls.every(call => call.method === "eth_getBlockByNumber" && call.params[0] === "finalized")).toBe(true);
    });

  it.each([
    ["ethereum", 31 * 60],
    ["base", 2 * 60 * 60 + 60],
  ] as const)("rejects a %s finalized header older than its finality budget", async (chain, ageSec) => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - ageSec;
    const fetcher = recorder(() => ({
      result: { number: "0x66", timestamp: `0x${staleTimestamp.toString(16)}`, hash: word(12) },
    }));
    expect(await getMintBurnFinalizedHead(chain, admitted(chain), createBudget(20))).toBeNull();
    expect(fetcher).toHaveBeenCalled();
  });

  it("admits a rollup finalized header that trails L1 finality by under two hours", async () => {
    const lagTimestamp = Math.floor(Date.now() / 1000) - 45 * 60;
    recorder(() => ({
      result: { number: "0x66", timestamp: `0x${lagTimestamp.toString(16)}`, hash: word(12) },
    }));
    expect(await getMintBurnFinalizedHead("base", admitted("base"), createBudget(20))).toMatchObject({ number: 102 });
  });

  it("skips finalizedTagUnsupported endpoints and uses only a supported admitted fallback", async () => {
    const endpoints = admitted().map((endpoint, index) => index === 0 ? { ...endpoint, finalizedTagUnsupported: true } : endpoint);
    const fetcher = recorder(() => ({ result: { number: "0x66", timestamp: RECENT_TIMESTAMP_HEX, hash: word(12) } }));
    expect(await getMintBurnFinalizedHead("base", endpoints, createBudget(20))).toMatchObject({ number: 102 });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([endpoints[1]!.url]);
    fetcher.mockClear();
    expect(await getMintBurnFinalizedHead("base", endpoints.map(endpoint => ({ ...endpoint, finalizedTagUnsupported: true })),
      createBudget(20))).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, { number: "0x66", timestamp: "0x400", hash: "0xbad" },
    { number: "0x20000000000000", timestamp: "0x400", hash: word(12) }])
    ("refuses a missing or invalid finalized head without any tip fallback (%j)", async (header) => {
      const fetcher = recorder(() => ({ result: header }));
      expect(await getMintBurnFinalizedHead("base", admitted(), createBudget(20))).toBeNull();
      expect(fetcher.mock.calls.every(([, options]) => {
        const call = JSON.parse(String(options.body)) as Call;
        return call.method === "eth_getBlockByNumber" && call.params[0] === "finalized";
      })).toBe(true);
    });
});
