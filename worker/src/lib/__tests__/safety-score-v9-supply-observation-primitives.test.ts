import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
import {
  decodeEvmAddress,
  decodeEvmAddressHex,
  decodeEvmHexBytes,
  decodeEvmUint256,
  fetchSafetyScoreV9SolanaRpc,
  safetyScoreV9EvmObservationOptions,
} from "../safety-score-v9-supply-observation-primitives";

const EVM_CHARACTERIZATION_VECTORS = [
  {
    assetId: "xaut-tether",
    extraRpcUrls: undefined,
  },
  {
    assetId: "wm-m0",
    extraRpcUrls: ["https://rpc.plume.org"],
  },
  {
    assetId: "jtrsy-anemoy",
    extraRpcUrls: [
      "https://rpc.monad.xyz",
      "https://rpc1.monad.xyz",
    ],
  },
] as const;

function chainRpcs(): Map<string, ChainRpcConfig> {
  return new Map([
    [
      "ethereum",
      {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://ethereum.example",
        explorerUrl: "https://etherscan.io",
      },
    ],
  ]);
}

describe("Safety Score V9 supply observation primitives", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(EVM_CHARACTERIZATION_VECTORS)(
    "preserves $assetId EVM decoding and retry options",
    ({ extraRpcUrls }) => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      const addressWord =
        `0x${address.slice(2).padStart(64, "0")}` as `0x${string}`;
      const uintWord = `0x${"2a".padStart(64, "0")}` as `0x${string}`;
      const options = safetyScoreV9EvmObservationOptions({
        chainRpcs: chainRpcs(),
        extraRpcUrls,
      });

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
      expect(options).toEqual({
        chainRpcs: expect.any(Map),
        ...(extraRpcUrls
          ? { extraRpcUrls: [...extraRpcUrls] }
          : {}),
        signal: undefined,
        timeoutMs: 10_000,
        maxRetries: 1,
      });
    },
  );

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
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: -32000, message: "unavailable" } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { slot: 42 } }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

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
});
