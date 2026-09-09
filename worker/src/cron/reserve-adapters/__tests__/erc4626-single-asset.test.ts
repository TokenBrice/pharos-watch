import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { installErc4626Network, runTrackedVault } from "./erc4626-single-asset.test-support";

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

function withRedemptionLiquidity(redemptionLiquidity: {
  source: "morpho-vault-v1" | "morpho-vault-v2" | "atomic-full-backing" | "yearn-v3-withdrawable" | "sbold-sp-withdrawable";
  chainId?: number;
  settlementDelaySec?: number;
}) {
  return (config: LiveReservesConfig): LiveReservesConfig => ({
    ...config, params: { ...config.params, redemptionLiquidity },
  });
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

const catalogCases = [
  { id: "syzusd-yuzu", asset: "0x6695c0f8706c5ace3bdf8995073179cca47926dc", vault: "0xc8a8df9b210243c55d31c73090f06787ad0a1bf6" },
  { id: "savusd-avant", asset: "0x24de8771bc5ddb3362db529fc3358f2df3a0e346", vault: "0x06d47f3fb376649c3a9dafe069b3d6e35572219e" },
  { id: "srusde-strata", asset: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003" },
] as const;

// Yearn V3 vault: 5M idle plus two queued strategies (60M debt fully redeemable,
// 35M debt with 20M redeemable) => 85M withdrawable, with isShutdown() pinned.
function mockYearnV3Rpc(isShutdownRaw?: bigint | number) {
  const strategyA = "0x1111111111111111111111111111111111111111";
  const strategyB = "0x2222222222222222222222222222222222222222";
  const vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b";
  installErc4626Network({
    idleBalance: 5_000_000n,
    shutdown: isShutdownRaw,
    extraHandlers: [({ call }) => {
      if (!call) return undefined;
      const to = call.to?.toLowerCase();
      if (to === vault && call.data === "0x9aa7df94") {
        return jsonResponse({ result: uint256Result(5_000_000n) });
      }
      if (to === vault && call.data === "0xa9bbf1cc") {
        return jsonResponse({ result: addressArrayResult([strategyA, strategyB]) });
      }
      if (to === vault && call.data.startsWith("0x39ebf823")) {
        if (call.data === `0x39ebf823${addressWord(strategyA)}`) {
          return jsonResponse({ result: strategyParamsResult(60_000_000n) });
        }
        if (call.data === `0x39ebf823${addressWord(strategyB)}`) {
          return jsonResponse({ result: strategyParamsResult(35_000_000n) });
        }
      }
      if (call.data === `0xce96cb77${addressWord(vault)}` && to === strategyA) {
        return jsonResponse({ result: uint256Result(60_000_000n) });
      }
      if (call.data === `0xce96cb77${addressWord(vault)}` && to === strategyB) {
        return jsonResponse({ result: uint256Result(20_000_000n) });
      }
      return undefined;
    }],
  });
}

describe("fetchErc4626SingleAssetReserves", () => {

  it("separates held collateral from deployed strategy exposure", async () => {
    const balanceOfCalls: Array<{ to?: string; data: string }> = [];
    installErc4626Network({ extraHandlers: [({ call }) => {
      if (call?.data.startsWith("0x70a08231")) balanceOfCalls.push(call);
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple");

    expect(result.slices).toEqual([
      expect.objectContaining({
        pct: 25,
        risk: "medium",
        coinId: "usdc-circle",
        depType: "wrapper",
      }),
      expect.objectContaining({ pct: 75, risk: "high" }),
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
      idleUnderlyingBalanceRaw: "25000000",
      underlyingDecimals: 6,
      details: {
        proofKind: "erc4626-total-assets",
        assetAddressMatchesExpected: true,
        navConsistencyRatio: 1,
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
    expect(balanceOfCalls).toHaveLength(1);
    expect(balanceOfCalls[0]?.to?.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(balanceOfCalls[0]?.data).toContain("80ac24aa929eaf5013f6436cda2a7ba190f5cc0b");
  });

  it("preserves BigInt precision when the NAV divergence is just above 1%", async () => {
    const totalAssetsRaw = 10n ** 30n;
    const convertedAssetsRaw = totalAssetsRaw + totalAssetsRaw / 100n + 1n;
    installErc4626Network({ totalAssets: totalAssetsRaw, totalSupply: totalAssetsRaw, convertedAssets: convertedAssetsRaw, idleBalance: 0n });

    const result = await runTrackedVault("syrupusdc-maple");

    expect(result.metadata).toMatchObject({
      convertToAssetsRaw: convertedAssetsRaw.toString(),
      details: { navConsistencyRatio: 1.01 },
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "erc4626-nav-divergence",
    }));
  });

  it("throws when the vault asset differs from the configured expectation", async () => {
    installErc4626Network({ asset: "0xdead" });

    await expect(
      runTrackedVault("syrupusdc-maple"),
    ).rejects.toThrow(/asset\(\) returned/);
  });

  it("throws when expected vault asset identity cannot be read", async () => {
    installErc4626Network({ asset: null });

    await expect(
      runTrackedVault("syrupusdc-maple"),
    ).rejects.toThrow(/asset\(\) could not be read/);
  });

  it("uses documented-eventual redemption telemetry when asset() is absent with no expected asset", async () => {
    installErc4626Network({ asset: null, idleBalance: null, decimals: null });

    const result = await runTrackedVault("syrupusdc-maple", cloneConfigWithoutExpectedAsset);

    expect(result.metadata).toMatchObject({
      totalAssetsRaw: "100000000",
      totalSupplyRaw: "100000000",
      convertToAssetsRaw: "100000000",
      details: { navConsistencyRatio: 1 },
      redemption: {
        capacityKind: "documented-eventual",
        freshnessKind: "same-run-onchain",
      },
    });
    expect(result.metadata).not.toHaveProperty("assetAddress");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
  });

  it("suppresses redemption capacity when underlying decimals are invalid", async () => {
    installErc4626Network({ decimals: 37 });

    const result = await runTrackedVault("syrupusdc-maple");

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

  it.each(["totalSupply", "convertedAssets", "idleBalance", "decimals"] as const)(
    "withholds only telemetry requiring an unreadable %s while asset identity remains valid",
    async (field) => {
      installErc4626Network({ [field]: null });
      const result = await runTrackedVault("syrupusdc-maple");
      expect(result.metadata).toMatchObject({
        assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        totalAssetsRaw: "100000000",
      });
      if (field === "totalSupply" || field === "convertedAssets") {
        expect(result.metadata?.details).not.toHaveProperty("navConsistencyRatio");
        expect(result.metadata).not.toHaveProperty("convertToAssetsRaw");
        expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 25 });
      } else {
        expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
        expect(result.metadata?.redemption).toMatchObject({ capacityKind: "documented-eventual" });
      }
    },
  );

  it("emits zero redemption capacity when idle underlying balance is zero", async () => {
    installErc4626Network({ idleBalance: 0 });

    const result = await runTrackedVault("syrupusdc-maple");

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
    installErc4626Network({ paused: 1 });

    const result = await runTrackedVault("syrupusdc-maple");

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-redemption-paused", effect: "degraded" }));
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
    installErc4626Network({ idleBalance: 0 });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "atomic-full-backing" }));

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
    mockYearnV3Rpc();

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "yearn-v3-withdrawable", settlementDelaySec: 0 }));

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
    mockYearnV3Rpc(0);

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "yearn-v3-withdrawable", settlementDelaySec: 0 }));

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
    mockYearnV3Rpc(1);

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "yearn-v3-withdrawable", settlementDelaySec: 0 }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-redemption-paused", effect: "degraded" }));
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
    installErc4626Network({ idleBalance: 1_000_000n, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") {
        calcFragmentsCalls.push(call);
        return jsonResponse({ result: calcFragmentsResult(85_000_000n) });
      }
      if (call?.data === "0xbf2428e6") return jsonResponse({ result: uint256Result(7_500_000n) });
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

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
    installErc4626Network({ idleBalance: 1_000_000n, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") return jsonResponse({ result: calcFragmentsResult(85_000_000n, 7_500_001n) });
      if (call?.data === "0xbf2428e6") return jsonResponse({ result: uint256Result(7_500_000n) });
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

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
    installErc4626Network({ idleBalance: 1_000_000n, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") return jsonResponse({ result: calcFragmentsResult(85_000_000n) });
      if (call?.data === "0xbf2428e6") return null;
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

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
    installErc4626Network({ idleBalance: 1_000_000n, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") return jsonResponse({ result: "0x" });
      if (call?.data === "0xbf2428e6") return null;
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

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

  it.each([
    {
      source: "morpho-vault-v1" as const,
      key: "vaultByAddress",
      liquidity: { liquidity: { underlying: "30000000", usd: 30 } },
      metadata: { morphoVaultV1LiquidityRaw: "30000000", morphoVaultV1LiquidityUsd: 30 },
    },
    {
      source: "morpho-vault-v2" as const,
      key: "vaultV2ByAddress",
      liquidity: {
        liquidity: "30000000", liquidityUsd: 30,
        forceDeallocatableLiquidity: "35000000", forceDeallocatableLiquidityUsd: 35,
      },
      metadata: {
        morphoVaultV2LiquidityRaw: "30000000", morphoVaultV2LiquidityUsd: 30,
        morphoVaultV2ForceDeallocatableLiquidityRaw: "35000000", morphoVaultV2ForceDeallocatableLiquidityUsd: 35,
      },
    },
  ])("uses $source liquidity rather than idle underlying balance", async ({ source, key, liquidity, metadata }) => {
    const morphoVariables: unknown[] = [];
    installErc4626Network({ idleBalance: 0, extraHandlers: [({ url, body }) => {
      if (url !== "https://api.morpho.org/graphql") return undefined;
      morphoVariables.push(body.variables);
      return jsonResponse({
        data: {
          [key]: {
            address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
            listed: true,
            asset: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
            chain: { id: 1 },
            ...liquidity,
            warnings: [],
          },
        },
      });
    }] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source, chainId: 1 }));
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "0",
      redemptionCapacityRaw: "30000000",
      redemptionCapacitySource: `${source}-liquidity`,
      ...metadata,
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 30,
        capacityRatioOfSupply: 0.3,
        capacityKind: "live-direct",
        freshnessKind: "same-run-api",
        routeStatus: "open",
        routeStatusSource: "protocol-api",
      },
    });
    expect(morphoVariables).toEqual([{ address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", chainId: 1 }]);
  });

  it("falls back to idle capacity and degrades when Morpho V2 identity validation fails", async () => {
    installErc4626Network({ extraHandlers: [({ url }) => {
      if (url !== "https://api.morpho.org/graphql") return undefined;
      return jsonResponse({
        data: {
          vaultV2ByAddress: {
            address: "0x000000000000000000000000000000000000dead",
            listed: true,
            asset: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
            chain: { id: 1 },
            liquidity: "90000000",
            liquidityUsd: 90,
            warnings: [],
          },
        },
      });
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }));

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
    const conversionCalls: string[] = [];
    installErc4626Network({ totalSupply: 0, convertedAssets: null, extraHandlers: [({ call }) => {
      if (call?.data.startsWith("0x07a2d13a")) {
        conversionCalls.push(call.data);
      }
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple");

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
    expect(result.metadata?.details).not.toHaveProperty("navConsistencyRatio");
    expect(conversionCalls).toEqual([]);
  });

  it("emits degraded warning when convertToAssets diverges from totalAssets by >1%", async () => {
    installErc4626Network({ totalAssets: 100, totalSupply: 100, convertedAssets: 110, idleBalance: 0 });

    const result = await runTrackedVault("syrupusdc-maple");

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "erc4626-nav-divergence",
        severity: "warning",
      }),
    ]);
    expect(result.metadata?.details?.navConsistencyRatio).toBeCloseTo(1.1, 2);
    expect(result.metadata?.redemption?.routeStatus).toBe("degraded");
  });

  it("uses explicit RPC URLs for ERC-4626 vaults on chains without registry RPCs", async () => {
    const scenario = catalogCases[0];
    installErc4626Network({ asset: scenario.asset, vault: scenario.vault, idleBalance: 0, decimals: 18 });

    const result = await runTrackedVault(scenario.id);

    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, risk: "high" })]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
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
    const scenario = catalogCases[1];
    installErc4626Network({
      asset: scenario.asset, vault: scenario.vault, idleBalance: 0, decimals: 18,
      extraHandlers: [({ call }) => call?.data === "0x35269315"
        ? jsonResponse({ result: uint256Result(86_400) }) : undefined],
    });

    const result = await runTrackedVault(scenario.id);

    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, risk: "high" })]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.metadata).toMatchObject({
      chain: "avalanche",
      assetAddress: "0x24de8771bc5ddb3362db529fc3358f2df3a0e346",
      redemption: { capacityKind: "documented-bound", settlementDelaySec: 86_400 },
      details: {
        assetAddressMatchesExpected: true,
      },
    });
  });

  it("probes Strata srUSDe as a high-risk USDe wrapper", async () => {
    const scenario = catalogCases[2];
    installErc4626Network({ asset: scenario.asset, vault: scenario.vault, idleBalance: 0, decimals: 18 });

    const result = await runTrackedVault(scenario.id);

    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, risk: "high" })]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.metadata).toMatchObject({
      chain: "ethereum",
      assetAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
      details: {
        assetAddressMatchesExpected: true,
      },
    });
  });
});
