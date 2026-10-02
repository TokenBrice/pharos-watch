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
} from "../evm-rpc";
import {
  decodeEvmAddress,
  decodeEvmAddressHex,
  decodeEvmHexBytes,
  decodeEvmUint256,
  fetchReviewedDeploymentSolanaObservation,
  fetchSafetyScoreV9SolanaRpc,
  observeReviewedEvmDeployment,
} from "../safety-score-v9/supply-observation-primitives";



describe("Safety Score V9 supply observation primitives", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes EVM supply and identity words", () => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      const addressWord =
        `0x${address.slice(2).padStart(64, "0")}` as `0x${string}`;
      const uintWord = `0x${"2a".padStart(64, "0")}` as `0x${string}`;

      expect(
        decodeEvmUint256({
          label: "supply",
          success: true,
          returnData: uintWord,
        }),
      ).toBe(42n);
      expect(
        decodeEvmAddress({
          label: "identity",
          success: true,
          returnData: addressWord,
        }),
      ).toBe(address);
      expect(decodeEvmAddressHex(addressWord)).toBe(address);
      expect(decodeEvmHexBytes("0x00ff")).toEqual(
        new Uint8Array([0, 255]),
      );
  });


  it("preserves fail-closed decoding", () => {
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

  it("preserves ordered Solana RPC failover without retrying one endpoint", async () => {
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [
        { body: { error: { code: -32000, message: "unavailable" } } },
        { body: { result: { slot: 42 } } },
      ],
    }]);

    await expect(
      fetchSafetyScoreV9SolanaRpc<{ slot: number }>(
        "getSlot",
        [{ commitment: "finalized" }],
      ),
    ).resolves.toEqual({ slot: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.mainnet-beta.solana.com",
      "https://api.mainnet.solana.com",
    ]);
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1]!.body as string),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getSlot",
      params: [{ commitment: "finalized" }],
    });
  });

  it("prefers the configured Solana RPC and preserves header auth", async () => {
    const configuredUrl = buildAlchemyRpcUrl("solana-mainnet", "test-key");
    const fetchMock = mockFetch([{
      match: configuredUrl,
      outcomes: [{ body: { result: { slot: 42 } } }],
    }]);
    const configured = new Map<string, ChainRpcConfig>([[
      "solana",
      {
        chainId: "solana",
        chainName: "Solana",
        type: "other",
        endpoints: [{
          url: configuredUrl,
          operator: "public",
          keyed: false,
          position: "registry",
          stateHistory: "archive",
          logsHistory: "full",
        }],
        explorerUrl: "https://solscan.io",
      } satisfies ChainRpcConfig,
    ]]);

    await expect(
      fetchSafetyScoreV9SolanaRpc<{ slot: number }>(
        "getSlot",
        [{ commitment: "finalized" }],
        undefined,
        configured,
      ),
    ).resolves.toEqual({ slot: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(configuredUrl);
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
  });

  it("uses the configured RPC through the default reviewed-deployment wrapper", async () => {
    const configuredUrl = "https://solana.example";
    const fetchMock = mockFetch([{
      match: configuredUrl,
      outcomes: [{ body: { result: {} } }],
    }]);
    const configured = new Map<string, ChainRpcConfig>([[
      "solana",
      {
        chainId: "solana",
        chainName: "Solana",
        type: "other",
        endpoints: [{
          url: configuredUrl,
          operator: "public",
          keyed: false,
          position: "registry",
          stateHistory: "archive",
          logsHistory: "full",
        }],
        explorerUrl: "https://solscan.io",
      } satisfies ChainRpcConfig,
    ]]);

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
      chainRpcs: configured,
    })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(configuredUrl);
  });

  it("retries a single Solana endpoint once before rotating to the next endpoint", async () => {
    const fetchMock = mockFetch([{
      match: "api.mainnet-beta.solana.com",
      outcomes: [
        new Error("network flake"),
        { body: { result: { slot: 42 } } },
      ],
    }]);

    await expect(
      fetchSafetyScoreV9SolanaRpc<{ slot: number }>(
        "getSlot",
        [{ commitment: "finalized" }],
      ),
    ).resolves.toEqual({ slot: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.mainnet-beta.solana.com",
      "https://api.mainnet-beta.solana.com",
    ]);
  });

  it("falls through to the independent Pocket Network Solana endpoint", async () => {
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [
        { body: { error: { code: -32000, message: "unavailable" } } },
        { body: { error: { code: -32000, message: "unavailable" } } },
        { body: { result: { slot: 42 } } },
      ],
    }]);

    await expect(
      fetchSafetyScoreV9SolanaRpc<{ slot: number }>(
        "getSlot",
        [{ commitment: "finalized" }],
      ),
    ).resolves.toEqual({ slot: 42 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.mainnet-beta.solana.com",
      "https://api.mainnet.solana.com",
      "https://solana.api.pocket.network",
    ]);
  });

  it("rejects a supplemental-only chain config as chain-rpc-unavailable", async () => {
    const supplementalOnly = new Map<string, ChainRpcConfig>([[
      "ethereum",
      {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        endpoints: [{
          url: "https://api-ethereum-mainnet-erigon.n.dwellir.com",
          operator: "dwellir",
          keyed: true,
          position: "supplemental",
          stateHistory: "archive",
          logsHistory: "full",
          verifiedAt: "2026-09-23",
        }],
        explorerUrl: "https://etherscan.io",
      } satisfies ChainRpcConfig,
    ]]);
    const fetchMock = mockFetch([]);

    await expect(observeReviewedEvmDeployment({
      routeId: "ethereum:demo-token",
      chainId: "ethereum",
      contractAddress: "0x0000000000000000000000000000000000000001",
      scoringClockSec: 1_700_000_000,
      chainRpcs: supplementalOnly,
      dependencies: {
        sha256HexFromBytes,
        fetchEvmBlockNumber,
        fetchEvmBlockHeader,
        fetchEvmCodeAtBlock,
        fetchEvmMulticall3Aggregate3AtBlock,
        fetchEvmStorageAtBlock,
      },
      identity: () => ({ routeId: "ethereum:demo-token" }),
      safeBlockLag: () => 64,
      extraRpcUrls: () => undefined,
      protocolCalls: () => [],
      decodeProtocolObservation: () => ({ status: "accepted" as const, observation: {} }),
      identityValidationError: () => null,
    })).resolves.toEqual({
      status: "rejected",
      rejectionCode: "chain-rpc-unavailable",
      failedRouteId: "ethereum:demo-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("pinned EVM reads without Multicall3", () => {
    const contractAddress = "0x1111111111111111111111111111111111111111";
    const blockHash = `0x${"a".repeat(64)}` as `0x${string}`;
    const word = (value: number) => value.toString(16).padStart(64, "0");
    const supply = `0x${word(42)}`;
    const decimals = `0x${word(6)}`;
    const protocolSelector = "0x5c975abb";

    function fixture(input: {
      multicall: "present" | "absent" | "unavailable";
      requiredFailure?: boolean;
      mismatch?: "number" | "hash";
    }) {
      const requests: Array<{ method: string; params: unknown[] }> = [];
      let headers = 0;
      // ABI aggregate3 response: supply, decimals, then an optional reverted read.
      const entries = [supply, decimals, "0x"].map((data, index) =>
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
        if (request.method === "eth_blockNumber") result = "0x11";
        if (request.method === "eth_getBlockByNumber") {
          headers += 1;
          result = {
            number: headers > 1 && input.mismatch === "number" ? "0xf" : "0x10",
            timestamp: "0x64",
            hash: headers > 1 && input.mismatch === "hash" ? `0x${"b".repeat(64)}` : blockHash,
          };
        }
        if (request.method === "eth_getCode") {
          if (request.params[0] === MULTICALL3_ADDRESS) {
            if (input.multicall === "unavailable") error = { code: -32000, message: "unavailable" };
            else result = input.multicall === "absent" ? "0x" : "0x6000";
          } else result = "0x6001";
        }
        if (request.method === "eth_getStorageAt") result = `0x${word(0)}`;
        if (request.method === "eth_call") {
          const call = request.params[0] as { to: string; data: string };
          if (call.to === MULTICALL3_ADDRESS) {
            result = `0x${word(32)}${word(entries.length)}${offsets.join("")}${entries.join("")}`;
          } else if (call.data === protocolSelector) {
            error = { code: 3, message: "execution reverted" };
          } else result = call.data === "0x18160ddd" ? supply : decimals;
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(error ? { error } : { result }) }));
      }));
      const observe = () => observeReviewedEvmDeployment({
        routeId: `ethereum:${contractAddress}`,
        chainId: "ethereum",
        contractAddress,
        scoringClockSec: 100,
        chainRpcs: new Map<string, ChainRpcConfig>(),
        dependencies: {
          sha256HexFromBytes, fetchEvmBlockNumber, fetchEvmBlockHeader,
          fetchEvmCodeAtBlock, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmStorageAtBlock,
        },
        identity: () => ({}),
        safeBlockLag: () => 1,
        extraRpcUrls: () => ["https://rpc.example"],
        protocolCalls: () => [{
          label: "optional-paused", target: contractAddress, callData: protocolSelector,
          allowFailure: !input.requiredFailure,
        }],
        decodeProtocolObservation: ({ results }) => results[2]?.success === false
          ? { status: "accepted" as const, observation: {} }
          : { status: "rejected" as const, rejectionCode: "deployment-state-invalid" as const },
        identityValidationError: () => null,
      });
      return { requests, observe };
    }

    it("produces the same observations by direct calls, including allowed failures", async () => {
      const multicall = fixture({ multicall: "present" });
      const expected = await multicall.observe();
      expect(expected).toMatchObject({
        status: "accepted", observation: { rawSupply: "42", decimals: 6, blockHash },
      });
      const direct = fixture({ multicall: "absent" });
      expect(await direct.observe()).toEqual(expected);
    });

    it("rejects the deployment when a required direct call fails", async () => {
      const direct = fixture({ multicall: "absent", requiredFailure: true });
      expect(await direct.observe()).toEqual({
        status: "rejected", rejectionCode: "deployment-state-unavailable",
        failedRouteId: `ethereum:${contractAddress}`,
      });
    });

    it.each(["number", "hash"] as const)("rejects a changed block %s after direct reads", async (mismatch) => {
      const direct = fixture({ multicall: "absent", mismatch });
      expect(await direct.observe()).toMatchObject({
        status: "rejected", rejectionCode: "deployment-state-unavailable",
      });
    });

    it("keeps the canonical aggregate3 path when Multicall3 has code", async () => {
      const multicall = fixture({ multicall: "present" });
      expect(await multicall.observe()).toMatchObject({ status: "accepted", observation: { rawSupply: "42" } });
      const calls = multicall.requests.filter((request) => request.method === "eth_call");
      expect(calls.map((request) => {
        const call = request.params[0];
        return call && typeof call === "object" && "to" in call ? call.to : null;
      })).toEqual([MULTICALL3_ADDRESS]);
    });

    it("does not mistake unavailable Multicall3 code for an absent contract", async () => {
      const unavailable = fixture({ multicall: "unavailable" });
      expect(await unavailable.observe()).toMatchObject({
        status: "rejected", rejectionCode: "deployment-state-unavailable",
      });
      expect(unavailable.requests.some((request) => request.method === "eth_call")).toBe(false);
    });
  });
});
