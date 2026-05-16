import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
      if (body.params[0].data === "0x18160ddd") {
        // totalSupply = 100 shares
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        // convertToAssets(100) = 100 assets → ratio 1.0
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
      totalSupplyRaw: "100",
      convertToAssetsRaw: "100",
      collateralizationRatio: 1,
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

  it("throws when the vault asset differs from the configured expectation", async () => {
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

    await expect(
      fetchErc4626SingleAssetReserves(
        coin!,
        coin!.liveReservesConfig!,
        new AbortController().signal,
        { chainRpcs: testChainRpcs },
      ),
    ).rejects.toThrow(/asset\(\) returned/);
  });

  it("throws when expected vault asset identity cannot be read", async () => {
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

    await expect(
      fetchErc4626SingleAssetReserves(
        coin!,
        coin!.liveReservesConfig!,
        new AbortController().signal,
        { chainRpcs: testChainRpcs },
      ),
    ).rejects.toThrow(/asset\(\) could not be read/);
  });

  it("emits degraded warning when convertToAssets diverges from totalAssets by >1%", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        // totalAssets = 100
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data === "0x18160ddd") {
        // totalSupply = 100
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        // convertToAssets(100) = 110 → ratio 1.10 (10% divergence)
        return jsonResponse({ result: "0x000000000000000000000000000000000000000000000000000000000000006e" });
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
        code: "erc4626-nav-divergence",
        severity: "warning",
      }),
    ]);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.1, 2);
    expect(result.metadata?.redemption?.routeStatus).toBe("degraded");
  });

  it("uses explicit RPC URLs for ERC-4626 vaults on chains without registry RPCs", async () => {
    const calledUrls: string[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calledUrls.push(url);
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x0000000000000000000000006695c0f8706c5ace3bdf8995073179cca47926dc",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syzusd-yuzu");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      coin!.liveReservesConfig!,
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(calledUrls).toEqual([
      "https://rpc.plasma.to",
      "https://rpc.plasma.to",
      "https://rpc.plasma.to",
      "https://rpc.plasma.to",
    ]);
    expect(result.slices).toEqual([
      {
        name: "Yuzu USD staking vault shares",
        pct: 100,
        risk: "high",
        coinId: "yzusd-yuzu",
        depType: "wrapper",
      },
    ]);
    expect(result.metadata).toMatchObject({
      chain: "plasma",
      contractAddress: "0xc8a8df9b210243c55d31c73090f06787ad0a1bf6",
      assetAddress: "0x6695c0f8706c5ace3bdf8995073179cca47926dc",
      details: {
        proofKind: "erc4626-total-assets",
        assetAddressMatchesExpected: true,
      },
    });
  });

  it("probes Avant savUSD as a high-risk avUSD wrapper", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x00000000000000000000000024de8771bc5ddb3362db529fc3358f2df3a0e346",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("savusd-avant");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      coin!.liveReservesConfig!,
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices).toEqual([
      {
        name: "avUSD savings vault shares",
        pct: 100,
        risk: "high",
        coinId: "avusd-avant",
        depType: "wrapper",
      },
    ]);
    expect(result.metadata).toMatchObject({
      chain: "avalanche",
      assetAddress: "0x24de8771bc5ddb3362db529fc3358f2df3a0e346",
      details: {
        assetAddressMatchesExpected: true,
      },
    });
  });

  it("probes Strata srUSDe as a high-risk USDe wrapper", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x0000000000000000000000004c9edd5852cd905f086c759e8383e09bff1e68b3",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("srusde-strata");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      coin!.liveReservesConfig!,
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices).toEqual([
      {
        name: "Senior tranche USDe vault shares",
        pct: 100,
        risk: "high",
        coinId: "usde-ethena",
        depType: "wrapper",
      },
    ]);
    expect(result.metadata).toMatchObject({
      chain: "ethereum",
      assetAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
      details: {
        assetAddressMatchesExpected: true,
      },
    });
  });
});
