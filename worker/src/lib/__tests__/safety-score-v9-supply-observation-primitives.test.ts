import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  buildAlchemyRpcUrl,
  type ChainRpcConfig,
} from "../chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  MULTICALL3_ADDRESS,
  type EvmBlockHeader,
} from "../evm-rpc";
import {
  decodeEvmAddressHex,
  decodeEvmHexBytes,
  decodeEvmUint256,
  fetchReviewedDeploymentSolanaObservation,
  fetchSafetyScoreV9SolanaRpc,
  observeReviewedEvmDeployment,
  observeReviewedDeploymentUnitPartitionAttempt,
  findEvmBlockHeaderInTimestampWindow,
} from "../safety-score-v9/supply-observation-primitives";

const blockHash = `0x${"a".repeat(64)}` as const;
const dependencies = {
  sha256HexFromBytes, fetchEvmBlockNumber, fetchEvmBlockHeader,
  fetchEvmCodeAtBlock, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmStorageAtBlock,
};

function solanaConfig(url: string) {
  return new Map<string, ChainRpcConfig>([["solana", {
    chainId: "solana", chainName: "Solana", type: "other", explorerUrl: "https://solscan.io",
    endpoints: [{ url, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" }],
  }]]);
}


describe("supply observations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["jtrsy-anemoy", null, "deployment-identity-authored-withholding"],
    ["jtrsy-anemoy", undefined, "deployment-identity-unavailable"],
    ["missing", undefined, "route-inventory-unavailable"],
    ["jtrsy-anemoy", "evm", "deployment-identity-mismatch"],
  ] as const)("rejects %s with %s identity", async (assetId, runtime, rejectionCode) => {
    const observeEvm = vi.fn(async (route: { routeId: string; chainId: string; contractAddress: string }) => ({
      status: "accepted" as const, observation: { ...route, decimals: 6, rawSupply: "1",
        blockNumberOrSlot: "1", blockTimeSec: 1_793_781_842, blockHash },
    })), observeSolana = vi.fn();
    expect(await observeReviewedDeploymentUnitPartitionAttempt({
      assetId, aggregateSupplyUsd: 100, registryFingerprint: "a".repeat(64),
      scoringClockSec: 1_793_781_842, identityRuntime: () => runtime,
      observeEvm, observeSolana, identityValidationError: () => "identity mismatch",
    })).toMatchObject({ status: "rejected", rejectionCode });
    expect(observeEvm).toHaveBeenCalledTimes(runtime === "evm" ? 1 : 0);
    expect(observeSolana).not.toHaveBeenCalled();
  });

  it.each([
    ["first in-window header", 1800, 1920],
    ["refines an overshot window", 1930, 1940],
  ] as const)("%s", async (_title, earliestTimestamp, latestTimestamp) => {
    const initialHeader = { number: 1000, timestamp: 2000, hash: blockHash };
    const fetched: EvmBlockHeader[] = [];
    const fetchHeader = async (number: number) => {
      const header: EvmBlockHeader = { number, timestamp: 2000 - (1000 - number) * 12,
        hash: `0x${number.toString(16).padStart(64, "0")}` };
      fetched.push({ ...header });
      return header;
    };
    const result = await findEvmBlockHeaderInTimestampWindow({
      initialHeader, earliestTimestamp, latestTimestamp, fetchHeader,
    });
    expect(fetched.filter(h => Number.isSafeInteger(h.number) && h.number >= 0 && h.number < 1000 &&
      h.timestamp >= earliestTimestamp && h.timestamp <= latestTimestamp)).toContainEqual(result);
    if (earliestTimestamp === 1930) expect(result).toMatchObject({ number: 995, timestamp: 1940 });
  });

  it.each(["missing", "wrong number", "nonmonotonic", "empty window", "invalid refinement"] as const)(
    "fails closed on a %s window search", async failure => {
      const initialHeader = { number: 10, timestamp: 2000, hash: blockHash };
      const fetchHeader = vi.fn(async (number: number) => failure === "missing" ? null : ({
        ...initialHeader, number: failure === "wrong number" ? number + 1 : number,
        timestamp: failure === "nonmonotonic" ? 2001 : failure === "invalid refinement" && number === 4 ? 1799
          : number >= 5 ? 2000 : 1800,
      }));
      expect(await findEvmBlockHeaderInTimestampWindow({
        initialHeader, earliestTimestamp: 1850, latestTimestamp: 1970, fetchHeader,
      })).toBeNull();
      expect(fetchHeader.mock.calls.length).toBeLessThanOrEqual(8);
    },
  );

  it("reuses header and honors cancellation", async () => {
    const initialHeader = { number: 10, timestamp: 1900, hash: blockHash };
    const fetchHeader = vi.fn();
    const input = { initialHeader, earliestTimestamp: 1850, latestTimestamp: 1970, fetchHeader };
    expect(await findEvmBlockHeaderInTimestampWindow(input)).toBe(initialHeader);
    const controller = new AbortController();
    controller.abort();
    await expect(findEvmBlockHeaderInTimestampWindow({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(fetchHeader).not.toHaveBeenCalled();
  });

  it("decodes fail-closed", () => {
    expect(
      decodeEvmUint256({
        label: "supply",
        success: false,
        returnData: `0x${"2a".padStart(64, "0")}`,
      }),
    ).toBeNull();
    expect(
      decodeEvmAddressHex(`0x${"0".repeat(64)}`),
    ).toBeNull();
    expect(decodeEvmHexBytes("0x0")).toBeNull();
  });

  it.each([
    ["Solana failover", 1, false,
      ["https://api.mainnet-beta.solana.com", "https://api.mainnet.solana.com"]],
    ["Solana retry", 1, true,
      ["https://api.mainnet-beta.solana.com", "https://api.mainnet-beta.solana.com"]],
    ["Solana Pocket failover", 2, false,
      ["https://api.mainnet-beta.solana.com", "https://api.mainnet.solana.com", "https://solana.api.pocket.network"]],
  ] as const)("%s", async (_title, failures, retry, urls) => {
    // Drive backoff locally so shared-process RPC retries cannot enter this mock.
    vi.useFakeTimers();
    const fetchMock = mockFetch([{
      match: retry ? "api.mainnet-beta.solana.com" : () => true,
      outcomes: [
        ...Array.from({ length: failures }, () => retry ? new Error("network flake")
          : { body: { error: { code: -32000, message: "unavailable" } } }),
        { body: { result: { slot: 42 } } },
      ],
    }]);
    const pending = fetchSafetyScoreV9SolanaRpc<{ slot: number }>("getSlot", [{ commitment: "finalized" }]);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ slot: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(urls.length);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(urls);
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1]!.body as string),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getSlot",
      params: [{ commitment: "finalized" }],
    });
  });

  it("Solana RPC preserves auth", async () => {
    const configuredUrl = buildAlchemyRpcUrl("solana-mainnet", "test-key");
    const fetchMock = mockFetch([{
      match: configuredUrl,
      outcomes: [{ body: { result: { slot: 42 } } }],
    }]);

    await expect(
      fetchSafetyScoreV9SolanaRpc<{ slot: number }>(
        "getSlot",
        [{ commitment: "finalized" }],
        undefined,
        solanaConfig(configuredUrl),
      ),
    ).resolves.toEqual({ slot: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(configuredUrl);
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
  });

  it.each(["accounts", "block"])("rejects malformed Solana %s", async failure => {
    const configuredUrl = "https://solana.example";
    const results = failure === "accounts" ? [{}] : [
      { context: { slot: 42 }, value: [
        { owner: "program", data: { parsed: { info: { decimals: 6, supply: "1", mintAuthority: "authority" } } } },
        { owner: "controller-program", executable: false },
      ] }, [42], { blockTime: 1, blockhash: "invalid" },
    ];
    const fetchMock = mockFetch([{ match: configuredUrl, outcomes: results.map(result => ({ body: { result } })) }]);

    await expect(fetchReviewedDeploymentSolanaObservation({
      routeId: "solana:mint",
      contractAddress: "mint",
      identity: {
        programOwner: "program",
        mintAuthority: "authority",
        controllerAddress: "controller",
        controllerProgramOwner: "controller-program",
        controllerExecutable: false,
      },
      chainRpcs: solanaConfig(configuredUrl),
    })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(results.length);
    expect(fetchMock.mock.calls.every(([url]) => url === configuredUrl)).toBe(true);
  });

  it.each(["supplemental", "registry", "unadmitted"] as const)("rejects Dwellir-only %s", async position => {
    const dwellirOnly = new Map<string, ChainRpcConfig>([[
      "linea",
      {
        chainId: "linea",
        chainName: "Linea",
        type: "evm",
        endpoints: position === "unadmitted" ? [] : [{
          url: "https://api-linea-mainnet.n.dwellir.com",
          operator: "dwellir",
          keyed: true,
          position,
          stateHistory: "archive",
          logsHistory: "full",
          maxLogBlockSpan: 10_000,
          verifiedAt: "2026-10-13",
        }],
        explorerUrl: "https://lineascan.build",
      },
    ]]);
    const fetchMock = mockFetch([]);

    await expect(observeReviewedEvmDeployment({
      routeId: "linea:demo-token",
      chainId: "linea",
      contractAddress: "0x0000000000000000000000000000000000000001",
      scoringClockSec: 1_700_000_000,
      chainRpcs: dwellirOnly,
      dependencies,
      identity: () => ({ routeId: "linea:demo-token" }),
      safeBlockLag: () => 64,
      extraRpcUrls: () => undefined,
      protocolCalls: () => [],
      decodeProtocolObservation: () => ({ status: "accepted" as const, observation: {} }),
      identityValidationError: () => null,
    })).resolves.toEqual({
      status: "rejected",
      rejectionCode: "chain-rpc-unavailable",
      failedRouteId: "linea:demo-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("pinned EVM reads", () => {
    const contractAddress = "0x1111111111111111111111111111111111111111";
    const word = (value: number) => value.toString(16).padStart(64, "0");
    const supply = `0x${word(42)}`;
    const decimals = `0x${word(6)}`;
    const protocolSelector = "0x5c975abb";

    function fixture(input: {
      multicall: "present" | "absent" | "unavailable";
      required?: boolean;
      mismatch?: "number" | "hash";
      mismatchAt?: number;
      chainId?: "ethereum" | "pharos" | "tron";
      badDecimals?: boolean;
      missingCode?: boolean;
      safeBlockLag?: number;
      rejectHashPins?: boolean;
    }) {
      const chainId = input.chainId ?? "ethereum";
      const requests: Array<{ method: string; params: unknown[] }> = [];
      let headers = 0;
      // ABI aggregate3 response: supply, decimals, then an optional reverted read.
      const stateDecimals = input.badDecimals ? `0x${word(37)}` : decimals;
      const entries = [supply, stateDecimals, "0x"].map((data, index) =>
        `${word(index < 2 ? 1 : 0)}${word(64)}${word((data.length - 2) / 2)}${data.slice(2)}`);
      let offset = entries.length * 32;
      const offsets = entries.map((entry) => {
        const encoded = word(offset);
        offset += entry.length / 2;
        return encoded;
      });
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        // Requests are generated in-process by the RPC helpers under test.
        const request = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
        requests.push(request);
        let result: unknown;
        let error: unknown;
        if (request.method === "eth_blockNumber") result = chainId === "pharos" ? "0x1f" : "0x11";
        if (request.method === "eth_getBlockByNumber") {
          headers += 1;
          result = {
            number: headers >= (input.mismatchAt ?? 2) && input.mismatch === "number" ? "0xf" : "0x10",
            timestamp: "0x64",
            hash: headers >= (input.mismatchAt ?? 2) && input.mismatch === "hash" ? `0x${"b".repeat(64)}` : blockHash,
          };
        }
        if (request.method === "eth_getCode") {
          if (request.params[0] === MULTICALL3_ADDRESS) {
            if (input.multicall === "unavailable") error = { code: -32000, message: "unavailable" };
            else result = input.multicall === "absent" ? "0x" : "0x6000";
          } else result = input.missingCode && request.params[0] !== contractAddress ? "0x" : "0x6001";
        }
        if (request.method === "eth_getStorageAt") result = `0x${word(0)}`;
        if (request.method === "eth_call") {
          const call = request.params[0] as { to: string; data: string };
          if (call.to === MULTICALL3_ADDRESS) {
            result = `0x${word(32)}${word(entries.length)}${offsets.join("")}${entries.join("")}`;
          } else if (call.data === protocolSelector) {
            error = { code: 3, message: "execution reverted" };
          } else result = call.data === "0x18160ddd" ? supply : stateDecimals;
        }
        if (input.rejectHashPins && ["eth_call", "eth_getCode", "eth_getStorageAt"].includes(request.method) &&
            typeof request.params[request.params.length - 1] === "object") {
          error = { code: -32602, message: "hash selector unsupported" };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(error ? { error } : { result }) }));
      }));
      const observe = () => observeReviewedEvmDeployment({
        routeId: `${chainId}:${contractAddress}`,
        chainId,
        contractAddress,
        scoringClockSec: 100,
        chainRpcs: new Map<string, ChainRpcConfig>(),
        dependencies,
        identity: () => ({}),
        safeBlockLag: () => input.safeBlockLag ?? (chainId === "pharos" ? 15 : 1),
        extraRpcUrls: () => ["https://rpc.example"],
        protocolCalls: () => [{
          label: "optional-paused", target: contractAddress, callData: protocolSelector,
          allowFailure: !input.required,
        }],
        decodeProtocolObservation: ({ results }) => results[2]?.success === false
          ? { status: "accepted" as const, observation: {},
            ...(input.missingCode ? { implementationAddress: "0x2222222222222222222222222222222222222222" } : {}) }
          : { status: "rejected" as const, rejectionCode: "deployment-state-invalid" as const },
        identityValidationError: () => null,
      });
      return { requests, observe };
    }

    it("brackets Pharos state with matching headers", async () => {
      const pharos = fixture({ multicall: "present", chainId: "pharos", rejectHashPins: true });
      expect(await pharos.observe()).toMatchObject({
        status: "accepted", observation: { rawSupply: "42", blockNumberOrSlot: "16", blockHash },
      });
      const methods = pharos.requests.map(request => request.method);
      const state = pharos.requests.filter(request => ["eth_call", "eth_getCode", "eth_getStorageAt"].includes(request.method));
      expect(new Set(state.map(request => request.method))).toEqual(new Set(["eth_call", "eth_getCode", "eth_getStorageAt"]));
      expect(state.every(request => request.params[request.params.length - 1] === "0x10")).toBe(true);
      const headers = methods.flatMap((method, index) => method === "eth_getBlockByNumber" ? [index] : []);
      expect(headers).toHaveLength(3);
      expect(pharos.requests.slice(headers[1]! + 1, headers[2])).toEqual(state);
      expect(methods[methods.length - 1]).toBe("eth_getBlockByNumber");
    });

    it("rejects unsupported EIP-1898 on other chains", async () => {
      const ethereum = fixture({ multicall: "present", rejectHashPins: true });
      expect(await ethereum.observe()).toMatchObject({
        status: "rejected", rejectionCode: "deployment-state-unavailable",
      });
      const state = ethereum.requests.filter(request => ["eth_call", "eth_getCode", "eth_getStorageAt"].includes(request.method));
      expect(state.length).toBeGreaterThan(0);
      expect(state.every(request => JSON.stringify(request.params[request.params.length - 1]) ===
        JSON.stringify({ blockHash, requireCanonical: true }))).toBe(true);
    });

    it("direct reads preserve optional failures", async () => {
      const multicall = fixture({ multicall: "present" });
      const expected = await multicall.observe();
      expect(expected).toMatchObject({
        status: "accepted", observation: { rawSupply: "42", decimals: 6, blockHash },
      });
      const direct = fixture({ multicall: "absent" });
      expect(await direct.observe()).toEqual(expected);
    });

    it.each([
      ["required call", { required: true }],
      ["changed number", { mismatch: "number" }],
      ["changed hash", { mismatch: "hash" }],
      ["Tron", { chainId: "tron" }],
      ["unavailable Multicall3", { multicall: "unavailable" }],
      ["Pharos lag", { chainId: "pharos", safeBlockLag: 14 }, "deployment-pin-lag-violation"],
      ["Pharos pre-hash", { chainId: "pharos", mismatch: "hash", mismatchAt: 2 }, "deployment-pin-header-mismatch"],
      ["Pharos post-hash", { chainId: "pharos", mismatch: "hash", mismatchAt: 3 }, "deployment-pin-header-mismatch"],
      ["unsafe lag", { safeBlockLag: 0 }, "safe-block-unavailable"],
      ["invalid decimals", { badDecimals: true }, "deployment-state-invalid"],
      ["missing implementation", { missingCode: true }],
    ] as const)("rejects %s", async (_title, options, code = undefined) => {
      const direct = fixture({ multicall: "mismatchAt" in options ? "present" : "absent", ...options });
      expect(await direct.observe()).toEqual({
        status: "rejected", rejectionCode: code ?? "deployment-state-unavailable",
        failedRouteId: `${"chainId" in options ? options.chainId : "ethereum"}:${contractAddress}`,
      });
      if ("chainId" in options && options.chainId === "tron") expect(direct.requests).toEqual([]);
      if ("mismatchAt" in options) expect(direct.requests.some(request => request.method === "eth_call")).toBe(options.mismatchAt === 3);
      if ("multicall" in options) expect(direct.requests.some(request => request.method === "eth_call")).toBe(false);
      if ("safeBlockLag" in options) expect(direct.requests.map(request => request.method)).toEqual(["eth_blockNumber"]);
    });

    it("uses deployed Multicall3", async () => {
      const multicall = fixture({ multicall: "present" });
      expect(await multicall.observe()).toMatchObject({ status: "accepted", observation: { rawSupply: "42" } });
      const calls = multicall.requests.filter((request) => request.method === "eth_call");
      expect(calls.map((request) => {
        const call = request.params[0];
        return call && typeof call === "object" && "to" in call ? call.to : null;
      })).toEqual([MULTICALL3_ADDRESS]);
    });
  });
});
