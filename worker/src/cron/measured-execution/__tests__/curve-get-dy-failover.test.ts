import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";

const { recordDwellirCredits } = vi.hoisted(() => ({ recordDwellirCredits: vi.fn() }));
vi.mock("../../../lib/rpc-provider-budget", () => ({ recordDwellirCredits }));

import { buildChainRpcs } from "../../../lib/chain-registry";
import { executeCurveGetDyMulticall } from "../curve-stableswap-execution-pipeline";

const BLOCK_HASH = `0x${"ab".repeat(32)}` as const;
const POOL = "0x4444444444444444444444444444444444444444" as const;

function rpcResponse(body: { result?: string; error?: { code: number; message: string } }): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), { status: 200 });
}

function aggregateResponse(count: number): Response {
  return rpcResponse({ result: encodeAbiParameters(
    parseAbiParameters("(bool success,bytes returnData)[]"),
    [Array.from({ length: count }, () => ({ success: true, returnData: `0x${"00".repeat(31)}01` as const }))],
  ) });
}

function setup() {
  const chainRpcs = buildChainRpcs("alchemy-test-key", undefined, { dwellirApiKey: "dwellir-test-key" });
  const config = chainRpcs.get("ethereum")!;
  const primary = config.endpoints.find((endpoint) => endpoint.operator === "dwellir")!;
  const fallback = config.endpoints.find((endpoint) => endpoint.operator === "alchemy")!;
  config.endpoints = [primary, fallback].map((endpoint) => ({ ...endpoint, position: "registry" as const }));
  return {
    primary: primary.url,
    fallback: fallback.url,
    execute: (count: number) => executeCurveGetDyMulticall({
      chain: "ethereum",
      calls: Array.from({ length: count }, (_, index) => ({
        label: `get_dy-${index}`, target: POOL, callData: "0x5e0d443f", allowFailure: true,
      })),
      blockNumber: 21_000_000,
      blockHash: BLOCK_HASH,
      chainRpcs,
    }),
  };
}

describe("Curve get_dy execution-budget failover", () => {
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

  it.each([
    { code: -32000, message: "out of gas" },
    { code: -32003, message: "out of gas: gas required exceeds: 30000000" },
  ])("returns a multi-call OOG ($code) for splitting without replaying it on the next provider", async (error) => {
    const run = setup();
    fetchMock.mockImplementation(async () => rpcResponse({ error }));

    expect(await run.execute(8)).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary]);
  });

  it("keeps provider failover for a singleton OOG", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url) => url === run.primary
      ? rpcResponse({ error: { code: -32003, message: "out of gas: gas required exceeds: 30000000" } })
      : aggregateResponse(1));

    expect(await run.execute(1)).toEqual([{ label: "get_dy-0", success: true, returnData: `0x${"00".repeat(31)}01` }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
  });

  it("keeps provider failover for non-execution-budget errors", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url) => url === run.primary
      ? rpcResponse({ error: { code: -32000, message: "header not found" } })
      : aggregateResponse(2));

    expect(await run.execute(2)).toHaveLength(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
  });
});
