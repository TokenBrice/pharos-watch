import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ChainRpcConfig } from "../../../lib/chain-registry";

const getChainRpcMock = vi.fn();
const fetchWithRetryMock = vi.fn();

vi.mock("../../../lib/chain-registry", () => ({
  getChainRpc: getChainRpcMock,
}));

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const testChainRpcs = new Map<string, ChainRpcConfig>([
  ["ethereum", {
    chainId: "ethereum",
    chainName: "Ethereum",
    type: "evm",
    rpcUrl: "https://rpc.example",
    explorerUrl: "https://etherscan.io",
  }],
]);

describe("fetchErc4626SingleAssetReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChainRpcMock.mockImplementation((_chainRpcs: Map<string, unknown>, chainId: string) =>
      testChainRpcs.get(chainId),
    );
  });

  it("returns a 100% single-asset slice after probing ERC-4626 state", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      coin!.liveReservesConfig!,
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices).toEqual([
      {
        name: "USDC-denominated loan receivables",
        pct: 100,
        risk: "medium",
        coinId: "usdc-circle",
        depType: "wrapper",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "ethereum",
      contractAddress: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
      assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      totalAssetsRaw: "100",
      details: {
        proofKind: "erc4626-total-assets",
        assetAddressMatchesExpected: true,
      },
      redemption: {
        capacityKind: "documented-eventual",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });
  });

  it("warns when the vault asset differs from the configured expectation", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000000000000000000000000000000000000000dead",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000001" });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      coin!.liveReservesConfig!,
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "asset-mismatch",
        severity: "warning",
      }),
    ]);
  });

  it("warns when expected vault asset identity cannot be read", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({ result: "0x" });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000001" });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      coin!.liveReservesConfig!,
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "asset-unavailable",
        severity: "warning",
      }),
    ]);
  });
});
