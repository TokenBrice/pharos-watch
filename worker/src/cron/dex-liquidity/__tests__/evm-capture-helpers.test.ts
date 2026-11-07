import { afterEach, describe, expect, it, vi } from "vitest";

import { DEX_MEASURED_FRESHNESS_MAX_SEC } from "@shared/types/measured-execution";
import type { ChainRpcConfig, RpcEndpoint } from "../../../lib/chain-registry";
import {
  MULTICALL3_ADDRESS,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmBlockHeader,
  type EvmMulticall3Result,
} from "../../../lib/evm-rpc";
import { encodeAggregate3Return } from "../../../test-helpers/__shared/evm-multicall.test-support";
import { runPinnedBlockCapture } from "../evm-capture-helpers";

const CHAIN = "bsc";
const DWELLIR_URL = "https://bsc-dwellir.example";
const ARCHIVE_URL = "https://bsc-archive.example";
const NOW_SEC = 1_700_000_000;
const FINALIZED: EvmBlockHeader = {
  number: 50_000_000,
  timestamp: NOW_SEC - 60,
  hash: `0x${"a".repeat(64)}` as `0x${string}`,
};
const LATEST: EvmBlockHeader = {
  number: 50_000_060,
  timestamp: NOW_SEC - 5,
  hash: `0x${"b".repeat(64)}` as `0x${string}`,
};
const CALLS = [{
  label: "pool-count",
  target: "0x1111111111111111111111111111111111111111",
  callData: "0x18160ddd",
}];

function dwellirEndpoint(
  stateHistory: RpcEndpoint["stateHistory"],
  overrides: Partial<RpcEndpoint> = {},
): RpcEndpoint {
  return {
    url: DWELLIR_URL,
    operator: "dwellir",
    keyed: true,
    position: "registry",
    stateHistory,
    logsHistory: "full",
    ...overrides,
  };
}

const ARCHIVE_ENDPOINT: RpcEndpoint = {
  url: ARCHIVE_URL,
  operator: "alchemy",
  keyed: true,
  position: "registry",
  stateHistory: "archive",
  logsHistory: "full",
};

function chainRpcsWith(endpoints: readonly RpcEndpoint[]): Map<string, ChainRpcConfig> {
  return new Map([[CHAIN, {
    chainId: CHAIN,
    chainName: "BSC",
    type: "evm",
    explorerUrl: "https://explorer.example",
    endpoints,
  }]]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runPinnedBlockCapture recent-state Dwellir admission", () => {
  it("captures at the authenticated finalized head and admits the Dwellir pin at that block", async () => {
    const chainRpcs = chainRpcsWith([dwellirEndpoint("recent"), ARCHIVE_ENDPOINT]);
    const fetchBlockNumber = vi.fn(async () => LATEST.number);
    const fetchBlockHeader = vi.fn(async (_chain: string, blockNumberOrTag: number | "finalized", _options?: unknown) =>
      blockNumberOrTag === "finalized" ? FINALIZED : { ...FINALIZED, number: blockNumberOrTag });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: encodeAggregate3Return([{ success: true, returnData: "0x1234" }]),
      });
    });
    vi.stubGlobal("fetch", fetcher);

    let context: { blockNumber: number; header: EvmBlockHeader; pin?: EvmBlockHeader } | null = null;
    let results: EvmMulticall3Result[] | null = null;
    const onResults = vi.fn();
    const onFailure = vi.fn();
    await runPinnedBlockCapture({
      chain: CHAIN,
      rpcOptions: { chainRpcs },
      fetchBlockNumber,
      fetchBlockHeader,
      nowSec: NOW_SEC,
      maxAgeSec: DEX_MEASURED_FRESHNESS_MAX_SEC,
      verifyDeployment: async (capture) => {
        context = {
          blockNumber: capture.blockNumber,
          header: capture.header,
          pin: capture.rpcOptions.recentStatePin?.header,
        };
        return { ok: true };
      },
      buildCalls: async (capture) => {
        results = await fetchEvmMulticall3Aggregate3AtBlock(
          CHAIN,
          CALLS,
          capture.blockNumber,
          capture.rpcOptions,
        );
        return results ? { ok: true, value: results } : { ok: false };
      },
      onResults,
      onFailure,
    });

    expect(fetchBlockNumber).not.toHaveBeenCalled();
    expect(fetchBlockHeader.mock.calls.map(([, blockNumberOrTag]) => blockNumberOrTag))
      .toEqual(["finalized", FINALIZED.number]);
    // The closing header read carries the finalized head as the observed head.
    expect(fetchBlockHeader.mock.calls[1]?.[2]).toMatchObject({ observedHeadBlock: FINALIZED.number });
    expect(context).toMatchObject({ blockNumber: FINALIZED.number, header: FINALIZED, pin: FINALIZED });
    expect(onFailure).not.toHaveBeenCalled();
    expect(onResults).toHaveBeenCalledWith([{ label: "pool-count", success: true, returnData: "0x1234" }]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(DWELLIR_URL);
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as {
      method: string;
      params: Array<{ to: string } | string>;
    };
    expect(request.method).toBe("eth_call");
    expect(request.params[0]).toMatchObject({ to: MULTICALL3_ADDRESS });
    expect(request.params[1]).toBe(`0x${FINALIZED.number.toString(16)}`);
    expect(results).not.toBeNull();
  });

  it.each([
    { label: "unavailable", finalized: null },
    { label: "stale", finalized: "stale" },
    { label: "future-dated", finalized: "future" },
    { label: "lagging the head like zkSync", finalized: "lagging" },
  ] as const)("falls back to the latest head without a pin when finalized is $label", async ({ finalized }) => {
    const nowSec = finalized === "future" ? Math.floor(Date.now() / 1000) : NOW_SEC;
    const finalizedHeader: EvmBlockHeader | null = finalized === "future"
      ? { ...FINALIZED, timestamp: nowSec + 30 }
      : finalized === "stale"
        ? { ...FINALIZED, timestamp: nowSec - DEX_MEASURED_FRESHNESS_MAX_SEC - 1 }
        : finalized === "lagging"
          ? { ...FINALIZED, timestamp: nowSec - 301 }
          : null;
    const latestHeader = { ...LATEST, timestamp: nowSec - 5 };
    const fetchBlockNumber = vi.fn(async () => latestHeader.number);
    const fetchBlockHeader = vi.fn(async (_chain: string, blockNumberOrTag: number | "finalized") =>
      blockNumberOrTag === "finalized" ? finalizedHeader : latestHeader);

    let pin: unknown = null;
    let blockNumber: number | null = null;
    const onResults = vi.fn();
    const onFailure = vi.fn();
    await runPinnedBlockCapture({
      chain: CHAIN,
      rpcOptions: { chainRpcs: chainRpcsWith([dwellirEndpoint("recent"), ARCHIVE_ENDPOINT]) },
      fetchBlockNumber,
      fetchBlockHeader,
      nowSec,
      maxAgeSec: DEX_MEASURED_FRESHNESS_MAX_SEC,
      verifyDeployment: async (capture) => {
        pin = capture.rpcOptions.recentStatePin;
        blockNumber = capture.blockNumber;
        return { ok: true };
      },
      buildCalls: async () => ({ ok: true, value: null }),
      onResults,
      onFailure,
    });

    expect(fetchBlockNumber).toHaveBeenCalledOnce();
    expect(fetchBlockHeader.mock.calls.map(([, blockNumberOrTag]) => blockNumberOrTag))
      .toEqual(["finalized", latestHeader.number, latestHeader.number]);
    expect(pin).toBeUndefined();
    expect(blockNumber).toBe(latestHeader.number);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onResults).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "no deadline and a short family freshness window", deadlineMs: undefined, maxAgeSec: 600 },
    { label: "an unbounded deadline", deadlineMs: Number.POSITIVE_INFINITY, maxAgeSec: 600 },
  ])("keeps the finalized pin valid for the measured-freshness window with $label", async ({ deadlineMs, maxAgeSec }) => {
    const fetchBlockHeader = vi.fn(async (_chain: string, blockNumberOrTag: number | "finalized") =>
      blockNumberOrTag === "finalized" ? FINALIZED : { ...FINALIZED, number: blockNumberOrTag });
    let pin: { maxAgeSec: number; observedAtSec: number; header: EvmBlockHeader } | undefined;
    await runPinnedBlockCapture({
      chain: CHAIN,
      rpcOptions: { chainRpcs: chainRpcsWith([dwellirEndpoint("recent"), ARCHIVE_ENDPOINT]), deadlineMs },
      fetchBlockNumber: vi.fn(async () => LATEST.number),
      fetchBlockHeader,
      nowSec: NOW_SEC,
      maxAgeSec,
      verifyDeployment: async (capture) => {
        pin = capture.rpcOptions.recentStatePin;
        return { ok: true };
      },
      buildCalls: async () => ({ ok: true, value: null }),
      onResults: vi.fn(),
      onFailure: vi.fn(),
    });

    expect(pin).toBeDefined();
    expect(Number.isSafeInteger(pin!.maxAgeSec)).toBe(true);
    expect(pin!.maxAgeSec - (pin!.observedAtSec - pin!.header.timestamp)).toBeGreaterThanOrEqual(DEX_MEASURED_FRESHNESS_MAX_SEC);
  });

  it("keeps the latest-head capture when the caller excludes Dwellir", async () => {
    const fetchBlockHeader = vi.fn(async (_chain: string, _blockNumberOrTag: number | "finalized") => LATEST);
    let pin: unknown = null;
    await runPinnedBlockCapture({
      chain: CHAIN,
      rpcOptions: { chainRpcs: chainRpcsWith([dwellirEndpoint("recent"), ARCHIVE_ENDPOINT]), excludeSupplementalRpc: true },
      fetchBlockNumber: vi.fn(async () => LATEST.number),
      fetchBlockHeader,
      nowSec: NOW_SEC,
      maxAgeSec: DEX_MEASURED_FRESHNESS_MAX_SEC,
      verifyDeployment: async (capture) => {
        pin = capture.rpcOptions.recentStatePin;
        return { ok: true };
      },
      buildCalls: async () => ({ ok: true, value: null }),
      onResults: vi.fn(),
      onFailure: vi.fn(),
    });

    expect(fetchBlockHeader.mock.calls.map(([, blockNumberOrTag]) => blockNumberOrTag)).toEqual([LATEST.number, LATEST.number]);
    expect(pin).toBeUndefined();
  });

  it.each([
    { label: "an archive Dwellir route", endpoints: [dwellirEndpoint("archive"), ARCHIVE_ENDPOINT] },
    { label: "a routing-disabled recent Dwellir route", endpoints: [dwellirEndpoint("recent", { routingDisabled: true }), ARCHIVE_ENDPOINT] },
    { label: "a finalized-tag-unsupported recent Dwellir route", endpoints: [dwellirEndpoint("recent", { finalizedTagUnsupported: true }), ARCHIVE_ENDPOINT] },
    { label: "no Dwellir route", endpoints: [ARCHIVE_ENDPOINT] },
  ])("keeps the latest-head capture without a finalized read for $label", async ({ endpoints }) => {
    const fetchBlockNumber = vi.fn(async () => LATEST.number);
    const fetchBlockHeader = vi.fn(async (_chain: string, _blockNumberOrTag: number | "finalized") => LATEST);
    let pin: unknown = null;
    const onResults = vi.fn();
    await runPinnedBlockCapture({
      chain: CHAIN,
      rpcOptions: { chainRpcs: chainRpcsWith(endpoints) },
      fetchBlockNumber,
      fetchBlockHeader,
      nowSec: NOW_SEC,
      maxAgeSec: DEX_MEASURED_FRESHNESS_MAX_SEC,
      verifyDeployment: async (capture) => {
        pin = capture.rpcOptions.recentStatePin;
        return { ok: true };
      },
      buildCalls: async () => ({ ok: true, value: null }),
      onResults,
      onFailure: vi.fn(),
    });

    expect(fetchBlockNumber).toHaveBeenCalledOnce();
    expect(fetchBlockHeader.mock.calls.map(([, blockNumberOrTag]) => blockNumberOrTag))
      .toEqual([LATEST.number, LATEST.number]);
    expect(pin).toBeUndefined();
    expect(onResults).toHaveBeenCalledOnce();
  });
});
