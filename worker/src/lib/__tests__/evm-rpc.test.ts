import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChainRpcs, registerRpcAuth, type ChainRpcConfig, type RpcEndpoint } from "../chain-registry";
import { FetchRequestNotStartedError } from "../abort";

const fetchWithRetryMock = vi.fn();
const { recordDwellirCreditsMock } = vi.hoisted(() => ({ recordDwellirCreditsMock: vi.fn() }));

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: async (...args: unknown[]) => {
    const options = args[3] as { beforeRequest?: () => boolean; deadlineMs?: number } | undefined;
    if (options?.beforeRequest?.() === false) {
      throw new FetchRequestNotStartedError("admission-denied", 0);
    }
    const result = await fetchWithRetryMock(...args);
    if (result instanceof Response) {
      return { response: result, body: await result.clone().json() };
    }
    return result;
  },
  fetchTextWithRetry: async (...args: unknown[]) => {
    const options = args[3] as { beforeRequest?: () => boolean; deadlineMs?: number } | undefined;
    if (options?.beforeRequest?.() === false) {
      throw new FetchRequestNotStartedError("admission-denied", 0);
    }
    const result = await fetchWithRetryMock(...args);
    if (result instanceof Response) {
      return { response: result, body: await result.clone().text() };
    }
    return result;
  },
}));

vi.mock("../rpc-provider-budget", () => ({
  recordDwellirCredits: recordDwellirCreditsMock,
}));

const {
  MULTICALL3_ADDRESS,
  encodeMulticall3Aggregate3CallData,
  fetchEvmRpcBatch,
  usableCcipRpcEndpoints,
  fetchEvmRpcBatchDetailed,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmBlockHeader,
  fetchEvmBlockHeaderAtTag,
  fetchEtherscanProxyHex,
  fetchEtherscanUint256AtBlock,
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmStorageAtBlock,
  fetchEvmUint256AtBlock,
  fetchJsonRpcHexAtUrl,
  parseUint256Hex,
  resolveClosestBlockAtOrBeforeTimestamp,
} = await import("../evm-rpc");

function rpcResponse(body: unknown): Response {
  // Single-response fixtures must carry the same identity as the real request.
  if (body && typeof body === "object" && !Array.isArray(body) && !("id" in body)) body = { id: 1, ...body };
  return new Response(JSON.stringify(body), { status: 200 });
}

function blockResult(number: number, timestamp: string) {
  return { number: `0x${number.toString(16)}`, timestamp, hash: `0x${"a".repeat(64)}` };
}

function word(value: bigint | number): string {
  const bigintValue = typeof value === "bigint" ? value : BigInt(value);
  return bigintValue.toString(16).padStart(64, "0");
}

function encodeBytes(value: string): string {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  const paddedByteLength = Math.ceil(body.length / 2 / 32) * 32;
  return `${word(body.length / 2)}${body.padEnd(paddedByteLength * 2, "0")}`;
}

function encodeAggregate3Return(results: Array<{ success: boolean; returnData: string }>): `0x${string}` {
  const encodedResults = results.map(
    (result) => `${word(result.success ? 1 : 0)}${word(64)}${encodeBytes(result.returnData)}`,
  );
  let nextOffset = results.length * 32;
  const offsets = encodedResults.map((encodedResult) => {
    const offset = word(nextOffset);
    nextOffset += encodedResult.length / 2;
    return offset;
  });
  return `0x${word(32)}${word(results.length)}${offsets.join("")}${encodedResults.join("")}` as `0x${string}`;
}

describe("evm-rpc helpers", () => {
  function registryEndpoint(url: string, operator: "alchemy" | "public" = "public"): RpcEndpoint {
    return {
      url,
      operator,
      keyed: operator !== "public",
      position: "registry",
      stateHistory: "archive",
      logsHistory: "full",
    };
  }

  function dwellirEndpoint(url: string, stateHistory: RpcEndpoint["stateHistory"] = "archive"): RpcEndpoint {
    registerRpcAuth("dwellir", url, { "X-Api-Key": "dwellir-key" });
    return {
      url,
      operator: "dwellir",
      keyed: true,
      position: "supplemental",
      stateHistory,
      logsHistory: "full",
    };
  }

  function chainRpcsWith(chainId: string, endpoints: RpcEndpoint[]): Map<string, ChainRpcConfig> {
    return new Map([
      [chainId, { chainId, chainName: chainId, type: "evm", endpoints, explorerUrl: "https://explorer.example" }],
    ]);
  }

  function attemptedUrls(): string[] {
    return fetchWithRetryMock.mock.calls.map(([url]) => url as string);
  }

  function httpFailure(status: number): Response {
    return new Response(JSON.stringify({ error: "nope" }), { status });
  }

  afterEach(() => {
    fetchWithRetryMock.mockReset();
    recordDwellirCreditsMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each([false, true])("fails over on null receipt evidence only when required=%s", async required => {
    const dwellir = dwellirEndpoint("https://receipt-dwellir.example");
    const fallback = registryEndpoint("https://receipt-alchemy.example", "alchemy");
    const chainRpcs = chainRpcsWith("ethereum", [fallback, dwellir]);
    const receipt = { transactionHash: `0x${"a".repeat(64)}`, blockNumber: "0x64", status: "0x1", logs: [] };
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse([{ id: 1, result: null }]))
      .mockResolvedValueOnce(rpcResponse([{ id: 1, result: receipt }]));
    expect(await fetchEvmRpcBatch("ethereum", [
      { method: "eth_getTransactionReceipt", params: [receipt.transactionHash] },
    ], { chainRpcs, requireNonNullResults: required })).toEqual([required ? receipt : null]);
    expect(attemptedUrls()).toEqual(required ? [dwellir.url, fallback.url] : [dwellir.url]);
  });

  it("keeps required receipt evidence unavailable when every endpoint returns null", async () => {
    const chainRpcs = chainRpcsWith("ethereum", [
      registryEndpoint("https://receipt-a.example"), registryEndpoint("https://receipt-b.example"),
    ]);
    fetchWithRetryMock.mockResolvedValue(rpcResponse([{ id: 1, result: null }]));
    expect(await fetchEvmRpcBatch("ethereum", [
      { method: "eth_getTransactionReceipt", params: [`0x${"a".repeat(64)}`] },
    ], { chainRpcs, requireNonNullResults: true })).toBeNull();
    expect(attemptedUrls()).toHaveLength(2);
  });

  it("reports admitted physical requests and batch sizes without URL paths or credentials", async () => {
    const chainRpcs = chainRpcsWith("ethereum", [registryEndpoint("https://rpc.example/private?secret=hidden")]);
    const onRpcRequest = vi.fn();
    chainRpcs.get("ethereum")!.onRpcRequest = onRpcRequest;
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result: "0x64" }));
    expect(await fetchEvmBlockNumber("ethereum", { chainRpcs })).toBe(100);
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse([
      { id: 1, result: "0x6000" }, { id: 2, result: "0x6001" },
    ]));
    expect(await fetchEvmRpcBatch("ethereum", [
      { method: "eth_getCode", params: ["0xA", "latest"] },
      { method: "eth_getCode", params: ["0xB", "latest"] },
    ], { chainRpcs })).toEqual(["0x6000", "0x6001"]);
    expect(onRpcRequest.mock.calls.map(([request]) => request)).toEqual([
      { providerOrigin: "https://rpc.example", method: "eth_blockNumber", rpcCalls: 1, signal: undefined },
      { providerOrigin: "https://rpc.example", method: "batch", rpcCalls: 2, signal: undefined },
    ]);
    await fetchEvmBlockNumber("ethereum", { chainRpcs, beforeRequest: () => false });
    expect(onRpcRequest).toHaveBeenCalledTimes(2);
  });

  it.each(["ink", "berachain", "mantle", "ethereum", "base", "optimism", "arbitrum"])("routes CCIP hash-pinned state and historical logs through authenticated, metered Dwellir first on %s", async (chain) => {
    const chainRpcs = buildChainRpcs("alchemy-key", undefined, { dwellirApiKey: "dwellir-key" });
    const dwellir = chainRpcs.get(chain)!.endpoints.find(endpoint => endpoint.operator === "dwellir")!;
    const block = { blockHash: `0x${"a".repeat(64)}`, requireCanonical: true };
    const state = [
      { method: "eth_getCode", params: ["0xContract", block] },
      { method: "eth_call", params: [{ to: "0xContract", data: "0x12345678" }, block] },
    ];
    fetchWithRetryMock.mockImplementation(async (_url, init) => rpcResponse(
      JSON.parse(String(init.body)).map((request: { id: number; method: string }) => ({
        jsonrpc: "2.0", id: request.id, result: request.method === "eth_getLogs" ? [] : "0x6000",
      })),
    ));
    const options = { chainRpcs, maxRetries: 0 };
    expect(await fetchEvmRpcBatch(chain, state, options)).toEqual(["0x6000", "0x6000"]);
    expect(await fetchEvmRpcBatch(chain, [{ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2710" }] }], options)).toEqual([[]]);
    expect(attemptedUrls()).toEqual([dwellir.url, dwellir.url]);
    expect(JSON.parse(String(fetchWithRetryMock.mock.calls[0]![1].body))).toEqual(state.map((request, i) => ({ jsonrpc: "2.0", id: i + 1, ...request })));
    for (const [, init] of fetchWithRetryMock.mock.calls) expect(init.headers).toMatchObject({ "X-Api-Key": "dwellir-key" });
    expect(recordDwellirCreditsMock.mock.calls).toEqual([[2], [1]]);
  });

  it.each(["ink", "berachain"])("falls back from CCIP Dwellir to Alchemy then public on %s without exceeding endpoint log spans", async (chain) => {
    const dwellir = { ...dwellirEndpoint(`https://${chain}.ccip-dwellir.example`), maxLogBlockSpan: 10_000 };
    const alchemy = { ...registryEndpoint(`https://${chain}.ccip-alchemy.example`, "alchemy"), maxLogBlockSpan: 1_000 };
    const publicRpc = { ...registryEndpoint(`https://${chain}.ccip-public.example`), maxLogBlockSpan: 10_000 };
    const chainRpcs = chainRpcsWith(chain, [alchemy, publicRpc, dwellir]);
    const options = { chainRpcs, maxRetries: 0 };
    const logs = (toBlock: string) => [{ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock }] }];
    fetchWithRetryMock.mockResolvedValueOnce(httpFailure(503)).mockResolvedValueOnce(httpFailure(503))
      .mockResolvedValueOnce(rpcResponse([{ jsonrpc: "2.0", id: 1, result: [] }]));
    expect(await fetchEvmRpcBatch(chain, logs("0x3e8"), options)).toEqual([[]]);
    expect(attemptedUrls()).toEqual([dwellir.url, alchemy.url, publicRpc.url]);
    fetchWithRetryMock.mockClear();
    fetchWithRetryMock.mockResolvedValueOnce(httpFailure(503))
      .mockResolvedValueOnce(rpcResponse([{ jsonrpc: "2.0", id: 1, result: [] }]));
    expect(await fetchEvmRpcBatch(chain, logs("0x2710"), options)).toEqual([[]]);
    expect(attemptedUrls()).toEqual([dwellir.url, publicRpc.url]);
  });

  it.each([
    ["ink", "unadmitted"], ["ink", "disabled"], ["berachain", "unadmitted"],
    ["berachain", "disabled"], ["monad", "admitted"],
  ])("preserves the previous CCIP request order and payloads on %s when %s", async (chain, admission) => {
    const chainRpcs = buildChainRpcs("alchemy-key", undefined, admission === "unadmitted" ? undefined : {
      dwellirApiKey: "dwellir-key", dwellirRoutingDisabledChains: admission === "disabled" ? new Set([chain]) : undefined,
    });
    const requests = [
      [{ method: "eth_getCode", params: ["0xContract", { blockHash: `0x${"a".repeat(64)}`, requireCanonical: true }] }],
      [{ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x3e8" }] }],
    ];
    fetchWithRetryMock.mockResolvedValue(httpFailure(503));
    for (const calls of requests) await fetchEvmRpcBatch(chain, calls, { chainRpcs, excludeSupplementalRpc: true, maxRetries: 0 });
    const previous = fetchWithRetryMock.mock.calls.map(([url, init]) => [url, init.headers, init.body]);
    fetchWithRetryMock.mockClear();
    for (const calls of requests) await fetchEvmRpcBatch(chain, calls, { chainRpcs, maxRetries: 0 });
    expect(fetchWithRetryMock.mock.calls.map(([url, init]) => [url, init.headers, init.body])).toEqual(previous);
    expect(previous.length).toBeGreaterThan(0);
    expect(recordDwellirCreditsMock).not.toHaveBeenCalled();
  });

  it("retains run-local Dwellir demotion for the CCIP archive profile", async () => {
    const dwellir = dwellirEndpoint("https://ink.ccip-demotion.example");
    const alchemy = registryEndpoint("https://ink.ccip-fallback.example", "alchemy");
    const chainRpcs = chainRpcsWith("ink", [alchemy, dwellir]);
    const calls = [{ method: "eth_getCode", params: ["0xContract", { blockHash: `0x${"a".repeat(64)}`, requireCanonical: true }] }];
    const logs = { kind: "logs" as const, fromBlock: 1, toBlock: 1 };
    expect(usableCcipRpcEndpoints("ink", chainRpcs, logs)).toEqual([dwellir, alchemy]);
    fetchWithRetryMock.mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValue(rpcResponse([{ jsonrpc: "2.0", id: 1, result: "0x6000" }]));
    for (let i = 0; i < 2; i++) expect(await fetchEvmRpcBatch("ink", calls, { chainRpcs, maxRetries: 0 })).toEqual(["0x6000"]);
    expect(attemptedUrls()).toEqual([dwellir.url, alchemy.url, alchemy.url]);
    expect(usableCcipRpcEndpoints("ink", chainRpcs, logs)).toEqual([alchemy]);
  });

  it.each(["bsc", "monad", "zksync"])("admits exact recent finalized state on %s but intersects mixed batch requirements", async chain => {
    const chainRpcs = buildChainRpcs("alchemy-key", undefined, { dwellirApiKey: "dwellir-key" });
    const header = { number: 100, hash: `0x${"a".repeat(64)}` as `0x${string}`, timestamp: Math.floor(Date.now() / 1000) - 10 };
    const recentStatePin = { chainId: chain, header, finalized: header, observedAtSec: header.timestamp + 1, maxAgeSec: 1800 };
    const selector = { blockHash: header.hash, requireCanonical: true };
    fetchWithRetryMock.mockImplementation(async (_url, init) => rpcResponse(
      JSON.parse(String(init.body)).map((request: { id: number }) => ({ id: request.id, result: "0x6000" })),
    ));
    const current = { method: "eth_getCode", params: ["0xContract", selector] };
    expect(await fetchEvmRpcBatch(chain, [current], { chainRpcs, recentStatePin })).toEqual(["0x6000"]);
    expect(attemptedUrls()[0]).toContain(".n.dwellir.com");
    fetchWithRetryMock.mockClear();
    await fetchEvmRpcBatch(chain, [current, { method: "eth_getCode", params: ["0xContract", "0x1"] }], { chainRpcs, recentStatePin });
    expect(attemptedUrls().every(url => !url.includes(".n.dwellir.com"))).toBe(true);
    fetchWithRetryMock.mockClear();
    await fetchEvmCallHexAtBlock(chain, "0xContract", "0x1234", header.number, {
      chainRpcs, recentStatePin: { ...recentStatePin, chainId: "wrong" }, stateBlockHash: header.hash,
    });
    expect(attemptedUrls()).toEqual([]);
  });

  it("rejects expired, nonfinalized and below-floor recent pins without physical requests", async () => {
    const chainRpcs = buildChainRpcs("alchemy-key", undefined, { dwellirApiKey: "dwellir-key" });
    const header = { number: 100, hash: `0x${"a".repeat(64)}` as `0x${string}`, timestamp: Math.floor(Date.now() / 1000) - 10 };
    const base = { chainId: "bsc", header, finalized: header, observedAtSec: header.timestamp + 1, maxAgeSec: 1800 };
    for (const pin of [
      { ...base, maxAgeSec: 1 }, { ...base, finalized: { ...header, number: 99 } },
      { ...base, retainedFromBlock: 101 }, { ...base, observedAtSec: header.timestamp - 1 },
    ]) {
      expect(await fetchEvmCodeAtBlock("bsc", "0xContract", 100, { chainRpcs, recentStatePin: pin, stateBlockHash: header.hash })).toBeNull();
    }
    expect(attemptedUrls()).toEqual([]);
    expect(recordDwellirCreditsMock).not.toHaveBeenCalled();
  });

  it("separates BSC historical logs from recent state and bounds Monad retained log pages", async () => {
    const chainRpcs = buildChainRpcs("alchemy-key", undefined, { dwellirApiKey: "dwellir-key" });
    expect(usableCcipRpcEndpoints("bsc", chainRpcs, { kind: "logs", fromBlock: 1, toBlock: 10 })[0]?.operator).toBe("dwellir");
    expect(usableCcipRpcEndpoints("monad", chainRpcs, { kind: "logs", fromBlock: 1, toBlock: 10, observedHeadBlock: 2_000_000 })[0]?.operator).toBe("alchemy");
    expect(usableCcipRpcEndpoints("monad", chainRpcs, { kind: "logs", fromBlock: 1_990_001, toBlock: 2_000_000, observedHeadBlock: 2_000_000 })[0]?.operator).toBe("dwellir");
    expect(usableCcipRpcEndpoints("monad", chainRpcs, { kind: "logs", fromBlock: 1_990_000, toBlock: 2_000_000, observedHeadBlock: 2_000_000 })[0]?.operator).not.toBe("dwellir");
    expect(usableCcipRpcEndpoints("zksync", chainRpcs, { kind: "logs", fromBlock: 1, toBlock: 10 }).some(endpoint => endpoint.operator === "dwellir")).toBe(false);
  });

  it("keeps historical headers independent of state and rejects unsupported finalized tags", async () => {
    const chainRpcs = buildChainRpcs("alchemy-key", undefined, { dwellirApiKey: "dwellir-key" });
    const header = { number: "0x1", timestamp: "0x64", hash: `0x${"a".repeat(64)}` };
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: header }));
    expect(await fetchEvmBlockHeader("bsc", 1, { chainRpcs })).toMatchObject({ number: 1 });
    expect(attemptedUrls()[0]).toContain("api-bsc-mainnet-full.n.dwellir.com");
    fetchWithRetryMock.mockClear();
    expect(await fetchEvmBlockHeader("immutable-zkevm", "finalized", { chainRpcs })).toBeNull();
    expect(await fetchEvmRpcBatch("immutable-zkevm", [
      { method: "eth_getCode", params: ["0xContract", "finalized"] },
    ], { chainRpcs })).toBeNull();
    expect(attemptedUrls()).toEqual([]);
    expect(await fetchEvmBlockHeader("immutable-zkevm", 1, { chainRpcs })).toMatchObject({ number: 1 });
    expect(attemptedUrls()[0]).toContain("api-immutable-zkevm-mainnet.n.dwellir.com");
  });

  it("meters one latest-header read through Dwellir without granting historical state capability", async () => {
    const chainRpcs = buildChainRpcs("alchemy-key", undefined, { dwellirApiKey: "dwellir-key" });
    const dwellir = chainRpcs.get("bsc")!.endpoints.find(endpoint => endpoint.operator === "dwellir")!;
    const onRpcRequest = vi.fn();
    chainRpcs.get("bsc")!.onRpcRequest = onRpcRequest;
    const hash = `0x${"a".repeat(64)}`;
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result: { number: "0x64", timestamp: "0x64", hash } }));
    expect(await fetchEvmBlockHeaderAtTag("bsc", "latest", { chainRpcs })).toEqual({ number: 100, timestamp: 100, hash });
    expect(attemptedUrls()).toEqual([dwellir.url]);
    expect(JSON.parse(String(fetchWithRetryMock.mock.calls[0][1].body)).params).toEqual(["latest", false]);
    expect(recordDwellirCreditsMock.mock.calls).toEqual([[1]]);
    expect(onRpcRequest.mock.calls.map(([request]) => request)).toEqual([
      { providerOrigin: new URL(dwellir.url).origin, method: "eth_getBlockByNumber", rpcCalls: 1, signal: undefined },
    ]);
    fetchWithRetryMock.mockClear();
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "0x6000" }));
    await fetchEvmCodeAtBlock("bsc", "0xContract", 100, { chainRpcs });
    expect(attemptedUrls().length).toBeGreaterThan(0);
    expect(attemptedUrls()).not.toContain(dwellir.url);
    expect(recordDwellirCreditsMock.mock.calls).toEqual([[1]]);
  });

  it("parses uint256 hex values safely", () => {
    expect(parseUint256Hex("0x64")).toBe(100n);
    expect(parseUint256Hex("0x")).toBeNull();
    expect(parseUint256Hex("not-hex")).toBeNull();
  });

  it.each(["0xgg", "0x1", `0x${"ff".repeat(33)}`, "0x"])(
    "fails over before selecting malformed uint output %s", async result => {
      fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result }))
        .mockResolvedValueOnce(rpcResponse({ result: `0x${word(42)}` }));
      expect(await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
        extraRpcUrls: ["https://primary.example", "https://secondary.example"],
      })).toBe(42n);
      expect(attemptedUrls()).toEqual(["https://primary.example", "https://secondary.example"]);
    },
  );

  it("keeps arbitrary-length valid byte returns in the raw API", async () => {
    const result = `0x${"ab".repeat(33)}`;
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result }));
    expect(await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://primary.example"],
    })).toBe(result);
  });

  it.each(["0xgg", "0x1"])("fails over malformed raw bytes %s", async result => {
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result }))
      .mockResolvedValueOnce(rpcResponse({ result: "0x123456" }));
    expect(await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://primary.example", "https://secondary.example"],
    })).toBe("0x123456");
  });


  it.each([undefined, 131072])("forwards only an explicitly requested RPC body ceiling (%s)", async maxResponseBytes => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "0x64" }));
    expect(await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.example"], maxResponseBytes,
    })).toBe(100n);
    const options = fetchWithRetryMock.mock.calls[0]![3];
    if (maxResponseBytes === undefined) expect(options).not.toHaveProperty("maxResponseBytes");
    else expect(options.maxResponseBytes).toBe(maxResponseBytes);
  });

  it("forwards the optional body ceiling to JSON-RPC batches without changing their default", async () => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse([{ jsonrpc: "2.0", id: 1, result: "0x64" }]));
    expect(await fetchEvmRpcBatch(undefined, [{ method: "eth_blockNumber", params: [] }], {
      extraRpcUrls: ["https://rpc.example"], maxResponseBytes: 131072,
    })).toEqual(["0x64"]);
    expect(fetchWithRetryMock.mock.calls[0]![3]).toHaveProperty("maxResponseBytes", 131072);
  });

  it("falls back to a later RPC URL when the first one fails", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Not found" }), { status: 404 }))
      .mockResolvedValueOnce(rpcResponse({ result: "0xc8" }));

    const result = await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
    });

    expect(result).toBe(200n);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ retryMode: "network-only" }));
  });

  it("falls back when an RPC returns a null result", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(
      rpcResponse({ result: null }),
    );

    await expect(
      fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("null result"));
    warnSpy.mockRestore();
  });

  it("caps each fallback request to the remaining absolute deadline", async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    fetchWithRetryMock.mockImplementation(async () => {
      nowMs += 400;
      return null;
    });

    await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      timeoutMs: 10_000,
      deadlineMs: 2_000,
      maxRetries: 0,
    });

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ timeoutMs: 1_000 }));
    expect(fetchWithRetryMock.mock.calls[1]?.[3]).toEqual(expect.objectContaining({ timeoutMs: 600 }));
    nowSpy.mockRestore();
  });

  it("does not start a fallback RPC after the absolute deadline", async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    fetchWithRetryMock.mockImplementation(async () => {
      nowMs = 2_001;
      return null;
    });

    await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      timeoutMs: 10_000,
      deadlineMs: 2_000,
      maxRetries: 0,
    });

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("charges the request guard separately for primary and fallback URL attempts", async () => {
    fetchWithRetryMock.mockResolvedValue(null);
    let attemptsRemaining = 1;
    const beforeRequest = vi.fn(() => {
      if (attemptsRemaining <= 0) return false;
      attemptsRemaining -= 1;
      return true;
    });

    await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      maxRetries: 0,
      beforeRequest,
    });

    expect(beforeRequest.mock.calls).toEqual([["https://rpc.primary"], ["https://rpc.fallback"]]);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it("encodes Multicall3 aggregate3 calldata", () => {
    expect(
      encodeMulticall3Aggregate3CallData([
        {
          label: "balance",
          target: "0x1111111111111111111111111111111111111111",
          callData: "0x12345678",
        },
      ]),
    ).toBe(
      "0x82ad56cb" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000001111111111111111111111111111111111111111" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000060" +
        "0000000000000000000000000000000000000000000000000000000000000004" +
        "1234567800000000000000000000000000000000000000000000000000000000",
    );
  });

  it("returns JSON-RPC batch results in request order", async () => {
    const controller = new AbortController();
    fetchWithRetryMock.mockResolvedValueOnce(
      rpcResponse([
        { jsonrpc: "2.0", id: 2, result: "second" },
        { jsonrpc: "2.0", id: 1, result: "first" },
      ]),
    );
    const calls = [
      { method: "eth_blockNumber", params: [] },
      { method: "eth_getCode", params: ["0xToken", "safe"] },
    ];

    await expect(
      fetchEvmRpcBatch("gnosis", calls, {
        extraRpcUrls: ["https://rpc.example"],
        signal: controller.signal,
        timeoutMs: 1_234,
        maxRetries: 0,
      }),
    ).resolves.toEqual(["first", "second"]);

    expect(fetchWithRetryMock).toHaveBeenCalledWith(
      "https://rpc.example",
      expect.objectContaining({ method: "POST", signal: controller.signal }),
      0,
      expect.objectContaining({ timeoutMs: 1_234, retryMode: "network-only", beforeRequest: expect.any(Function) }),
    );
    const body = JSON.parse(String(fetchWithRetryMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: ["0xToken", "safe"] },
    ]);
  });

  it("fails closed when JSON-RPC batch responses are malformed or error", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        rpcResponse([null, { jsonrpc: "2.0", id: 2, result: "second" }]),
      )
      .mockResolvedValueOnce(
        rpcResponse([
          { jsonrpc: "2.0", id: 1, result: "first" },
          { jsonrpc: "2.0", id: 2, error: { code: -32_000, message: "failure" } },
        ]),
      )
      .mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(
      fetchEvmRpcBatch(
        "gnosis",
        [{ method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] }],
        {
          extraRpcUrls: [
            "https://rpc.malformed",
            "https://rpc.error-envelope",
            "https://rpc.unavailable",
          ],
          maxRetries: 0,
        },
      ),
    ).resolves.toBeNull();
    expect(fetchWithRetryMock.mock.calls.map(([url]) => url)).toEqual([
      "https://rpc.malformed", "https://rpc.error-envelope", "https://rpc.unavailable",
    ]);
  });

  it("preserves per-call errors in detailed JSON-RPC batches", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      rpcResponse([
        { jsonrpc: "2.0", id: 2, error: { code: 3, message: "execution reverted" } },
        { jsonrpc: "2.0", id: 1, result: "0x2a" },
      ]),
    );

    await expect(
      fetchEvmRpcBatchDetailed(
        "rootstock",
        [{ method: "eth_call", params: ["first"] }, { method: "eth_call", params: ["second"] }],
        { extraRpcUrls: ["https://rpc.example"] },
      ),
    ).resolves.toEqual({
      results: ["0x2a", undefined],
      errors: [{ index: 1, code: 3, message: "execution reverted" }],
    });
  });

  it.each([
    ["null entry", [null, { jsonrpc: "2.0", id: 2, result: "second" }]],
    ["duplicate identity", [{ jsonrpc: "2.0", id: 1, result: "first" }, { jsonrpc: "2.0", id: 1, result: "duplicate" }]],
    ["missing result", [{ jsonrpc: "2.0", id: 1, result: "first" }, { jsonrpc: "2.0", id: 2 }]],
  ])("rejects a detailed batch with %s", async (_label, payload) => {
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse(payload));
    await expect(fetchEvmRpcBatchDetailed(
      "rootstock",
      [{ method: "eth_call", params: ["first"] }, { method: "eth_call", params: ["second"] }],
      { extraRpcUrls: ["https://rpc.example"], maxRetries: 0 },
    )).resolves.toBeNull();
  });

  it("decodes Multicall3 aggregate3 partial failures from the canonical contract", async () => {
    const calls = [
      {
        label: "supply",
        target: "0x1111111111111111111111111111111111111111",
        callData: "0x18160ddd",
      },
      {
        label: "optional-paused",
        target: "0x2222222222222222222222222222222222222222",
        callData: "0x5c975abb",
        allowFailure: true,
      },
    ];
    const successReturnData = `0x${word(42)}`;
    fetchWithRetryMock.mockResolvedValue(
      rpcResponse({
        result: encodeAggregate3Return([
          { success: true, returnData: successReturnData },
          { success: false, returnData: "0x" },
        ]),
      }),
    );
    const controller = new AbortController();

    const result = await fetchEvmMulticall3Aggregate3AtBlock("ethereum", calls, "latest", {
      extraRpcUrls: ["https://rpc.example"],
      signal: controller.signal,
      timeoutMs: 1234,
    });

    expect(result).toEqual([
      { label: "supply", success: true, returnData: successReturnData },
      { label: "optional-paused", success: false, returnData: "0x" },
    ]);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock.mock.calls[0][0]).toBe("https://rpc.example");
    expect(fetchWithRetryMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(fetchWithRetryMock.mock.calls[0][3]).toEqual(expect.objectContaining({ timeoutMs: 1234, retryMode: "network-only", beforeRequest: expect.any(Function) }));

    const body = JSON.parse(fetchWithRetryMock.mock.calls[0][1]?.body) as {
      method: string;
      params: Array<{ to: string; data: string } | string>;
    };
    expect(body.method).toBe("eth_call");
    expect(body.params[0]).toMatchObject({
      to: MULTICALL3_ADDRESS,
      data: encodeMulticall3Aggregate3CallData(calls),
    });
    expect(body.params[1]).toBe("latest");
  });

  it.each([
    "0x", "0x1234",
    encodeAggregate3Return([]),
    `0x${word(32)}${word(1)}${word(32)}${word(2)}${word(64)}${encodeBytes("0x")}`,
  ])("fails over before selecting malformed Multicall output %s", async result => {
    const valid = encodeAggregate3Return([{ success: true, returnData: "0x123456" }]);
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result }))
      .mockResolvedValueOnce(rpcResponse({ result: valid }));
    expect(await fetchEvmMulticall3Aggregate3AtBlock(undefined, [{
      label: "probe", target: `0x${"1".repeat(40)}`, callData: "0x12345678",
    }], "latest", { extraRpcUrls: ["https://primary.example", "https://secondary.example"] }))
      .toEqual([{ label: "probe", success: true, returnData: "0x123456" }]);
    expect(attemptedUrls()).toEqual(["https://primary.example", "https://secondary.example"]);
  });

  it("chunks Multicall3 aggregate3 requests when a batch size is configured", async () => {
    const calls = [
      {
        label: "first",
        target: "0x1111111111111111111111111111111111111111",
        callData: "0x11111111",
      },
      {
        label: "second",
        target: "0x2222222222222222222222222222222222222222",
        callData: "0x22222222",
      },
      {
        label: "third",
        target: "0x3333333333333333333333333333333333333333",
        callData: "0x33333333",
      },
    ];
    const firstReturnData = `0x${word(1)}`;
    const secondReturnData = `0x${word(2)}`;
    const thirdReturnData = `0x${word(3)}`;
    fetchWithRetryMock
      .mockResolvedValueOnce(
        rpcResponse({
          result: encodeAggregate3Return([
            { success: true, returnData: firstReturnData },
            { success: true, returnData: secondReturnData },
          ]),
        }),
      )
      .mockResolvedValueOnce(
        rpcResponse({
          result: encodeAggregate3Return([{ success: true, returnData: thirdReturnData }]),
        }),
      );

    const result = await fetchEvmMulticall3Aggregate3AtBlock("ethereum", calls, "latest", {
      extraRpcUrls: ["https://rpc.example"],
      multicallBatchSize: 2,
    });

    expect(result).toEqual([
      { label: "first", success: true, returnData: firstReturnData },
      { label: "second", success: true, returnData: secondReturnData },
      { label: "third", success: true, returnData: thirdReturnData },
    ]);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchWithRetryMock.mock.calls[0][1]?.body) as {
      params: Array<{ data: string } | string>;
    };
    const secondBody = JSON.parse(fetchWithRetryMock.mock.calls[1][1]?.body) as {
      params: Array<{ data: string } | string>;
    };
    expect(firstBody.params[0]).toMatchObject({
      data: encodeMulticall3Aggregate3CallData(calls.slice(0, 2)),
    });
    expect(secondBody.params[0]).toMatchObject({
      data: encodeMulticall3Aggregate3CallData(calls.slice(2)),
    });
  });

  it("preserves successful empty direct returns and the default allowed failure", async () => {
    const hash = `0x${"a".repeat(64)}` as `0x${string}`;
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result: "0x" }))
      .mockResolvedValueOnce(rpcResponse({ result: "0x" }))
      .mockResolvedValueOnce(rpcResponse({ error: { code: 3, message: "execution reverted" } }))
      .mockResolvedValueOnce(rpcResponse({ result: { number: "0x10", timestamp: "0x64", hash } }));

    expect(await fetchEvmMulticall3Aggregate3AtBlock("ethereum", [
      { label: "empty-success", target: "0x1111111111111111111111111111111111111111",
        callData: "0x11111111", allowFailure: false },
      { label: "optional-revert", target: "0x1111111111111111111111111111111111111111",
        callData: "0x22222222" },
    ], 16, {
      extraRpcUrls: ["https://rpc.example"], multicallFallbackBlockHash: hash,
    })).toEqual([
      { label: "empty-success", success: true, returnData: "0x" },
      { label: "optional-revert", success: false, returnData: "0x" },
    ]);
  });
  it.each(["rate-limit", "http-rate-limit", "http", "missing-state", "transport", "budget", "execution-budget"])(
    "does not turn optional direct %s unavailability into interface absence", async failure => {
      const hash = `0x${"a".repeat(64)}` as `0x${string}`;
      fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result: "0x" }));
      if (failure === "transport") fetchWithRetryMock.mockResolvedValue(null);
      else if (failure === "http" || failure === "http-rate-limit") {
        fetchWithRetryMock.mockResolvedValue(httpFailure(failure === "http" ? 503 : 429));
      }
      else fetchWithRetryMock.mockResolvedValue(rpcResponse({ error: {
        code: failure === "rate-limit" ? -32005 : -32000,
        message: failure === "rate-limit" ? "rate limit exceeded" :
          failure === "execution-budget" ? "out of gas" : "missing trie node",
      } }));
      let admitted = 0;
      const beforeRequest = vi.fn(() => failure !== "budget" || admitted++ === 0);
      expect(await fetchEvmMulticall3Aggregate3AtBlock("ethereum", [{
        label: "optional", target: `0x${"1".repeat(40)}`, callData: "0x12345678",
      }], 16, {
        extraRpcUrls: ["https://primary.example", "https://secondary.example"],
        multicallFallbackBlockHash: hash, beforeRequest, maxRetries: 0,
        stopOnExecutionBudgetError: failure === "execution-budget",
      })).toBeNull();
      expect(fetchWithRetryMock.mock.calls.every(([, init]) =>
        JSON.parse(String(init.body)).method !== "eth_getBlockByNumber")).toBe(true);
      expect(fetchWithRetryMock).toHaveBeenCalledTimes(
        failure === "budget" ? 1 : failure === "execution-budget" ? 2 : 3,
      );
    },
  );

  it.each([true, false])("only permits an observed direct revert when allowFailure is %s", async allowFailure => {
    const hash = `0x${"a".repeat(64)}` as `0x${string}`;
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result: "0x" }))
      .mockResolvedValueOnce(rpcResponse({ error: { code: 3, message: "execution reverted" } }))
      .mockResolvedValueOnce(rpcResponse({ result: blockResult(16, "0x64") }));
    expect(await fetchEvmMulticall3Aggregate3AtBlock("ethereum", [{
      label: "optional", target: `0x${"1".repeat(40)}`, callData: "0x12345678", allowFailure,
    }], 16, {
      extraRpcUrls: ["https://primary.example", "https://secondary.example"], multicallFallbackBlockHash: hash,
    })).toEqual(allowFailure ? [{ label: "optional", success: false, returnData: "0x" }] : null);
    expect(attemptedUrls()).toEqual(Array(allowFailure ? 3 : 2).fill("https://primary.example"));
  });

  it("rejects another RPC fork when the primary lacks fallback call state", async () => {
    const hash = `0x${"a".repeat(64)}` as `0x${string}`;
    fetchWithRetryMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_getCode") return rpcResponse({ result: "0x" });
      if (body.method === "eth_getBlockByNumber") return rpcResponse({ result: { number: "0x10", timestamp: "0x64", hash } });
      if (String(url).includes("primary") || body.params[1]?.blockHash === hash) return rpcResponse({ error: { code: -32000, message: "canonical snapshot unavailable" } });
      return rpcResponse({ result: `0x${"f".repeat(64)}` });
    });
    expect(await fetchEvmMulticall3Aggregate3AtBlock("ethereum", [{
      label: "supply", target: `0x${"1".repeat(40)}`, callData: "0x18160ddd", allowFailure: false,
    }], 16, { extraRpcUrls: ["https://primary.example", "https://secondary.example"], multicallFallbackBlockHash: hash })).toBeNull();
  });
  it.each(["code", "storage"])("rejects unbound %s from a fallback fork", async kind => {
    const hash = `0x${"a".repeat(64)}` as `0x${string}`;
    fetchWithRetryMock.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body)), block = request.params.at(-1);
      return String(url).includes("primary") || block?.blockHash === hash
        ? rpcResponse({ error: { code: -32000, message: "snapshot unavailable" } })
        : rpcResponse({ result: `0x${"f".repeat(64)}` });
    });
    const options = { extraRpcUrls: ["https://primary.example", "https://secondary.example"], stateBlockHash: hash };
    const address = `0x${"1".repeat(40)}`;
    expect(await (kind === "code" ? fetchEvmCodeAtBlock("ethereum", address, 16, options) :
      fetchEvmStorageAtBlock("ethereum", address, `0x${"0".repeat(64)}`, 16, options))).toBeNull();
  });


  it("falls back when first eth_call result is empty hex", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result: "0x" }))
      .mockResolvedValueOnce(rpcResponse({ result: "0x2a" }));

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
    });

    expect(result).toBe("0x2a");
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });


  it("normalizes gas as a JSON-RPC quantity before sending eth_call", async () => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "0x2a" }));

    await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.example"],
      gas: "0x0F4240",
    });

    const body = JSON.parse(fetchWithRetryMock.mock.calls[0][1]?.body) as {
      params: Array<{ gas?: string }>;
    };
    expect(body.params[0]?.gas).toBe("0xF4240");
  });

  it("falls back when eth_call returns an invalid hex result", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result: "not-hex" }))
      .mockResolvedValueOnce(rpcResponse({ result: "0x2a" }));

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
    });

    expect(result).toBe("0x2a");
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when eth_call returns only invalid results", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "not-hex" }));

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[evm-rpc] eth_call failed across 1 RPCs"));
    warnSpy.mockRestore();
  });

  it("distinguishes absent bytecode from an unavailable code request", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result: "0x" }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rpcResponse({ result: "0x6000" }));

    await expect(fetchEvmCodeStatusAtBlock(undefined, "0xPool", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    })).resolves.toEqual({ status: "absent" });
    await expect(fetchEvmCodeStatusAtBlock(undefined, "0xPool", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    })).resolves.toEqual({ status: "unavailable" });
    await expect(fetchEvmCodeAtBlock(undefined, "0xPool", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    })).resolves.toBe("0x6000");
  });

  it("reads contract storage at a block and rejects empty storage results", async () => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: `0x${word(7)}` }));

    await expect(
      fetchEvmStorageAtBlock(undefined, "0xContract", "0x0", 1_234, {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toBe(`0x${word(7)}`);

    const body = JSON.parse(String(fetchWithRetryMock.mock.calls[0]?.[1]?.body)) as {
      method: string;
      params: unknown[];
    };
    expect(body.method).toBe("eth_getStorageAt");
    expect(body.params).toEqual(["0xContract", "0x0", "0x4d2"]);

    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result: "0x" }));
    await expect(
      fetchEvmStorageAtBlock(undefined, "0xContract", "0x0", "latest", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toBeNull();
  });

  it("reads a raw JSON-RPC hex result from a specific URL", async () => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "0xdeadbeef" }));

    await expect(
      fetchJsonRpcHexAtUrl("https://rpc.example", "eth_chainId", []),
    ).resolves.toBe("0xdeadbeef");
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);

    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result: "0x" }));
    await expect(
      fetchJsonRpcHexAtUrl("https://rpc.example", "eth_chainId", []),
    ).resolves.toBeNull();
  });

  it.each([undefined, "1", 2, 1.5])("rejects an unmatched single response identity %s before admitting data", async id => {
    fetchWithRetryMock.mockResolvedValueOnce(new Response(JSON.stringify({ id, result: "0x10" })));
    expect(await fetchJsonRpcHexAtUrl("https://rpc.example", "eth_chainId", [])).toBeNull();
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it("fetches block numbers and timestamps through the shared RPC path", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result: "0x10" }))
      .mockResolvedValueOnce(rpcResponse({ result: blockResult(16, "0x64") }));

    const blockNumber = await fetchEvmBlockNumber("ethereum", { extraRpcUrls: ["https://rpc.example"] });
    const blockTimestamp = await fetchEvmBlockTimestamp("ethereum", 16, { extraRpcUrls: ["https://rpc.example"] });

    expect(blockNumber).toBe(16);
    expect(blockTimestamp).toBe(100);
  });

  it.each([null, {}, { timestamp: "invalid" }, blockResult(16, "0x0"), blockResult(16, "0x20000000000000"),
    blockResult(17, "0x64"), { number: "0x10", timestamp: "0x64" }])(
    "tries the next provider when the block timestamp is unusable: %j",
    async (result) => {
      fetchWithRetryMock
        .mockResolvedValueOnce(rpcResponse({ result }))
        .mockResolvedValueOnce(rpcResponse({ result: blockResult(16, "0x64") }));
      await expect(fetchEvmBlockTimestamp("fantom", 16, {
        extraRpcUrls: ["https://primary.example", "https://fallback.example"],
      })).resolves.toBe(100);
      expect(fetchWithRetryMock.mock.calls.map((call) => call[0])).toEqual([
        "https://primary.example", "https://fallback.example",
      ]);
      for (const call of fetchWithRetryMock.mock.calls) {
        expect(JSON.parse(String(call[1].body)).params).toEqual(["0x10", false]);
      }
    },
  );

  it("withholds the timestamp when every provider returns an unusable block", async () => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: {} }));
    await expect(fetchEvmBlockTimestamp("fantom", 16, {
      extraRpcUrls: ["https://primary.example", "https://fallback.example"],
    })).resolves.toBeNull();
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it("requires a numbered block header with its canonical hash", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        rpcResponse({
          result: {
            number: "0x10",
            timestamp: "0x64",
            hash: `0x${"A".repeat(64)}`,
          },
        }),
      )
      .mockResolvedValueOnce(
        rpcResponse({
          result: {
            number: "0x11",
            timestamp: "0x64",
            hash: `0x${"b".repeat(64)}`,
          },
        }),
      );

    await expect(
      fetchEvmBlockHeader("ethereum", 16, { extraRpcUrls: ["https://rpc.example"] }),
    ).resolves.toEqual({
      number: 16,
      timestamp: 100,
      hash: `0x${"a".repeat(64)}`,
    });
    await expect(
      fetchEvmBlockHeader("ethereum", 16, { extraRpcUrls: ["https://rpc.example"] }),
    ).resolves.toBeNull();
  });

  it.each([
    null,
    {},
    { number: "0x11", timestamp: "0xc8", hash: `0x${"b".repeat(64)}` },
    { timestamp: "0xc8", hash: `0x${"b".repeat(64)}` },
    { number: "not-hex", timestamp: "0xc8", hash: `0x${"b".repeat(64)}` },
    { number: "0x10", timestamp: "0xc8" },
    { number: "0x10", timestamp: "0xc8", hash: "0x1234" },
    { number: "0x10", timestamp: "0xc8", hash: 123 },
    { number: "0x10", hash: `0x${"b".repeat(64)}` },
    { number: "0x10", timestamp: "invalid", hash: `0x${"b".repeat(64)}` },
    { number: "0x10", timestamp: "0x0", hash: `0x${"b".repeat(64)}` },
    { number: "0x10", timestamp: "0x20000000000000", hash: `0x${"b".repeat(64)}` },
  ])("tries the next provider only after rejecting the entire invalid header: %j", async (result) => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result }))
      .mockResolvedValueOnce(rpcResponse({
        result: { number: "0x10", timestamp: "0x64", hash: `0x${"A".repeat(64)}` },
      }));
    await expect(fetchEvmBlockHeader("rootstock", 16, {
      extraRpcUrls: ["https://primary.example", "https://fallback.example"],
    })).resolves.toEqual({ number: 16, timestamp: 100, hash: `0x${"a".repeat(64)}` });
    expect(attemptedUrls()).toEqual(["https://primary.example", "https://fallback.example"]);
    for (const call of fetchWithRetryMock.mock.calls) {
      expect(JSON.parse(String(call[1].body)).params).toEqual(["0x10", false]);
    }
  });

  it.each([
    { number: "0x11", timestamp: "0x64", hash: `0x${"a".repeat(64)}` },
    { number: "0x10", timestamp: "0x64" },
    { number: "0x10", timestamp: "0x64", hash: `0x${"g".repeat(64)}` },
    { number: "0x10", timestamp: "0x0", hash: `0x${"a".repeat(64)}` },
    { number: "0x10", timestamp: 100, hash: `0x${"a".repeat(64)}` },
    { number: "0x10", timestamp: "0x20000000000000", hash: `0x${"a".repeat(64)}` },
  ])("withholds the header when every configured provider fails admission: %j", async (result) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result }));
    await expect(fetchEvmBlockHeader("rootstock", 16, {
      extraRpcUrls: ["https://primary.example", "https://fallback.example"],
    })).resolves.toBeNull();
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it("fails over a well-formed stale finalized head without changing the requested tag", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({
        result: { number: "0x10", timestamp: "0x63", hash: `0x${"a".repeat(64)}` },
      }))
      .mockResolvedValueOnce(rpcResponse({
        result: { number: "0x11", timestamp: "0x64", hash: `0x${"b".repeat(64)}` },
      }));
    await expect(fetchEvmBlockHeader("rootstock", "finalized", {
      extraRpcUrls: ["https://primary.example", "https://fallback.example"],
      minTimestampSec: 100,
    })).resolves.toEqual({ number: 17, timestamp: 100, hash: `0x${"b".repeat(64)}` });
    expect(attemptedUrls()).toEqual(["https://primary.example", "https://fallback.example"]);
    for (const call of fetchWithRetryMock.mock.calls) {
      expect(JSON.parse(String(call[1].body)).params).toEqual(["finalized", false]);
    }
  });

  it("withholds finalized evidence when every endpoint returns a stale head", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(rpcResponse({
      result: { number: "0x10", timestamp: "0x63", hash: `0x${"a".repeat(64)}` },
    }));
    await expect(fetchEvmBlockHeader("rootstock", "finalized", {
      extraRpcUrls: ["https://primary.example", "https://fallback.example"],
      minTimestampSec: 100,
    })).resolves.toBeNull();
    expect(attemptedUrls()).toEqual(["https://primary.example", "https://fallback.example"]);
  });

  it.each([true, false])("requires finalized coverage of the holding pin across providers (fallback covers pin: %s)", async coversPin => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({
        result: { number: "0x10", timestamp: "0x64", hash: `0x${"a".repeat(64)}` },
      }))
      .mockResolvedValueOnce(rpcResponse({
        result: { number: coversPin ? "0x11" : "0x10", timestamp: "0x64", hash: `0x${"b".repeat(64)}` },
      }));
    const result = await fetchEvmBlockHeader("rootstock", "finalized", {
      extraRpcUrls: ["https://primary.example", "https://fallback.example"],
      minBlockNumber: 17,
    });
    expect(result).toEqual(coversPin ? { number: 17, timestamp: 100, hash: `0x${"b".repeat(64)}` } : null);
    expect(attemptedUrls()).toEqual(["https://primary.example", "https://fallback.example"]);
    for (const call of fetchWithRetryMock.mock.calls) {
      expect(JSON.parse(String(call[1].body)).params).toEqual(["finalized", false]);
    }
  });

  it.each(["0x20000000000000", "not-hex"])(
    "rejects an unsafe or malformed numbered finalized header: %s",
    async (number) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({
        result: { number, timestamp: "0x64", hash: `0x${"a".repeat(64)}` },
      }));
      await expect(fetchEvmBlockHeader("rootstock", "finalized", {
        extraRpcUrls: ["https://primary.example"],
      })).resolves.toBeNull();
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid requested block numbers without issuing a header request: %s",
    async (number) => {
      await expect(fetchEvmBlockHeader("rootstock", number, {
        extraRpcUrls: ["https://primary.example"],
      })).resolves.toBeNull();
      expect(fetchWithRetryMock).not.toHaveBeenCalled();
    },
  );

  it.each(["latest", "finalized"] as const)("resolves a validated header at the requested %s tag", async (tag) => {
    fetchWithRetryMock.mockResolvedValueOnce(
      rpcResponse({
        result: {
          number: "0x10",
          timestamp: "0x64",
          hash: `0x${"c".repeat(64)}`,
        },
      }),
    );

    await expect(
      fetchEvmBlockHeaderAtTag("ethereum", tag, {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toEqual({
      number: 16,
      timestamp: 100,
      hash: `0x${"c".repeat(64)}`,
    });
    const lastCall =
      fetchWithRetryMock.mock.calls[fetchWithRetryMock.mock.calls.length - 1];
    const body = JSON.parse(String(lastCall?.[1]?.body)) as {
      params: unknown[];
    };
    expect(body.params).toEqual([tag, false]);
  });

  it("resolves a canonical block header at the safe tag", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      rpcResponse({
        result: {
          number: "0x20",
          timestamp: "0x80",
          hash: `0x${"D".repeat(64)}`,
        },
      }),
    );

    await expect(
      fetchEvmBlockHeaderAtTag("gnosis", "safe", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toEqual({
      number: 32,
      timestamp: 128,
      hash: `0x${"d".repeat(64)}`,
    });
    const body = JSON.parse(String(fetchWithRetryMock.mock.calls[0]?.[1]?.body)) as {
      params: unknown[];
    };
    expect(body.params).toEqual(["safe", false]);
  });


  it("returns null when the safe block header request errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(
      fetchEvmBlockHeaderAtTag("gnosis", "safe", {
        extraRpcUrls: ["https://rpc.example"],
        maxRetries: 0,
      }),
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[evm-rpc] eth_getBlockByNumber failed across 1 RPCs"),
    );
    warnSpy.mockRestore();
  });

  it("resolves the closest block at or before a target timestamp", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result: blockResult(95, "0x3b6") }))
      .mockResolvedValueOnce(rpcResponse({ result: blockResult(92, "0x398") }))
      .mockResolvedValueOnce(rpcResponse({ result: blockResult(91, "0x38e") }));

    const block = await resolveClosestBlockAtOrBeforeTimestamp(
      "ethereum",
      900,
      {
        latestBlockNumber: 100,
        blockTimestampByNumber: new Map([
          [100, 1000],
          [90, 900],
        ]),
      },
      { extraRpcUrls: ["https://rpc.example"] },
    );

    expect(block).toBe(90);
  });

  it("brackets a near-tip scoring clock without probing pruned deep history", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ result: blockResult(99, "0x3e3") }))
      .mockResolvedValueOnce(rpcResponse({ result: blockResult(98, "0x3de") }));

    const block = await resolveClosestBlockAtOrBeforeTimestamp(
      "sei",
      990,
      {
        latestBlockNumber: 100,
        blockTimestampByNumber: new Map([[100, 1000]]),
      },
      { extraRpcUrls: ["https://rpc.example"] },
    );

    expect(block).toBe(98);
    const requestedBlockTags = fetchWithRetryMock.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body)) as { params: unknown[] };
      return body.params[0];
    });
    expect(requestedBlockTags).toEqual(["0x63", "0x62"]);
    expect(requestedBlockTags).not.toContain("0x32");
  });

  it("fetches proxy hex results from Etherscan", async () => {
    fetchWithRetryMock.mockResolvedValue(
      rpcResponse({ result: "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    );

    const result = await fetchEtherscanProxyHex({
      evmChainId: 1,
      action: "eth_getStorageAt",
      address: "0xProxy",
      position: "0xSlot",
      apiKey: "etherscan-key",
    });

    expect(result).toBe("0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("converts Etherscan proxy hex results to uint256", async () => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "0x12c" }));

    const result = await fetchEtherscanUint256AtBlock(1, "0xToken", "0x18160ddd", "latest", {
      apiKey: "etherscan-key",
    });

    expect(result).toBe(300n);
  });

  it("logs summary when all RPCs fail for fetchEvmCallHexAtBlock", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(
      rpcResponse({ error: { code: -32000, message: "nope" } }),
    );

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.a", "https://rpc.b"],
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[evm-rpc] eth_call failed across 2 RPCs"));
    warnSpy.mockRestore();
  });

  it("logs summary when all RPCs throw for fetchEvmUint256AtBlock", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockRejectedValue(new Error("network error"));

    const result = await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.a"],
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[evm-rpc] eth_call failed across 1 RPCs"));
    warnSpy.mockRestore();
  });

  it("returns null on malformed Etherscan payloads", async () => {
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "not-hex" }));

    const result = await fetchEtherscanProxyHex({
      evmChainId: 1,
      action: "eth_call",
      to: "0xToken",
      data: "0x18160ddd",
      apiKey: "etherscan-key",
    });

    expect(result).toBeNull();
  });

  it("tries Dwellir first then preserves registry and adapter fallback order", async () => {
    const chainRpcs = chainRpcsWith("ethereum", [
      registryEndpoint("https://eth-mainnet.g.alchemy.com/v2/", "alchemy"),
      registryEndpoint("https://ethereum-public-a.example"),
      dwellirEndpoint("https://api-ethereum-mainnet.n.dwellir.com"),
    ]);
    fetchWithRetryMock.mockResolvedValue(null);

    await expect(
      fetchEvmUint256AtBlock("ethereum", "0xToken", "0x18160ddd", "latest", {
        chainRpcs,
        extraRpcUrls: ["https://pinned.example"],
        maxRetries: 0,
      }),
    ).resolves.toBeNull();

    expect(attemptedUrls()).toEqual([
      "https://api-ethereum-mainnet.n.dwellir.com",
      "https://eth-mainnet.g.alchemy.com/v2/",
      "https://ethereum-public-a.example",
      "https://pinned.example",
    ]);
  });

  it("sends the Dwellir X-Api-Key and the Alchemy bearer from origin-keyed auth", async () => {
    registerRpcAuth("alchemy", "https://arb-mainnet.g.alchemy.com/v2/", { Authorization: "Bearer alchemy-key" });
    const chainRpcs = chainRpcsWith("arbitrum", [
      registryEndpoint("https://arb-mainnet.g.alchemy.com/v2/", "alchemy"),
      dwellirEndpoint("https://api-arbitrum-mainnet-archive.n.dwellir.com"),
    ]);
    fetchWithRetryMock.mockResolvedValue(null);

    await fetchEvmUint256AtBlock("arbitrum", "0xToken", "0x18160ddd", "latest", { chainRpcs, maxRetries: 0 });

    const headersByUrl = new Map(
      fetchWithRetryMock.mock.calls.map(([url, init]) => [url as string, (init as RequestInit).headers]),
    );
    expect(headersByUrl.get("https://arb-mainnet.g.alchemy.com/v2/")).toEqual(
      expect.objectContaining({ Authorization: "Bearer alchemy-key" }),
    );
    expect(headersByUrl.get("https://api-arbitrum-mainnet-archive.n.dwellir.com")).toEqual(
      expect.objectContaining({ "X-Api-Key": "dwellir-key" }),
    );
  });

  it.each(["registry", "supplemental"] as const)("applies Dwellir guards at %s position", async (position) => {
    const url = "https://api-routing-test.n.dwellir.com";
    const endpoint = { ...dwellirEndpoint(url, "recent"), position };
    const publicUrl = "https://routing-public.example";
    const chainRpcs = chainRpcsWith("base", [endpoint, registryEndpoint(publicUrl)]);
    fetchWithRetryMock.mockResolvedValue(null);
    await fetchEvmStorageAtBlock("base", "0xContract", "0x0", 1234, { chainRpcs, maxRetries: 0 });
    expect(attemptedUrls()).toEqual([publicUrl]);
    fetchWithRetryMock.mockClear();
    await fetchEvmRpcBatch("base", [{ method: "eth_call", params: [{}, "0x123"] }], { chainRpcs, maxRetries: 0 });
    expect(attemptedUrls()).toEqual([publicUrl]);
    fetchWithRetryMock.mockClear();
    await fetchEvmStorageAtBlock("base", "0xContract", "0x0", "latest", {
      chainRpcs, maxRetries: 0, excludeSupplementalRpc: true, extraRpcUrls: [url],
    });
    expect(attemptedUrls()).toEqual([publicUrl]);
    fetchWithRetryMock.mockClear();
    await fetchEvmStorageAtBlock("base", "0xContract", "0x0", "latest", { chainRpcs, maxRetries: 0 });
    expect(attemptedUrls()).toContain(url);
    fetchWithRetryMock.mockClear();
    await fetchEvmStorageAtBlock("base", "0xContract", "0x0", "latest", { chainRpcs, maxRetries: 0 });
    expect(attemptedUrls()).toEqual([publicUrl]);
  });

  it.each(["ethereum", "arbitrum"])(
    "admits full-history logs independently from state on %s", async (chainId) => {
      const dwellirUrl = `https://api-${chainId}-log-test.n.dwellir.com`;
      const publicUrl = `https://${chainId}-log-public.example`;
      const chainRpcs = chainRpcsWith(chainId, [
        { ...dwellirEndpoint(dwellirUrl), position: "registry", maxLogBlockSpan: 10_000 },
        registryEndpoint(publicUrl),
      ]);
      fetchWithRetryMock.mockResolvedValue(null);
      await fetchEvmRpcBatch(chainId, [{ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] }],
        { chainRpcs, maxRetries: 0 });
      expect(attemptedUrls()).toEqual([dwellirUrl, publicUrl]);
    },
  );

  it("skips Arbitrum Dwellir before sending a log batch over its inclusive 10k span", async () => {
    const publicUrl = "https://arbitrum-log-public.example";
    const chainRpcs = chainRpcsWith("arbitrum", [
      { ...dwellirEndpoint("https://api-arbitrum-log-test.n.dwellir.com"), position: "registry", maxLogBlockSpan: 10_000 },
      registryEndpoint(publicUrl),
    ]);
    fetchWithRetryMock.mockResolvedValue(null);
    await fetchEvmRpcBatch("arbitrum", [{ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2711" }] }],
      { chainRpcs, maxRetries: 0 });
    expect(attemptedUrls()).toEqual([publicUrl]);
  });

  it("keeps log lanes on registry endpoints when supplemental RPC is excluded", async () => {
    const chainRpcs = chainRpcsWith("base", [
      registryEndpoint("https://base-public-a.example"),
      dwellirEndpoint("https://api-base-mainnet-archive.n.dwellir.com"),
    ]);
    fetchWithRetryMock.mockResolvedValue(null);

    await fetchEvmUint256AtBlock("base", "0xToken", "0x18160ddd", "latest", {
      chainRpcs,
      extraRpcUrls: ["https://pinned.example"],
      excludeSupplementalRpc: true,
      maxRetries: 0,
    });

    expect(attemptedUrls()).toEqual(["https://base-public-a.example", "https://pinned.example"]);
  });

  it("skips near-head-only supplemental endpoints for a historical block", async () => {
    // Synthetic capabilities: production Polygon now supports archive state.
    const recentUrl = "https://recent-state.dwellir-fixture.example";
    const archiveUrl = "https://archive-state.dwellir-fixture.example";
    const endpoints = [
      registryEndpoint("https://polygon-public-a.example"),
      dwellirEndpoint(recentUrl, "recent"),
      dwellirEndpoint(archiveUrl),
    ];
    fetchWithRetryMock.mockResolvedValue(null);

    await fetchEvmStorageAtBlock("polygon", "0xContract", "0x0", 1_234, {
      chainRpcs: chainRpcsWith("polygon", endpoints),
      maxRetries: 0,
    });
    expect(attemptedUrls()).toEqual([archiveUrl, "https://polygon-public-a.example"]);

    fetchWithRetryMock.mockClear();
    await fetchEvmStorageAtBlock("polygon", "0xContract", "0x0", "latest", {
      chainRpcs: chainRpcsWith("polygon", endpoints),
      maxRetries: 0,
    });
    expect(attemptedUrls()).toEqual([recentUrl, archiveUrl, "https://polygon-public-a.example"]);
  });


  it("fails closed without throwing or metering a malformed RPC URL", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["::malformed"], maxRetries: 0,
    })).resolves.toBeNull();
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(recordDwellirCreditsMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[evm-rpc] eth_call failed across 1 RPCs"));
    warnSpy.mockRestore();
  });

  it("bounds header reads on retained-history Dwellir nodes by the observed head", async () => {
    const retained = { ...dwellirEndpoint("https://api-header-retention.n.dwellir.com"), logsHistory: { retainedBlocks: 100 } };
    const chainRpcs = chainRpcsWith("bsc", [retained]);
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ result: blockResult(950, "0x64") }));
    expect(await fetchEvmBlockHeader("bsc", 950, { chainRpcs, observedHeadBlock: 1000, maxRetries: 0 }))
      .toMatchObject({ number: 950 });
    expect(attemptedUrls()).toEqual([retained.url]);

    fetchWithRetryMock.mockClear();
    expect(await fetchEvmBlockHeader("bsc", 900, { chainRpcs, observedHeadBlock: 1000, maxRetries: 0 })).toBeNull();
    expect(await fetchEvmBlockHeader("bsc", 950, { chainRpcs, maxRetries: 0 })).toBeNull();
    expect(attemptedUrls()).toEqual([]);
  });

  it("meters one credit per Dwellir attempt and none for registry operators", async () => {
    const chainRpcs = chainRpcsWith("celo", [
      registryEndpoint("https://celo-public-a.example"),
      dwellirEndpoint("https://api-celo-mainnet-archive.n.dwellir.com"),
    ]);
    fetchWithRetryMock.mockResolvedValueOnce(httpFailure(500)).mockResolvedValueOnce(rpcResponse({ result: "0x64" }));

    await expect(
      fetchEvmUint256AtBlock("celo", "0xToken", "0x18160ddd", "latest", { chainRpcs, maxRetries: 0 }),
    ).resolves.toBe(100n);

    expect(recordDwellirCreditsMock.mock.calls).toEqual([[1]]);

    // The raw-URL helper reaches the provider through the same metered path.
    recordDwellirCreditsMock.mockClear();
    fetchWithRetryMock.mockReset();
    fetchWithRetryMock.mockResolvedValue(rpcResponse({ result: "0xdeadbeef" }));
    await expect(
      fetchJsonRpcHexAtUrl("https://api-celo-mainnet-archive.n.dwellir.com", "eth_chainId", []),
    ).resolves.toBe("0xdeadbeef");
    expect(recordDwellirCreditsMock.mock.calls).toEqual([[1]]);
  });

  it("meters one credit per batch item on the Dwellir attempt", async () => {
    const chainRpcs = chainRpcsWith("gnosis", [
      registryEndpoint("https://gnosis-public-a.example"),
      dwellirEndpoint("https://api-gnosis-mainnet.n.dwellir.com"),
    ]);
    fetchWithRetryMock
      .mockResolvedValueOnce(httpFailure(500))
      .mockResolvedValueOnce(
        rpcResponse([
          { jsonrpc: "2.0", id: 1, result: "first" },
          { jsonrpc: "2.0", id: 2, result: "second" },
        ]),
      );

    await expect(
      fetchEvmRpcBatch(
        "gnosis",
        [{ method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] }],
        { chainRpcs, maxRetries: 0 },
      ),
    ).resolves.toEqual(["first", "second"]);

    expect(recordDwellirCreditsMock.mock.calls).toEqual([[2]]);
  });

  it("demotes a failed Dwellir origin only for the run that observed the failure", async () => {
    const publicUrl = "https://optimism-public-a.example";
    const dwellirUrl = "https://api-optimism-mainnet-archive.n.dwellir.com";
    const endpoints = [registryEndpoint(publicUrl), dwellirEndpoint(dwellirUrl)];
    const failedTransportRun = chainRpcsWith("optimism", endpoints);
    const thrownTransportRun = chainRpcsWith("optimism", endpoints);
    const healthyRun = chainRpcsWith("optimism", endpoints);

    fetchWithRetryMock.mockResolvedValueOnce(null).mockResolvedValueOnce(httpFailure(500));
    await expect(
      fetchEvmUint256AtBlock("optimism", "0xToken", "0x18160ddd", "latest", {
        chainRpcs: failedTransportRun,
        maxRetries: 0,
      }),
    ).resolves.toBeNull();
    expect(attemptedUrls()).toEqual([dwellirUrl, publicUrl]);

    // The same run no longer retries the demoted origin...
    fetchWithRetryMock.mockClear();
    fetchWithRetryMock.mockResolvedValueOnce(httpFailure(500));
    await expect(
      fetchEvmUint256AtBlock("optimism", "0xToken", "0x18160ddd", "latest", {
        chainRpcs: failedTransportRun,
        maxRetries: 0,
      }),
    ).resolves.toBeNull();
    expect(attemptedUrls()).toEqual([publicUrl]);

    // ...while a fresh run keeps it.
    fetchWithRetryMock.mockClear();
    fetchWithRetryMock.mockResolvedValueOnce(httpFailure(500)).mockResolvedValueOnce(rpcResponse({ result: "0x64" }));
    await expect(
      fetchEvmUint256AtBlock("optimism", "0xToken", "0x18160ddd", "latest", {
        chainRpcs: healthyRun,
        maxRetries: 0,
      }),
    ).resolves.toBe(100n);
    expect(attemptedUrls()).toEqual([dwellirUrl, publicUrl]);

    // A thrown transport failure demotes the same way.
    fetchWithRetryMock.mockClear();
    fetchWithRetryMock.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(httpFailure(500));
    await expect(
      fetchEvmUint256AtBlock("optimism", "0xToken", "0x18160ddd", "latest", {
        chainRpcs: thrownTransportRun,
        maxRetries: 0,
      }),
    ).resolves.toBeNull();
    expect(attemptedUrls()).toEqual([dwellirUrl, publicUrl]);
  });

  it("reports a Dwellir 403 as a capability failure without retrying the url", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chainRpcs = chainRpcsWith("bsc", [
      registryEndpoint("https://bsc-public-a.example"),
      dwellirEndpoint("https://api-bsc-mainnet-full.n.dwellir.com"),
    ]);
    fetchWithRetryMock.mockImplementation(async (url: string) =>
      url === "https://api-bsc-mainnet-full.n.dwellir.com"
        ? new Response(JSON.stringify({ error: { message: "plan does not include this method" } }), { status: 403 })
        : httpFailure(500),
    );

    await expect(
      fetchEvmUint256AtBlock("bsc", "0xToken", "0x18160ddd", "latest", { chainRpcs, maxRetries: 1 }),
    ).resolves.toBeNull();

    expect(attemptedUrls()).toEqual(["https://api-bsc-mainnet-full.n.dwellir.com", "https://bsc-public-a.example"]);
    expect(fetchWithRetryMock.mock.calls[0]?.[2]).toBe(1);
    expect(fetchWithRetryMock.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ retryMode: "network-only" }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("provider-capability"));
    warnSpy.mockRestore();
  });

  it("preserves call order through sequential single-object requests on no-batch endpoints", async () => {
    const url = "https://single-rpc.example";
    const chainRpcs = chainRpcsWith("pharos", [{ ...registryEndpoint(url), noBatch: true }]);
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 1, result: "0x64" }))
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 2, result: "0x6" }));
    const calls = [
      { method: "eth_getCode", params: ["0xToken", { blockHash: "0xPinned", requireCanonical: true }] },
      { method: "eth_call", params: [{ to: "0xToken", data: "0x313ce567" }, { blockHash: "0xPinned", requireCanonical: true }] },
    ];
    const beforeRequest = vi.fn(() => true);

    await expect(fetchEvmRpcBatch("pharos", calls, { chainRpcs, beforeRequest, maxRetries: 0 }))
      .resolves.toEqual(["0x64", "0x6"]);
    expect(fetchWithRetryMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { jsonrpc: "2.0", id: 1, ...calls[0] },
      { jsonrpc: "2.0", id: 2, ...calls[1] },
    ]);
    expect(beforeRequest.mock.calls).toEqual([[url], [url]]);
  });

  it("preserves per-call errors in detailed no-batch results", async () => {
    const chainRpcs = chainRpcsWith("pharos", [{ ...registryEndpoint("https://single-rpc.example"), noBatch: true }]);
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 1, result: "0x64" }))
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 2, error: { code: 3, message: "execution reverted" } }));

    await expect(fetchEvmRpcBatchDetailed("pharos", [
      { method: "eth_blockNumber", params: [] }, { method: "eth_call", params: [] },
    ], { chainRpcs, maxRetries: 0 })).resolves.toEqual({
      results: ["0x64", undefined], errors: [{ index: 1, code: 3, message: "execution reverted" }],
    });
  });

  it.each([
    { jsonrpc: "2.0", id: 1, result: "duplicate" },
    { jsonrpc: "2.0", id: 3, result: "wrong" },
    [{ jsonrpc: "2.0", id: 2, result: "array" }],
  ])("rejects a mismatched single response without exposing a partial group: %j", async body => {
    const chainRpcs = chainRpcsWith("pharos", [{ ...registryEndpoint("https://single-rpc.example"), noBatch: true }]);
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 1, result: "first" }))
      .mockResolvedValueOnce(rpcResponse(body));
    await expect(fetchEvmRpcBatch("pharos", [
      { method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] },
    ], { chainRpcs, maxRetries: 0 })).resolves.toBeNull();
  });

  it("restarts the entire call group on fallback after a partial single-call transport failure", async () => {
    const first = "https://single-rpc.example", fallback = "https://batch-rpc.example";
    const chainRpcs = chainRpcsWith("pharos", [
      { ...registryEndpoint(first), noBatch: true }, registryEndpoint(fallback),
    ]);
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 1, result: "discarded" }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rpcResponse([
        { jsonrpc: "2.0", id: 2, result: "second" }, { jsonrpc: "2.0", id: 1, result: "first" },
      ]));
    await expect(fetchEvmRpcBatch("pharos", [
      { method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] },
    ], { chainRpcs, maxRetries: 0 })).resolves.toEqual(["first", "second"]);
    expect(attemptedUrls()).toEqual([first, first, fallback]);
    expect(Array.isArray(JSON.parse(fetchWithRetryMock.mock.calls[2]![1].body))).toBe(true);
  });

  it("checks the request guard before every single call and discards an incomplete group", async () => {
    const chainRpcs = chainRpcsWith("pharos", [{ ...registryEndpoint("https://single-rpc.example"), noBatch: true }]);
    const beforeRequest = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    fetchWithRetryMock.mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 1, result: "first" }));
    await expect(fetchEvmRpcBatch("pharos", [
      { method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] },
    ], { chainRpcs, beforeRequest, maxRetries: 0 })).resolves.toBeNull();
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it("bounds every single call by the absolute deadline and discards a timed-out group", async () => {
    let nowMs = 1000, id = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const chainRpcs = chainRpcsWith("pharos", [{ ...registryEndpoint("https://single-rpc.example"), noBatch: true }]);
    fetchWithRetryMock.mockImplementation(async () => {
      nowMs += 600;
      return rpcResponse({ jsonrpc: "2.0", id: ++id, result: "0x64" });
    });
    await expect(fetchEvmRpcBatch("pharos", [
      { method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] }, { method: "eth_gasPrice", params: [] },
    ], { chainRpcs, maxRetries: 0, deadlineMs: 2000, timeoutMs: 10_000 })).resolves.toBeNull();
    expect(fetchWithRetryMock.mock.calls.map(call => call[3])).toEqual([
      expect.objectContaining({ timeoutMs: 1000, retryMode: "network-only" }),
      expect.objectContaining({ timeoutMs: 400, retryMode: "network-only" }),
    ]);
  });

  it("meters each physical single call rather than charging for an unsent group", async () => {
    const endpoint = { ...dwellirEndpoint("https://api-pharos-mainnet.n.dwellir.com"), noBatch: true };
    const chainRpcs = chainRpcsWith("pharos", [endpoint]);
    fetchWithRetryMock
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 1, result: "first" }))
      .mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: 2, result: "second" }));
    await expect(fetchEvmRpcBatch("pharos", [
      { method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] },
    ], { chainRpcs, maxRetries: 0 })).resolves.toEqual(["first", "second"]);
    expect(recordDwellirCreditsMock.mock.calls).toEqual([[1], [1]]);
  });

  it.each([1000, 1001])("honors inclusive endpoint log spans at %i blocks without changing other providers", async span => {
    const limited = "https://limited-rpc.example", fallback = "https://unlimited-rpc.example";
    const chainRpcs = chainRpcsWith("pharos", [
      { ...registryEndpoint(limited), maxLogBlockSpan: 1000 }, registryEndpoint(fallback),
    ]);
    fetchWithRetryMock.mockResolvedValue(rpcResponse([{ jsonrpc: "2.0", id: 1, result: [] }]));
    await expect(fetchEvmRpcBatch("pharos", [{
      method: "eth_getLogs", params: [{ fromBlock: "0x64", toBlock: `0x${(100 + span - 1).toString(16)}` }],
    }], { chainRpcs, maxRetries: 0 })).resolves.toEqual([[]]);
    expect(attemptedUrls()).toEqual([span === 1000 ? limited : fallback]);
    expect(Array.isArray(JSON.parse(fetchWithRetryMock.mock.calls[0]![1].body))).toBe(true);
  });

  it("caps each batch attempt to the remaining deadline and stops when it is exhausted", async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    fetchWithRetryMock.mockImplementation(async () => {
      nowMs += 600;
      return null;
    });
    const batch = [{ method: "eth_blockNumber", params: [] }];

    await fetchEvmRpcBatch(undefined, batch, {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      timeoutMs: 10_000,
      deadlineMs: 2_000,
      maxRetries: 0,
    });
    expect(fetchWithRetryMock.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ timeoutMs: 1_000, retryMode: "network-only", deadlineMs: 2_000 }),
      expect.objectContaining({ timeoutMs: 400, retryMode: "network-only", deadlineMs: 2_000 }),
    ]);

    fetchWithRetryMock.mockClear();
    nowMs = 1_000;
    fetchWithRetryMock.mockImplementation(async () => {
      nowMs = 3_500;
      return null;
    });
    await fetchEvmRpcBatch(undefined, batch, {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      timeoutMs: 10_000,
      deadlineMs: 2_000,
      maxRetries: 0,
    });
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it("stops a batch at the request guard and passes each attempted url", async () => {
    fetchWithRetryMock.mockResolvedValue(null);
    const beforeRequest = vi.fn((url: string) => url === "https://rpc.primary");

    await fetchEvmRpcBatch(undefined, [{ method: "eth_blockNumber", params: [] }], {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      maxRetries: 0,
      beforeRequest,
    });

    expect(beforeRequest.mock.calls).toEqual([["https://rpc.primary"], ["https://rpc.fallback"]]);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });
});
