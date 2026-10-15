import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } from "viem/utils";

const { recordDwellirCredits } = vi.hoisted(() => ({ recordDwellirCredits: vi.fn() }));
vi.mock("../../../lib/rpc-provider-budget", () => ({ recordDwellirCredits }));

import { buildChainRpcs } from "../../../lib/chain-registry";
import { fetchEvmCallHexAtBlock, fetchEvmMulticall3Aggregate3AtBlock } from "../../../lib/evm-rpc";
import { quoteQuoterV2Requests } from "../quoter-v2";
import { createDexMeasuredExecutionRpcBudget } from "../profiles";
import { makeV3Target } from "./measured-execution.test-support";

const AGGREGATE_ABI = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
const QUOTE_RESULT = encodeAbiParameters(
  parseAbiParameters("uint256,uint160,uint32,uint256"),
  [999_000_000n, 1n, 0, 100_000n],
);
const OOG = { code: -32000, message: "out of gas" };
const ENDPOINT = "0x3333333333333333333333333333333333333333" as const;
const BLOCK = 95_558_729;

function rpcResponse(body: { result?: string; error?: { code: number; message: string } }): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), { status: 200 });
}

function aggregateResponse(count: number, failedIndex = -1): Response {
  return rpcResponse({ result: encodeAbiParameters(
    parseAbiParameters("(bool success,bytes returnData)[]"),
    [Array.from({ length: count }, (_, index) => ({
      success: index !== failedIndex,
      returnData: index === failedIndex ? "0x" as const : QUOTE_RESULT,
    }))],
  ) });
}

function aggregateSize(init: RequestInit): number {
  const request = JSON.parse(String(init.body));
  expect(request.method).toBe("eth_call");
  expect(request.params[0].gas).toBe("0x1c9c380");
  expect(request.params[1]).toBe(`0x${BLOCK.toString(16)}`);
  const decoded = decodeFunctionData({ abi: AGGREGATE_ABI, data: request.params[0].data });
  return decoded.args[0].length;
}

function setup() {
  const chainRpcs = buildChainRpcs("alchemy-test-key", undefined, { dwellirApiKey: "dwellir-test-key" });
  const config = chainRpcs.get("polygon")!;
  const primary = config.endpoints.find((endpoint) => endpoint.operator === "dwellir")!;
  const fallback = config.endpoints.find((endpoint) => endpoint.operator === "alchemy")!;
  config.endpoints = [primary, fallback].map((endpoint) => ({ ...endpoint, position: "registry" as const }));
  const budget = createDexMeasuredExecutionRpcBudget({ maxRequests: 100, deadlineMs: Date.now() + 60_000 });
  const target = makeV3Target({ chain: "polygon" });
  return {
    primary: primary.url,
    fallback: fallback.url,
    chainRpcs,
    budget,
    quote: (count: number) => quoteQuoterV2Requests({
      requests: Array.from({ length: count }, () => ({ target, inputUsd: 1_000, endpointAddress: ENDPOINT })),
      blockNumber: BLOCK,
      chainRpcs,
      rpcBudget: budget,
    }),
  };
}

describe("Quoter V2 execution-budget failover", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    recordDwellirCredits.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("splits first-provider OOG immediately with unchanged quote results and exact metering", async () => {
    const baseline = setup();
    fetchMock.mockImplementation(async (_url, init) => aggregateResponse(aggregateSize(init!)));
    const expected = await baseline.quote(8);
    fetchMock.mockClear();
    recordDwellirCredits.mockClear();

    const run = setup();
    const sizes: number[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      const size = aggregateSize(init!);
      sizes.push(size);
      return size > 2 ? rpcResponse({ error: OOG }) : aggregateResponse(size);
    });

    expect(await run.quote(8)).toEqual(expected);
    expect(sizes).toEqual([8, 4, 2, 2, 4, 2, 2]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(7).fill(run.primary));
    expect(run.budget.requestsUsed).toBe(7);
    expect(run.budget.openChains).toEqual([]);
    expect(recordDwellirCredits.mock.calls).toEqual(Array.from({ length: 7 }, () => [1]));
  });

  it.each([
    { code: -32000, message: "header not found" },
    { code: -32005, message: "out of gas" },
    { code: 3, message: "execution reverted" },
  ])("preserves aggregate failover for RPC error $code: $message", async (error) => {
    const run = setup();
    fetchMock.mockImplementation(async (url, init) =>
      url === run.primary ? rpcResponse({ error }) : aggregateResponse(aggregateSize(init!)),
    );

    const outcomes = await run.quote(2);
    expect(outcomes.every((outcome) => outcome.point?.amountOutRaw === "999000000")).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
    expect(run.budget.requestsUsed).toBe(2);
    expect(recordDwellirCredits.mock.calls).toEqual([[1]]);
  });

  it("preserves OOG provider failover for singleton quotes", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url, init) =>
      url === run.primary ? rpcResponse({ error: OOG }) : aggregateResponse(aggregateSize(init!)),
    );

    expect((await run.quote(1))[0]?.point?.amountOutRaw).toBe("999000000");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
    expect(run.budget.requestsUsed).toBe(2);
    expect(recordDwellirCredits.mock.calls).toEqual([[1]]);
  });

  it("retains inner singleton recovery and irrecoverable zero-output semantics", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url, init) => {
      const size = aggregateSize(init!);
      if (size === 2) return aggregateResponse(size, 1);
      return url === run.primary ? rpcResponse({ error: OOG }) : aggregateResponse(1, 0);
    });

    const outcomes = await run.quote(2);
    expect(outcomes[0]?.point?.amountOutRaw).toBe("999000000");
    expect(outcomes[1]?.point).toMatchObject({
      amountOutRaw: "0", outputUsd: 0, reverted: true, adapterMetadata: { executionReverted: true },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.primary, run.fallback]);
    expect(run.budget.requestsUsed).toBe(3);
    expect(recordDwellirCredits.mock.calls).toEqual([[1], [1]]);
  });

  it("keeps OOG failover for non-quote aggregates and ordinary eth_call callers", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url) =>
      url === run.primary ? rpcResponse({ error: OOG }) : aggregateResponse(2),
    );
    const results = await fetchEvmMulticall3Aggregate3AtBlock("polygon", [
      { label: "a", target: ENDPOINT, callData: "0x1234" },
      { label: "b", target: ENDPOINT, callData: "0x5678" },
    ], BLOCK, { chainRpcs: run.chainRpcs, maxRetries: 0 });
    expect(results?.map((result) => result.success)).toEqual([true, true]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);

    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url) =>
      url === run.primary ? rpcResponse({ error: OOG }) : rpcResponse({ result: "0x1234" }),
    );
    expect(await fetchEvmCallHexAtBlock("polygon", ENDPOINT, "0x1234", BLOCK, {
      chainRpcs: run.chainRpcs, maxRetries: 0,
    })).toBe("0x1234");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
    expect(recordDwellirCredits.mock.calls).toEqual([[1], [1]]);
  });
});
