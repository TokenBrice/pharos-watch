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
});
