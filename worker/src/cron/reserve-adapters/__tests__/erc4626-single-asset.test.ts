import { beforeEach, describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse } from "../../../test-helpers/__shared/mock-fetch";
import { fetchWithRetryMock, resetRpcMocks, testChainRpcs } from "./helpers/rpc-mock";

function uint256Result(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): string {
  return address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function addressArrayResult(addresses: string[]): string {
  return `0x${[
    BigInt(32).toString(16).padStart(64, "0"),
    BigInt(addresses.length).toString(16).padStart(64, "0"),
    ...addresses.map(addressWord),
  ].join("")}`;
}

function strategyParamsResult(currentDebtRaw: bigint | number): string {
  return `0x${[
    BigInt(1).toString(16).padStart(64, "0"),
    BigInt(2).toString(16).padStart(64, "0"),
    BigInt(currentDebtRaw).toString(16).padStart(64, "0"),
    BigInt(1_000_000_000_000n).toString(16).padStart(64, "0"),
  ].join("")}`;
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

function cloneConfigWithYearnV3Withdrawable(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params: { redemptionLiquidity?: { source: "yearn-v3-withdrawable"; settlementDelaySec: number } };
  };
  cloned.params.redemptionLiquidity = { source: "yearn-v3-withdrawable", settlementDelaySec: 0 };
  return cloned;
}

function cloneConfigWithSboldSpWithdrawable(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params: { redemptionLiquidity?: { source: "sbold-sp-withdrawable" } };
  };
  cloned.params.redemptionLiquidity = { source: "sbold-sp-withdrawable" };
  return cloned;
}

// sBOLD calcFragments() -> (totalBold, boldAmount, collValue, collInBold). The
// adapter reads word index 1 (boldAmount = compounded Stability-Pool BOLD).
function calcFragmentsResult(
  boldAmountRaw: bigint | number,
  collInBoldRaw: bigint | number = 0,
): string {
  return `0x${[
    uint256Result(100_000_000n).slice(2), // totalBold (unused by the adapter)
    uint256Result(boldAmountRaw).slice(2), // boldAmount — the withdrawable word
    uint256Result(0).slice(2), // collValue
    uint256Result(collInBoldRaw).slice(2), // collInBold (not-yet-swapped collateral)
  ].join("")}`;
}

// Yearn V3 vault: 5M idle plus two queued strategies (60M debt fully redeemable,
// 35M debt with 20M redeemable) => 85M withdrawable, with isShutdown() pinned.
function yearnV3RpcMock(isShutdownRaw: bigint | number) {
  const strategyA = "0x1111111111111111111111111111111111111111";
  const strategyB = "0x2222222222222222222222222222222222222222";
  return async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
    const call = body.params[0];
    const to = call.to?.toLowerCase();
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
    if (call.data.startsWith("0x07a2d13a") && to === "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b") {
      return jsonResponse({ result: uint256Result(100_000_000n) });
    }
    if (call.data.startsWith("0x70a08231")) {
      return jsonResponse({ result: uint256Result(5_000_000n) });
    }
    if (call.data === "0x313ce567") {
      return jsonResponse({ result: uint256Result(6) });
    }
    if (call.data === "0x9aa7df94") {
      return jsonResponse({ result: uint256Result(5_000_000n) });
    }
    if (call.data === "0xa9bbf1cc") {
      return jsonResponse({ result: addressArrayResult([strategyA, strategyB]) });
    }
    if (call.data === "0xbf86d690") {
      return jsonResponse({ result: uint256Result(isShutdownRaw) });
    }
    if (call.data.startsWith("0x39ebf823")) {
      if (call.data.toLowerCase().includes(strategyA.slice(2).toLowerCase())) {
        return jsonResponse({ result: strategyParamsResult(60_000_000n) });
      }
      if (call.data.toLowerCase().includes(strategyB.slice(2).toLowerCase())) {
        return jsonResponse({ result: strategyParamsResult(35_000_000n) });
      }
    }
    if (call.data.startsWith("0xd905777e") && to === strategyA) {
      return jsonResponse({ result: uint256Result(60_000_000n) });
    }
    if (call.data.startsWith("0xd905777e") && to === strategyB) {
      return jsonResponse({ result: uint256Result(20_000_000n) });
    }
    if (call.data.startsWith("0x07a2d13a") && to === strategyA) {
      return jsonResponse({ result: uint256Result(60_000_000n) });
    }
    if (call.data.startsWith("0x07a2d13a") && to === strategyB) {
      return jsonResponse({ result: uint256Result(20_000_000n) });
    }
    return null;
  };
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
        routeStatus: "open",
        routeStatusReason: expect.stringContaining("Idle underlying redemption liquidity"),
      },
    });
    expect(balanceOfCalls).toEqual([
      expect.objectContaining({
        to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        data: expect.stringContaining("80ac24aa929eaf5013f6436cda2a7ba190f5cc0b"),
      }),
    ]);
  });

  it("preserves BigInt precision when the NAV divergence is just above 1%", async () => {
    const totalAssetsRaw = 10n ** 30n;
    const convertedAssetsRaw = totalAssetsRaw + totalAssetsRaw / 100n + 1n;
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      const data = body.params[0].data;
      if (data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (data === "0x01e1d114" || data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(totalAssetsRaw) });
      }
      if (data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(convertedAssetsRaw) });
      }
      if (data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(0n) });
      }
      if (data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple")!;
    const result = await fetchErc4626SingleAssetReserves(
      coin,
      coin.liveReservesConfig!,
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata).toMatchObject({
      collateralizationRatio: 1.01,
      convertToAssetsRaw: convertedAssetsRaw.toString(),
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "erc4626-nav-divergence",
    }));
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

  it("reports a paused redemption route when the vault paused() returns true", async () => {
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
        return jsonResponse({ result: uint256Result(6) });
      }
      if (body.params[0].data === "0x5c975abb") {
        return jsonResponse({ result: uint256Result(1) });
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

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "25000000",
      redemption: {
        capacityUsd: 25,
        routeStatus: "paused",
        routeStatusReason: "Vault paused() returned true on-chain",
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
        routeStatus: "open",
        routeStatusReason: expect.stringContaining("Reviewer-asserted unconstrained external-savings redemption"),
        routeStatusSource: "onchain",
      },
    });
  });

  it("uses Yearn V3 default-queue withdrawable capacity when configured", async () => {
    const strategyA = "0x1111111111111111111111111111111111111111";
    const strategyB = "0x2222222222222222222222222222222222222222";
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ to?: string; data: string }] };
      const call = body.params[0];
      const to = call.to?.toLowerCase();
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
      if (call.data.startsWith("0x07a2d13a") && to === "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(5_000_000n) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      if (call.data === "0x9aa7df94") {
        return jsonResponse({ result: uint256Result(5_000_000n) });
      }
      if (call.data === "0xa9bbf1cc") {
        return jsonResponse({ result: addressArrayResult([strategyA, strategyB]) });
      }
      if (call.data.startsWith("0x39ebf823")) {
        if (call.data.toLowerCase().includes(strategyA.slice(2).toLowerCase())) {
          return jsonResponse({ result: strategyParamsResult(60_000_000n) });
        }
        if (call.data.toLowerCase().includes(strategyB.slice(2).toLowerCase())) {
          return jsonResponse({ result: strategyParamsResult(35_000_000n) });
        }
      }
      if (call.data.startsWith("0xd905777e") && to === strategyA) {
        return jsonResponse({ result: uint256Result(60_000_000n) });
      }
      if (call.data.startsWith("0xd905777e") && to === strategyB) {
        return jsonResponse({ result: uint256Result(20_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a") && to === strategyA) {
        return jsonResponse({ result: uint256Result(60_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a") && to === strategyB) {
        return jsonResponse({ result: uint256Result(20_000_000n) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithYearnV3Withdrawable(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "5000000",
      redemptionCapacityRaw: "85000000",
      redemptionCapacitySource: "yearn-v3-withdrawable",
      yearnV3WithdrawableRaw: "85000000",
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 85,
        capacityRatioOfSupply: 0.85,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
        routeStatusSource: "onchain",
        settlementDelaySec: 0,
      },
    });
  });

  it("opens the Yearn V3 route when withdrawable capacity is positive and isShutdown() is false", async () => {
    fetchWithRetryMock.mockImplementation(yearnV3RpcMock(0));

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithYearnV3Withdrawable(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      redemptionCapacityRaw: "85000000",
      redemptionCapacitySource: "yearn-v3-withdrawable",
      redemption: {
        capacityUsd: 85,
        routeStatus: "open",
        routeStatusReason: "Yearn V3 withdrawable liquidity positive and isShutdown() false this run",
        routeStatusSource: "onchain",
      },
    });
  });

  it("reports a paused Yearn V3 route when isShutdown() returns true", async () => {
    fetchWithRetryMock.mockImplementation(yearnV3RpcMock(1));

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithYearnV3Withdrawable(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      redemptionCapacityRaw: "85000000",
      redemption: {
        capacityUsd: 85,
        routeStatus: "paused",
        routeStatusReason: "Yearn vault isShutdown() returned true on-chain",
      },
    });
  });

  it("uses sBOLD Stability-Pool-withdrawable capacity from calcFragments instead of the ~0 idle balance", async () => {
    const calcFragmentsCalls: Array<{ to?: string; data: string }> = [];
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
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        // Idle BOLD balance is ~1 unit (dead share); the real backing is deployed to SPs.
        return jsonResponse({ result: uint256Result(1_000_000n) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      if (call.data === "0x160b71df") {
        calcFragmentsCalls.push(call);
        return jsonResponse({ result: calcFragmentsResult(85_000_000n) });
      }
      if (call.data === "0xbf2428e6") {
        return jsonResponse({ result: uint256Result(7_500_000n) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithSboldSpWithdrawable(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "1000000",
      redemptionCapacityRaw: "85000000",
      redemptionCapacitySource: "sbold-sp-withdrawable",
      sboldSpWithdrawableRaw: "85000000",
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 85,
        capacityRatioOfSupply: 0.85,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusReason:
          "sBOLD Stability Pool withdrawable BOLD positive and collateral-health gate open on-chain this run",
        routeStatusSource: "onchain",
      },
    });
    expect(calcFragmentsCalls).toHaveLength(1);
  });

  it("degrades sBOLD when collateral exceeds the maxCollInBold withdrawal gate", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      const call = body.params[0];
      if (call.data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (call.data === "0x01e1d114" || call.data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(1_000_000n) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      if (call.data === "0x160b71df") {
        return jsonResponse({ result: calcFragmentsResult(85_000_000n, 7_500_001n) });
      }
      if (call.data === "0xbf2428e6") {
        return jsonResponse({ result: uint256Result(7_500_000n) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithSboldSpWithdrawable(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      redemptionCapacityRaw: "85000000",
      redemptionCapacitySource: "sbold-sp-withdrawable",
      sboldSpWithdrawableRaw: "85000000",
      redemption: {
        capacityUsd: 85,
        capacityKind: "documented-bound",
        routeStatus: "degraded",
        routeStatusReason:
          "sBOLD collateral in BOLD exceeds maxCollInBold; _maxWithdraw() and _maxRedeem() return zero",
        routeStatusSource: "onchain",
      },
    });
  });

  it("keeps the existing documented-bound sBOLD telemetry when maxCollInBold is unreadable", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      const call = body.params[0];
      if (call.data === "0x38d52e0f") {
        return jsonResponse({
          result: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        });
      }
      if (call.data === "0x01e1d114" || call.data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(1_000_000n) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      if (call.data === "0x160b71df") {
        return jsonResponse({ result: calcFragmentsResult(85_000_000n) });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithSboldSpWithdrawable(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.redemption).toEqual({
      capacityUsd: 85,
      capacityRatioOfSupply: 0.85,
      capacityKind: "documented-bound",
      routeStatusReason: "sBOLD Stability Pool withdrawable BOLD positive via calcFragments() this run",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
    });
  });

  it("degrades sBOLD to the idle balance when the calcFragments probe cannot be decoded", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
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
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x07a2d13a")) {
        return jsonResponse({ result: uint256Result(100_000_000n) });
      }
      if (call.data.startsWith("0x70a08231")) {
        return jsonResponse({ result: uint256Result(1_000_000n) });
      }
      if (call.data === "0x313ce567") {
        return jsonResponse({ result: uint256Result(6) });
      }
      if (call.data === "0x160b71df") {
        return jsonResponse({ result: "0x" });
      }
      return null;
    });

    const { fetchErc4626SingleAssetReserves } = await import("../erc4626-single-asset");
    const coin = TRACKED_META_BY_ID.get("syrupusdc-maple");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchErc4626SingleAssetReserves(
      coin!,
      cloneConfigWithSboldSpWithdrawable(coin!.liveReservesConfig!),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "sbold-sp-withdrawable-unavailable",
        severity: "warning",
      }),
    ]);
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "1000000",
      redemptionCapacitySource: "erc4626-idle-underlying",
      redemption: {
        capacityUsd: 1,
        routeStatus: "degraded",
      },
    });
    expect(result.metadata).not.toHaveProperty("sboldSpWithdrawableRaw");
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
        routeStatus: "open",
        routeStatusReason: expect.stringContaining("Morpho listed-vault in-kind liquidity positive"),
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
        routeStatus: "open",
        routeStatusReason: expect.stringContaining("Morpho listed-vault in-kind liquidity positive"),
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
