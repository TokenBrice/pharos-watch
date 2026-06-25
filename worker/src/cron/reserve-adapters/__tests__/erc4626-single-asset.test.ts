import { beforeEach, describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse } from "../../../test-helpers/__shared/mock-fetch";
import { fetchWithRetryMock, resetRpcMocks, testChainRpcs } from "./helpers/rpc-mock";

function uint256Result(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function cloneConfigWithoutExpectedAsset(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params: { slice?: { expectedAssetAddress?: string } };
  };
  delete cloned.params.slice?.expectedAssetAddress;
  return cloned;
}

function cloneConfigWithMorphoVaultV2Liquidity(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params: { redemptionLiquidity?: { source: "morpho-vault-v2"; chainId: number } };
  };
  cloned.params.redemptionLiquidity = { source: "morpho-vault-v2", chainId: 1 };
  return cloned;
}

function cloneConfigWithMorphoVaultV1Liquidity(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params: { redemptionLiquidity?: { source: "morpho-vault-v1"; chainId: number } };
  };
  cloned.params.redemptionLiquidity = { source: "morpho-vault-v1", chainId: 1 };
  return cloned;
}

function cloneConfigWithAtomicFullBacking(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params: { redemptionLiquidity?: { source: "atomic-full-backing" } };
  };
  cloned.params.redemptionLiquidity = { source: "atomic-full-backing" };
  return cloned;
}

describe("fetchErc4626SingleAssetReserves", () => {
  beforeEach(() => {
    resetRpcMocks();
  });

  it("returns a 100% single-asset slice after probing ERC-4626 state", async () => {
    const balanceOfCalls: Array<{ to?: string; data: string }> = [];
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      if (call.data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (call.data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data === "0x18160ddd") {
        // totalSupply = 100 shares
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        // convertToAssets(100) = 100 assets → ratio 1.0
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        balanceOfCalls.push(call);
        return jsonResponse({ result: uint256Result(25_000_000n) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
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
      totalAssetsRaw: "100000000",
      totalSupplyRaw: "100000000",
      convertToAssetsRaw: "100000000",
      collateralizationRatio: 1,
      idleUnderlyingBalanceRaw: "25000000",
      underlyingDecimals: 6,
      details: {
        proofKind: "erc4626-total-assets",
        assetAddressMatchesExpected: true,
      },
      redemption: {
        capacityUsd: 25,
        capacityRatioOfSupply: 0.25,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });
    expect(balanceOfCalls).toEqual([
      expect.objectContaining({
        to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        data: expect.stringContaining("80ac24aa929eaf5013f6436cda2a7ba190f5cc0b"),
      }),
    ]);
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
      fetchErc4626SingleAssetReserves(coin!, coin!.liveReservesConfig!, new AbortController().signal, {
        chainRpcs: testChainRpcs,
      }),
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
      fetchErc4626SingleAssetReserves(coin!, coin!.liveReservesConfig!, new AbortController().signal, {
        chainRpcs: testChainRpcs,
      }),
    ).rejects.toThrow(/asset\(\) could not be read/);
  });

  it("uses documented-eventual redemption telemetry when asset() is absent with no expected asset", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({ result: "0x" });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithoutExpectedAsset(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata).toMatchObject({
      totalAssetsRaw: "100000000",
      totalSupplyRaw: "100000000",
      convertToAssetsRaw: "100000000",
      collateralizationRatio: 1,
      redemption: {
        capacityKind: "documented-eventual",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });
    expect(result.metadata).not.toHaveProperty("assetAddress");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
  });

  it("suppresses redemption capacity when underlying decimals are invalid", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(25_000_000n) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(37) });
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

    expect(result.metadata).toMatchObject({
      assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      redemption: {
        capacityKind: "documented-eventual",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });
    expect(result.metadata).not.toHaveProperty("idleUnderlyingBalanceRaw");
    expect(result.metadata).not.toHaveProperty("underlyingDecimals");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
  });

  it("emits zero redemption capacity when idle underlying balance is zero", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
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

    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "0",
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 0,
        capacityRatioOfSupply: 0,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });
  });

  it("uses full convertible backing as capacity for atomic-full-backing vaults even with zero idle balance", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data.startsWith("0x70a08231")) {
        // Vault holds no idle underlying — backing lives in an external savings module.
        return jsonResponse({ result: uint256Result(0) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithAtomicFullBacking(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "0",
      redemptionCapacityRaw: "100000000",
      redemptionCapacitySource: "erc4626-atomic-full-backing",
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 100,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
        routeStatusSource: "onchain",
      },
    });
  });

  it("uses validated Morpho V2 vault liquidity when it exceeds idle underlying balance", async () => {
    const morphoVariables: unknown[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params?: [{ data: string }];
        variables?: Record<string, unknown>;
      };
      if (url === "https://api.morpho.org/graphql") {
        morphoVariables.push(body.variables);
        return jsonResponse({
          data: {
            vaultV2ByAddress: {
              address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
              listed: true,
              asset: {
                address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              },
              chain: { id: 1 },
              liquidity: "30000000",
              liquidityUsd: 30,
              forceDeallocatableLiquidity: "35000000",
              forceDeallocatableLiquidityUsd: 35,
              warnings: [],
            },
          },
        });
      }
      const call = body.params?.[0];
      if (!call) return null;
      if (call.data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (call.data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithMorphoVaultV2Liquidity(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "0",
      redemptionCapacityRaw: "30000000",
      redemptionCapacitySource: "morpho-vault-v2-liquidity",
      morphoVaultV2LiquidityRaw: "30000000",
      morphoVaultV2LiquidityUsd: 30,
      morphoVaultV2ForceDeallocatableLiquidityRaw: "35000000",
      morphoVaultV2ForceDeallocatableLiquidityUsd: 35,
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 30,
        capacityRatioOfSupply: 0.3,
        capacityKind: "live-direct",
        freshnessKind: "same-run-api",
        routeStatus: "unknown",
        routeStatusSource: "protocol-api",
      },
    });
    expect(morphoVariables).toEqual([
      {
        address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
        chainId: 1,
      },
    ]);
  });

  it("uses validated Morpho V1 vault liquidity when it exceeds idle underlying balance", async () => {
    const morphoVariables: unknown[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params?: [{ data: string }];
        variables?: Record<string, unknown>;
      };
      if (url === "https://api.morpho.org/graphql") {
        morphoVariables.push(body.variables);
        return jsonResponse({
          data: {
            vaultByAddress: {
              address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
              listed: true,
              asset: {
                address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              },
              chain: { id: 1 },
              liquidity: {
                underlying: "30000000",
                usd: 30,
              },
              warnings: [],
            },
          },
        });
      }
      const call = body.params?.[0];
      if (!call) return null;
      if (call.data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (call.data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithMorphoVaultV1Liquidity(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "0",
      redemptionCapacityRaw: "30000000",
      redemptionCapacitySource: "morpho-vault-v1-liquidity",
      morphoVaultV1LiquidityRaw: "30000000",
      morphoVaultV1LiquidityUsd: 30,
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 30,
        capacityRatioOfSupply: 0.3,
        capacityKind: "live-direct",
        freshnessKind: "same-run-api",
        routeStatus: "unknown",
        routeStatusSource: "protocol-api",
      },
    });
    expect(morphoVariables).toEqual([
      {
        address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
        chainId: 1,
      },
    ]);
  });

  it("falls back to idle capacity and degrades when Morpho V2 identity validation fails", async () => {
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params?: [{ data: string }];
      };
      if (url === "https://api.morpho.org/graphql") {
        return jsonResponse({
          data: {
            vaultV2ByAddress: {
              address: "0x000000000000000000000000000000000000dead",
              listed: true,
              asset: {
                address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              },
              chain: { id: 1 },
              liquidity: "90000000",
              liquidityUsd: 90,
              warnings: [],
            },
          },
        });
      }
      const call = body.params?.[0];
      if (!call) return null;
      if (call.data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (call.data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(25_000_000n) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithMorphoVaultV2Liquidity(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "morpho-vault-v2-identity-mismatch",
        severity: "warning",
      }),
    ]);
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "25000000",
      redemptionCapacityRaw: "25000000",
      redemptionCapacitySource: "erc4626-idle-underlying",
      redemption: {
        capacityUsd: 25,
        capacityRatioOfSupply: 0.25,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "degraded",
        routeStatusSource: "onchain",
      },
    });
    expect(result.metadata).not.toHaveProperty("morphoVaultV2LiquidityRaw");
  });

  it("skips NAV ratio when totalSupply is zero but still emits readable idle capacity USD", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      if (body.params[0].data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (body.params[0].data === "0x01e1d114") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (body.params[0].data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (body.params[0].data.startsWith("0x07a2d13a")) {
        throw new Error("convertToAssets should not be called when totalSupply is zero");
      }
      if (body.params[0].data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(25_000_000n) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
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

    expect(result.metadata).toMatchObject({
      totalAssetsRaw: "100000000",
      totalSupplyRaw: "0",
      idleUnderlyingBalanceRaw: "25000000",
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 25,
        capacityRatioOfSupply: 0.25,
        capacityKind: "live-direct",
      },
    });
    expect(result.metadata).not.toHaveProperty("convertToAssetsRaw");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
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
      if (body.params[0].data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
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
      if (body.params[0].data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(18) });
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
      if (body.params[0].data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(18) });
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
      if (body.params[0].data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0) });
      }
      if (body.params[0].data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(18) });
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
