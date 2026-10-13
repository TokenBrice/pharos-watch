import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { jsonResponse, mockFetch, type MockFetchSpy } from "@shared/test-utils/mock-fetch";
import { buildAlchemyUrl } from "../../lib/alchemy-logs";
import { mintBurnRpcEndpoints } from "../../lib/mint-burn-pipeline/rpc";
import { fetchEvmTokenBalance } from "../../lib/blacklist/balance-providers";
import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { createBlacklistRunBudget } from "../../lib/blacklist/run-budget";
import {
  buildChainRpcs,
  getChainRpc,
  registryRpcEndpoints,
  logScanRpcEndpoints,
  supplementalRpcEndpoints,
  type ChainRpcConfig,
} from "../../lib/chain-registry";
import { createBudget } from "../../lib/evm-logs";
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import { fetchConservationBoundaries } from "../../lib/mint-burn-conservation";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { fetchEvmEventsIncremental, RPC_LOG_SCAN_WINDOWS } from "../blacklist/evm-source";
import { ethereumConfig } from "../blacklist/__tests__/balance.test-support";

/**
 * Non-allowlisted BSC logs and Ethereum mint/burn never read Dwellir.
 *
 * Every case below runs the real transports against a recorded fetch while a
 * Dwellir-enabled registry is present, so an excluded-operator leak is
 * observed as a `*.n.dwellir.com` request instead of a mocked-away one.
 * The last case is the control: it proves the recorder does see a Dwellir
 * request, and that `excludeSupplementalRpc` is what stops it.
 */

const DWELLIR_API_KEY = "dwellir-test"; // fixture value; never the real key
const DWELLIR_HOST_SUFFIX = ".n.dwellir.com";
const BSC_FROM_BLOCK = 1_000;
const BSC_CHAIN_HEAD = 900_000;
const BSC_CHAIN_HEAD_QUANTITY = "0x" + BSC_CHAIN_HEAD.toString(16);
const BALANCE_CALL = "0x" + "33".repeat(4);

type RpcCall = { id: number; method: string; params: unknown[] };
type RpcAnswer = { result?: unknown; error?: { code: number; message: string } };

/** Replays a JSON-RPC request (single or batch) in the shape the caller sent. */
function rpcRespond(answerFor: (method: string, params: unknown[], url: string) => RpcAnswer) {
  return async (request: Request): Promise<Response> => {
    const parsed = JSON.parse(await request.text()) as RpcCall | RpcCall[];
    const single = !Array.isArray(parsed);
    const calls = single ? [parsed] : parsed;
    const rows = calls.map(({ id, method, params }) => ({
      jsonrpc: "2.0",
      id,
      ...answerFor(method, params, request.url),
    }));
    return jsonResponse(single ? rows[0] : rows);
  };
}

function hostsOf(fetchMock: MockFetchSpy): string[] {
  return fetchMock.getHistory().map(({ url }) => new URL(url).host);
}

function registryHosts(config: ChainRpcConfig): string[] {
  return registryRpcEndpoints(config).map((endpoint) => new URL(endpoint.url).host);
}

function word(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

function scanWindowOf(entry: { body: string | null }): number {
  const [{ toBlock }] = (JSON.parse(entry.body!) as { params: Array<{ toBlock: string }> }).params;
  return parseInt(toBlock, 16);
}

function bscBlacklistConfig(): ContractEventConfig {
  return {
    configKey: "bsc-0x" + "44".repeat(20),
    chain: {
      chainId: "bsc",
      chainName: "BSC",
      evmChainId: 56,
      explorerUrl: "https://bscscan.com",
      type: "evm",
    },
    stablecoinId: "usdc-circle",
    stablecoin: "USDC",
    contractAddress: "0x" + "44".repeat(20),
    decimals: 6,
    events: [
      {
        signature: "Blacklisted(address)",
        topicHash: "0x" + "55".repeat(32),
        eventType: "blacklist",
        hasAmount: false,
      },
    ],
  };
}

const limiter = async <T>(fn: () => Promise<T>) => fn();

function makeRunBudget() {
  return createBlacklistRunBudget({
    subrequestLimit: 900,
    runtimeBudgetMs: 600_000,
    minimumConfigWindowMs: 60_000,
  });
}

describe("blacklist log scan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scans the Alchemy registry endpoint with the alchemy window and never requests Dwellir", async () => {
    const chainRpcs = buildChainRpcs("alchemy-test", "drpc-test", { dwellirApiKey: DWELLIR_API_KEY });
    const bsc = getChainRpc(chainRpcs, "bsc")!;
    expect(bsc.endpoints.filter((endpoint) => endpoint.operator === "dwellir").map((endpoint) => endpoint.url)).toEqual([
      expect.stringContaining(DWELLIR_HOST_SUFFIX),
    ]);

    const fetchMock = mockFetch([{
      match: () => true,
      respond: rpcRespond((method) => ({ result: method === "eth_getLogs" ? [] : BSC_CHAIN_HEAD_QUANTITY })),
    }], { requireMatch: true });

    const result = await fetchEvmEventsIncremental(
      mockD1(),
      bscBlacklistConfig(),
      null,
      BSC_FROM_BLOCK,
      new Map(),
      makeRunBudget(),
      limiter,
      undefined,
      chainRpcs,
    );

    expect(result.usedRpcLogs).toBe(true);
    const logScans = fetchMock.getHistory().filter(({ body }) => body?.includes("eth_getLogs"));
    expect(logScans).toHaveLength(1);
    expect([...new Set(hostsOf(fetchMock))]).toEqual([registryHosts(bsc)[0]!]);
    expect(scanWindowOf(logScans[0]!)).toBe(BSC_FROM_BLOCK + RPC_LOG_SCAN_WINDOWS.bsc!.alchemy - 1);
  });

  it("keeps the fallback window for a public primary and never requests Dwellir", async () => {
    const chainRpcs = buildChainRpcs(undefined, "drpc-test", { dwellirApiKey: DWELLIR_API_KEY });
    const bsc = getChainRpc(chainRpcs, "bsc")!;
    expect(supplementalRpcEndpoints(bsc)).toHaveLength(1);

    const fetchMock = mockFetch([{
      match: () => true,
      respond: rpcRespond((method) => ({ result: method === "eth_getLogs" ? [] : BSC_CHAIN_HEAD_QUANTITY })),
    }], { requireMatch: true });

    const result = await fetchEvmEventsIncremental(
      mockD1(),
      bscBlacklistConfig(),
      null,
      BSC_FROM_BLOCK,
      new Map(),
      makeRunBudget(),
      limiter,
      undefined,
      chainRpcs,
    );

    expect(result.usedRpcLogs).toBe(true);
    const logScans = fetchMock.getHistory().filter(({ body }) => body?.includes("eth_getLogs"));
    expect(logScans).toHaveLength(1);
    expect(scanWindowOf(logScans[0]!)).toBe(BSC_FROM_BLOCK + RPC_LOG_SCAN_WINDOWS.bsc!.fallback - 1);
    expect([...new Set(hostsOf(fetchMock))]).toEqual([registryHosts(bsc)[0]!]);
  });

  it("stops at allowed log endpoints instead of falling through to unallowlisted Dwellir", async () => {
    const chainRpcs = buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: DWELLIR_API_KEY });
    const bsc = getChainRpc(chainRpcs, "bsc")!;
    const [alchemyHost, fallbackHost] = logScanRpcEndpoints(bsc).map((endpoint) => new URL(endpoint.url).host);
    const dwellirHost = new URL(bsc.endpoints.find((endpoint) => endpoint.operator === "dwellir")!.url).host;
    expect(dwellirHost).toContain(DWELLIR_HOST_SUFFIX);

    // Only Dwellir can answer, so a lane that offered every endpoint as a
    // candidate would resolve its log target there.
    const fetchMock = mockFetch([{
      match: () => true,
      respond: rpcRespond((_method, _params, url) =>
        new URL(url).host === dwellirHost
          ? { result: BSC_CHAIN_HEAD_QUANTITY }
          : { error: { code: -32000, message: "head unavailable" } }),
    }], { requireMatch: true });

    const result = await fetchEvmEventsIncremental(
      mockD1(),
      bscBlacklistConfig(),
      null,
      BSC_FROM_BLOCK,
      new Map(),
      makeRunBudget(),
      limiter,
      undefined,
      chainRpcs,
    );

    expect(result.usedRpcLogs).toBe(false);
    expect(result.coverageOutcome).toBe("provider_error");
    expect(hostsOf(fetchMock)).toEqual([alchemyHost, fallbackHost]);
  });
});

describe("blacklist balance reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the registry chain RPC and never requests Dwellir", async () => {
    const chainRpcs = buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: DWELLIR_API_KEY });
    const ethereum = getChainRpc(chainRpcs, "ethereum")!;
    expect(supplementalRpcEndpoints(ethereum).map((endpoint) => endpoint.url)).toEqual([
      expect.stringContaining(DWELLIR_HOST_SUFFIX),
    ]);

    const fetchMock = mockFetch([{
      match: () => true,
      respond: rpcRespond(() => ({ result: word(50_000_000n) })),
    }], { requireMatch: true });

    const amount = await fetchEvmTokenBalance(
      ethereumConfig,
      "0x" + "aa".repeat(20),
      19_000_000,
      null,
      null,
      limiter,
      createBudget(10),
      undefined,
      chainRpcs,
    );

    expect(amount).toBe(50);
    expect(hostsOf(fetchMock)).toEqual([registryHosts(ethereum)[0]!]);
  });

  it("skips a supplemental-only chain config without opening any request", async () => {
    const chainRpcs = buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: DWELLIR_API_KEY });
    const dwellirUrls = supplementalRpcEndpoints(getChainRpc(chainRpcs, "ethereum")!);
    expect(dwellirUrls).toHaveLength(1);
    const supplementalOnly = new Map<string, ChainRpcConfig>([["ethereum", {
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      endpoints: dwellirUrls,
      explorerUrl: "https://etherscan.io",
    }]]);

    const fetchMock = mockFetch([], { requireMatch: true });

    const amount = await fetchEvmTokenBalance(
      ethereumConfig,
      "0x" + "aa".repeat(20),
      19_000_000,
      null,
      null,
      limiter,
      createBudget(10),
      undefined,
      supplementalOnly,
    );

    expect(amount).toBeNull();
    expect(fetchMock.getHistory()).toEqual([]);
  });
});

describe("mint/burn conservation boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("batch-reads the lane's Alchemy URL and never requests Dwellir", async () => {
    const chainRpcs = buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: DWELLIR_API_KEY });
    expect(supplementalRpcEndpoints(getChainRpc(chainRpcs, "ethereum")!).map((endpoint) => endpoint.url)).toEqual([
      expect.stringContaining(DWELLIR_HOST_SUFFIX),
    ]);
    // The mint/burn lane resolves its own Alchemy URL (cron/mint-burn/chain-context.ts).
    const alchemyUrl = buildAlchemyUrl("ethereum", "alchemy-test")!;
    const alchemyHost = new URL(alchemyUrl).host;

    const fetchMock = mockFetch([{
      match: alchemyHost,
      respond: rpcRespond((method, params) => {
        if (method !== "eth_getBlockByNumber") return { result: word(100n) };
        const block = params[0];
        return block === "0x64"
          ? { result: { number: "0x64", timestamp: "0x3e8", hash: word(10n) } }
          : { result: { number: "0x66", timestamp: "0x400", hash: word(12n) } };
      }),
    }], { requireMatch: true });

    const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!;
    const evidence = await fetchConservationBoundaries({
      requests: [{ key: "gusd", config, fromBlock: 101, toBlock: 102 }],
      rpcEndpointsByChain: new Map([["ethereum", mintBurnRpcEndpoints("ethereum", "alchemy-test", chainRpcs)]]),
      budget: createBudget(100),
      checkedAt: 1_100,
    });

    expect(evidence.get("gusd")).toMatchObject({ status: "ready" });
    expect([...new Set(hostsOf(fetchMock))]).toEqual([alchemyHost]);
  });
});

describe("supplemental endpoint exclusion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["ethereum", "base"])("reaches %s Dwellir only without lane exclusion at either endpoint position", async (chainId) => {
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: DWELLIR_API_KEY });
    const config = getChainRpc(chainRpcs, chainId)!;
    const incumbents = config.endpoints.filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url);
    const dwellirUrl = config.endpoints.find((endpoint) => endpoint.operator === "dwellir")!.url;

    const dwellirHost = new URL(dwellirUrl).host;
    const answer = (_method: string, _params: unknown[], url: string): RpcAnswer =>
      new URL(url).host === dwellirHost ? { result: word(7n) } : { error: { code: -32000, message: "unavailable" } };
    const to = "0x" + "66".repeat(20);

    const openFetch = mockFetch([{ match: () => true, respond: rpcRespond(answer) }], { requireMatch: true });
    const leaked = await fetchEvmCallHexAtBlock(chainId, to, BALANCE_CALL, "latest", { chainRpcs });
    expect(leaked).toBe(word(7n));
    expect(hostsOf(openFetch)).toEqual((chainId === "base" ? [dwellirUrl] : [...incumbents, dwellirUrl]).map((url) => new URL(url).host));

    const closedFetch = mockFetch([{ match: () => true, respond: rpcRespond(answer) }], { requireMatch: true });
    const excluded = await fetchEvmCallHexAtBlock(chainId, to, BALANCE_CALL, "latest", {
      chainRpcs,
      excludeSupplementalRpc: true,
    });
    expect(excluded).toBeNull();
    expect(hostsOf(closedFetch)).toEqual(incumbents.map((url) => new URL(url).host));
  });
});
