import { describe, expect, it } from "vitest";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { computeLiveReserveConfigFingerprint, parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../../lib/live-reserves/store-shared";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";
import type { AdapterResult } from "../types";
import { finalizeErc4626RedemptionCapacity } from "../erc4626-redemption-capacity";
import {
  installErc4626Network,
  runTrackedVault,
  type Erc4626RpcFixture,
} from "./erc4626-single-asset.test-support";

// Generic underlying-token fixture; not Maple's reviewed pooled claim.
function asUnderlyingFixture(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config);
  delete cloned.params!.pooledClaim;
  cloned.params!.slice = {
    ...(cloned.params!.slice as object),
    coinId: "usdc-circle",
    depType: "wrapper",
  };
  return cloned;
}

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

// Opaque pooled-claim disclosure is independent of redemption mechanics.
function nonInfoWarnings(warnings: readonly LiveReserveWarning[] | undefined): readonly LiveReserveWarning[] {
  return (warnings ?? []).filter((warning) => warning.effect !== "info");
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
function mockYearnV3Rpc(isShutdownRaw?: bigint | number, pausedRaw?: bigint | number) {
  const strategyA = "0x1111111111111111111111111111111111111111";
  const strategyB = "0x2222222222222222222222222222222222222222";
  const vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b";
  installErc4626Network({
    idleBalance: 5_000_000n,
    shutdown: isShutdownRaw,
    paused: pausedRaw,
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

function installTrackedMorphoV2(
  id: string,
  warnings: unknown,
  fixture: Erc4626RpcFixture = {},
  vaultOverrides: Record<string, unknown> = {},
) {
  const coin = TRACKED_META_BY_ID.get(id)!;
  const config = coin.liveReservesConfig!;
  const params = parseLiveReserveAdapterParams("erc4626-single-asset", config.params);
  const primary = config.inputs.primary;
  if (primary.kind !== "onchain-evm" || params.redemptionLiquidity?.source !== "morpho-vault-v2") {
    throw new Error(`Missing tracked Morpho V2 fixture for ${id}`);
  }
  const vault = coin.contracts!.find((contract) => contract.chain === primary.chain)!.address;
  const asset = params.slice.expectedAssetAddress!;
  const chainId = params.redemptionLiquidity.chainId;
  installErc4626Network({
    chain: primary.chain,
    vault,
    asset,
    paused: 0,
    ...fixture,
    extraHandlers: [({ url, call }) => {
      if (call?.data === "0xad468d11") return jsonResponse({ result: uint256Result(1) });
      if (url !== "https://api.morpho.org/graphql") return undefined;
      return jsonResponse({ data: { vaultV2ByAddress: {
        address: vault, asset: { address: asset }, chain: { id: chainId }, listed: true,
        liquidity: "90000000", liquidityUsd: 90, warnings,
        ...vaultOverrides,
      } } });
    }],
  });
}

function trackedVaultSnapshot(id: string, result: AdapterResult) {
  const coin = TRACKED_META_BY_ID.get(id)!;
  return {
    stablecoinId: id,
    slices: result.slices,
    fetchedAt: Math.floor(Date.now() / 1000),
    attemptId: "morpho-test-success",
    source: coin.liveReservesConfig!.adapter,
    metadata: result.metadata ?? {},
    warnings: result.warnings ?? [],
    warningCount: result.warnings?.length ?? 0,
    adapterSourceModel: "single-bucket" as const,
    adapterEvidenceClass: "independent" as const,
    configFingerprint: computeLiveReserveConfigFingerprint(coin.liveReservesConfig!),
  };
}

function trackedVaultSyncState(snapshot: { fetchedAt: number; attemptId: string }) {
  return { lastSuccessAt: snapshot.fetchedAt, lastSuccessAttemptId: snapshot.attemptId };
}

describe("fetchErc4626SingleAssetReserves", () => {

  it.each([0n, 25_000_000n, 100_000_000n, null])(
    "keeps Maple's pooled claim opaque regardless of observed idle cash %s",
    async (idleBalance) => {
      installErc4626Network({ idleBalance });
      const result = await runTrackedVault("syrupusdc-maple");
      expect(result.slices).toEqual([{
        sourceKey: "erc4626-single-asset:ethereum:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b:pooled-claim",
        name: "Maple syrupUSDC pooled loans and strategy claim",
        pct: 100,
        risk: "medium",
        assetClass: "protocol-position",
      }]);
      expect(result.metadata?.unknownExposurePct).toBe(100);
      const coin = TRACKED_META_BY_ID.get("syrupusdc-maple")!;
      const dependencies = deriveEffectiveDependencySet(coin, { liveReserveSlices: result.slices });
      expect(dependencies.mappedLiveReserveWeight).toBe(0);
      expect(dependencies.baseSource).toBe("live-unmapped");
      expect(result.metadata).not.toHaveProperty("deployedExposureBasis");
    },
  );


  it("separates held collateral from deployed strategy exposure without a reviewed attestation", async () => {
    const balanceOfCalls: Array<{ to?: string; data: string }> = [];
    installErc4626Network({ extraHandlers: [({ call }) => {
      if (call?.data.startsWith("0x70a08231")) balanceOfCalls.push(call);
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", asUnderlyingFixture);

    expect(result.slices).toEqual([
      {
        sourceKey: "erc4626-single-asset:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        name: "Maple syrupUSDC idle underlying",
        pct: 25,
        risk: "medium",
        coinId: "usdc-circle",
        depType: "wrapper",
      },
      {
        sourceKey: "erc4626-single-asset:ethereum:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b:deployed",
        name: "Maple syrupUSDC deployed strategy positions",
        pct: 75,
        risk: "high",
      },
    ]);
    expect(nonInfoWarnings(result.warnings)).toEqual([]);
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
        routeStatus: "unknown",
      },
    });
    expect(balanceOfCalls).toHaveLength(1);
    expect(balanceOfCalls[0]?.to?.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(balanceOfCalls[0]?.data).toContain("80ac24aa929eaf5013f6436cda2a7ba190f5cc0b");
  });

  it.each(["coinId", "depType", "deployedExposure"])(
    "rejects a pooled claim coupled to a token allocation via %s",
    async (field) => {
      installErc4626Network();
      await expect(runTrackedVault("syrupusdc-maple", (config) => {
        const cloned = structuredClone(config);
        if (field === "deployedExposure") {
          cloned.params!.deployedExposure = {
            basis: "Invalid allocation of a pooled claim to its denomination",
            reviewedAt: "2026-10-01",
          };
        } else {
          cloned.params!.slice = {
            ...(cloned.params!.slice as object),
            [field]: field === "coinId" ? "usdc-circle" : "wrapper",
          };
        }
        return cloned;
      })).rejects.toThrow("Opaque pooled claims");
    },
  );

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
      },
    });
    expect(result.metadata).not.toHaveProperty("assetAddress");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).not.toHaveProperty("freshnessKind");
  });

  it("suppresses redemption capacity when underlying decimals are invalid", async () => {
    installErc4626Network({ decimals: 37 });

    const result = await runTrackedVault("syrupusdc-maple");

    expect(result.metadata).toMatchObject({
      assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      redemption: {
        capacityKind: "documented-eventual",
        routeStatus: "unknown",
      },
    });
    expect(result.metadata).not.toHaveProperty("idleUnderlyingBalanceRaw");
    expect(result.metadata).not.toHaveProperty("underlyingDecimals");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
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

  it("withholds route openness on positive capacity when the vault pause probe is unreadable", async () => {
    installErc4626Network();

    const result = await runTrackedVault("syrupusdc-maple");

    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "25000000",
      underlyingDecimals: 6,
      redemption: {
        capacityUsd: 25,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusReason");
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
        routeStatusSource: "onchain",
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
        routeStatus: "unknown",
      },
    });
  });

  it("uses Yearn V3 default-queue withdrawable capacity when configured", async () => {
    mockYearnV3Rpc();

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "yearn-v3-withdrawable", settlementDelaySec: 0 }));

    expect(nonInfoWarnings(result.warnings)).toEqual([]);
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
        settlementDelaySec: 0,
      },
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
  });

  it("opens the Yearn V3 route when withdrawable capacity is positive and isShutdown() is false", async () => {
    mockYearnV3Rpc(0, 0);

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "yearn-v3-withdrawable", settlementDelaySec: 0 }));

    expect(nonInfoWarnings(result.warnings)).toEqual([]);
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
        routeStatusSource: "onchain",
      },
    });
  });

  it("uses sBOLD Stability-Pool-withdrawable capacity from calcFragments instead of the ~0 idle balance", async () => {
    const calcFragmentsCalls: Array<{ to?: string; data: string }> = [];
    installErc4626Network({ idleBalance: 1_000_000n, paused: 0, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") {
        calcFragmentsCalls.push(call);
        return jsonResponse({ result: calcFragmentsResult(85_000_000n) });
      }
      if (call?.data === "0xbf2428e6") return jsonResponse({ result: uint256Result(7_500_000n) });
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

    expect(nonInfoWarnings(result.warnings)).toEqual([]);
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

    expect(nonInfoWarnings(result.warnings)).toEqual([]);
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

  it.each(["maxCollInBold", "collInBold"] as const)("withholds sBOLD route openness when %s is unreadable", async (unreadable) => {
    installErc4626Network({ idleBalance: 1_000_000n, paused: 0, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") {
        const result = calcFragmentsResult(85_000_000n);
        return jsonResponse({ result: unreadable === "collInBold" ? result.slice(0, 2 + 3 * 64) : result });
      }
      if (call?.data === "0xbf2428e6") {
        return unreadable === "maxCollInBold" ? null : jsonResponse({ result: uint256Result(7_500_000n) });
      }
      return undefined;
    }] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "sbold-collateral-health-unavailable",
      effect: "info",
    }));
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 85,
      capacityRatioOfSupply: 0.85,
      capacityKind: "documented-bound",
      freshnessKind: "same-run-onchain",
      routeStatus: "unknown",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
  });

  it.each(["open", "restricted", "unreadable"] as const)("preserves an observed sBOLD pause with a %s collateral-health gate", async (gate) => {
    installErc4626Network({ idleBalance: 1_000_000n, paused: 1, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") return jsonResponse({ result: calcFragmentsResult(85_000_000n, gate === "restricted" ? 7_500_001n : 0n) });
      if (call?.data === "0xbf2428e6") return gate === "unreadable" ? null : jsonResponse({ result: uint256Result(7_500_000n) });
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "erc4626-redemption-paused",
      effect: "degraded",
    }));
  });

  it("withholds sBOLD route openness when the vault pause probe is unreadable", async () => {
    installErc4626Network({ idleBalance: 1_000_000n, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") return jsonResponse({ result: calcFragmentsResult(85_000_000n) });
      if (call?.data === "0xbf2428e6") return jsonResponse({ result: uint256Result(7_500_000n) });
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

    expect(result.metadata).toMatchObject({
      redemptionCapacitySource: "sbold-sp-withdrawable",
      sboldSpWithdrawableRaw: "85000000",
      redemption: {
        capacityUsd: 85,
        routeStatus: "unknown",
      },
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusReason");
  });

  it("degrades sBOLD to the idle balance when the calcFragments probe cannot be decoded", async () => {
    installErc4626Network({ idleBalance: 1_000_000n, extraHandlers: [({ call }) => {
      if (call?.data === "0x160b71df") return jsonResponse({ result: "0x" });
      if (call?.data === "0xbf2428e6") return null;
      return undefined;
    }] });

    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "sbold-sp-withdrawable" }));

    expect(nonInfoWarnings(result.warnings)).toEqual([
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
        routeStatus: "unknown",
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
    installErc4626Network({ idleBalance: 0, extraHandlers: [({ url, body, call }) => {
      if (call?.data === "0xad468d11") return jsonResponse({ result: uint256Result(1) });
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
    expect(nonInfoWarnings(result.warnings)).toEqual([]);
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
        routeStatus: "unknown",
      },
    });
    expect(morphoVariables).toEqual([{ address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", chainId: 1 }]);
  });

  it("falls back to idle capacity and degrades when Morpho V2 identity validation fails", async () => {
    installErc4626Network({ extraHandlers: [({ url, call }) => {
      if (call?.data === "0xad468d11") return jsonResponse({ result: uint256Result(1) });
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

    expect(nonInfoWarnings(result.warnings)).toEqual([
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
        routeStatus: "unknown",
      },
    });
    expect(result.metadata).not.toHaveProperty("morphoVaultV2LiquidityRaw");
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
  });

  it("does not label an EUR underlying balance as USD capacity without FX valuation", async () => {
    const asset = "0x5f7827fdeb7c20b443265fc2f40845b715385ff2";
    installErc4626Network({ asset });
    const result = await runTrackedVault("syrupusdc-maple", (config) => {
      const cloned = asUnderlyingFixture(config);
      cloned.params!.slice = {
        ...(cloned.params!.slice as object),
        coinId: "eurcv-societe-generale-forge",
        expectedAssetAddress: asset,
      };
      return cloned;
    });
    expect(result.metadata).not.toHaveProperty("redemption.capacityUsd");
    expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "erc4626-capacity-non-usd-unvalued", effect: "info" }),
    ]));
    expect(result.metadata?.totalAssetsRaw).toBe("100000000");
  });

  it.each([
    { adapter: 0n, idle: 25_000_000n, reason: "zero", capacityUsd: 25 },
    { adapter: 0n, idle: 0n, reason: "zero", capacityUsd: 0 },
    { adapter: null, idle: 25_000_000n, reason: "unavailable", capacityUsd: 25 },
    { adapter: 1n << 160n, idle: 25_000_000n, reason: "unavailable", capacityUsd: 25 },
    { adapter: null, idle: null, reason: "unavailable", capacityUsd: null },
  ])("bounds Morpho V2 liquidity to readable idle when its adapter is $reason (idle $idle)", async ({
    adapter, idle, reason, capacityUsd,
  }) => {
    installErc4626Network({ idleBalance: idle, extraHandlers: [({ url, call }) => {
      if (call?.data === "0xad468d11") {
        return adapter == null ? null : jsonResponse({ result: uint256Result(adapter) });
      }
      if (url !== "https://api.morpho.org/graphql") return undefined;
      return jsonResponse({ data: { vaultV2ByAddress: {
        address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
        listed: true,
        asset: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
        chain: { id: 1 },
        liquidity: "90000000",
        liquidityUsd: 90,
        warnings: [],
      } } });
    }] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }));
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: `morpho-vault-v2-liquidity-adapter-${reason}` }),
    ]));
    expect(result.metadata).not.toHaveProperty("morphoVaultV2LiquidityRaw");
    if (capacityUsd == null) {
      expect(result.metadata).not.toHaveProperty("redemption.capacityUsd");
      expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
    } else {
      expect(result.metadata).toMatchObject({
        redemptionCapacitySource: "erc4626-idle-underlying",
        redemption: { capacityUsd, freshnessKind: "same-run-onchain" },
      });
    }
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

    expect(nonInfoWarnings(result.warnings)).toEqual([
      expect.objectContaining({
        code: "erc4626-nav-divergence",
        severity: "warning",
      }),
    ]);
    expect(result.metadata?.details?.navConsistencyRatio).toBeCloseTo(1.1, 2);
    expect(result.metadata?.redemption?.routeStatus).toBe("unknown");
  });

  it("uses explicit RPC URLs for ERC-4626 vaults on chains without registry RPCs", async () => {
    const scenario = catalogCases[0];
    installErc4626Network({ asset: scenario.asset, vault: scenario.vault, idleBalance: 0, decimals: 18 });

    const result = await runTrackedVault(scenario.id);

    expect(result.slices).toEqual([{ sourceKey: "erc4626-single-asset:plasma:0xc8a8df9b210243c55d31c73090f06787ad0a1bf6:deployed", name: "Staked Yuzu USD deployed strategy positions", pct: 100, risk: "high" }]);
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

    expect(result.slices).toEqual([{ sourceKey: "erc4626-single-asset:avalanche:0x06d47f3fb376649c3a9dafe069b3d6e35572219e:deployed", name: "Avant Staked USD deployed strategy positions", pct: 100, risk: "high" }]);
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

    expect(result.slices).toEqual([{ sourceKey: "erc4626-single-asset:ethereum:0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003:deployed", name: "Strata Senior USDe deployed strategy positions", pct: 100, risk: "high" }]);
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

describe("Morpho V2 operational conditions and composition admission", () => {
  it.each([
    { id: "steakusdg-steakhouse", type: "deposit_disabled", level: "RED", code: "morpho-vault-v2-deposit-disabled", status: "unknown" },
    { id: "krusdc-keyrock", type: "low_liquidity", level: "YELLOW", code: "morpho-vault-v2-low-liquidity", status: "degraded" },
  ])("admits complete $id composition without expanding idle capacity", async ({ id, type, level, code, status }) => {
    installTrackedMorphoV2(id, [{ type, level }]);
    const result = await runTrackedVault(id);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code, effect: "info" }));
    expect(nonInfoWarnings(result.warnings)).toEqual([]);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({ pct: 100, risk: "high", depType: "wrapper" });
    expect(result.metadata).toMatchObject({
      unknownExposurePct: 0,
      redemptionCapacityRaw: "25000000",
      redemptionCapacitySource: "erc4626-idle-underlying",
      redemption: {
        capacityUsd: 25, freshnessKind: "same-run-onchain", routeStatus: status,
        observerDiagnostics: { morphoWarnings: [{ type, level }] },
      },
    });
    expect(result.metadata).not.toHaveProperty("morphoVaultV2LiquidityRaw");
    if (status === "degraded") {
      expect(result.metadata?.redemption?.routeStatusSource).toBe("protocol-api");
    } else {
      expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
    }
    const validation = expectValidAdapterOutput("erc4626-single-asset", result, { subjectId: id });
    expect(nonInfoWarnings(validation.warnings)).toEqual([]);
    const coin = TRACKED_META_BY_ID.get(id)!;
    const snapshot = trackedVaultSnapshot(id, result);
    const syncState = trackedVaultSyncState(snapshot);
    expect(evaluateLiveReserveAdmission(snapshot, syncState, coin, snapshot.fetchedAt).eligible).toBe(true);
    expect(evaluateLiveReserveAdmission(snapshot, { ...syncState, lastSuccessAttemptId: "different-attempt" }, coin, snapshot.fetchedAt).reasons).toContain("inconsistent-snapshot");
    expect(evaluateLiveReserveAdmission(snapshot, syncState, coin, snapshot.fetchedAt + LIVE_RESERVE_FRESHNESS_SEC + 1).reasons).toContain("stale");
    expect(evaluateLiveReserveAdmission({ ...snapshot, configFingerprint: "old-config" }, syncState, coin, snapshot.fetchedAt).reasons).toContain("config-mismatch");
    expect(evaluateLiveReserveAdmission({
      ...snapshot,
      metadata: { ...snapshot.metadata, freshnessMode: "verified", sourceTimestamp: snapshot.fetchedAt - LIVE_RESERVE_FRESHNESS_SEC - 1 },
    }, syncState, coin, snapshot.fetchedAt).reasons).toContain("stale");
  });

  it.each([
    { id: "steakusdg-steakhouse", warnings: null },
    { id: "krusdc-keyrock", warnings: null },
    { id: "steakusdg-steakhouse", warnings: undefined },
    { id: "krusdc-keyrock", warnings: undefined },
  ])("admits healthy $id with a nullish warning list $warnings", async ({ id, warnings }) => {
    installTrackedMorphoV2(id, warnings);
    const result = await runTrackedVault(id);
    expect(nonInfoWarnings(result.warnings)).toEqual([]);
    expect(result.metadata).toMatchObject({
      unknownExposurePct: 0,
      morphoVaultV2LiquidityRaw: "90000000",
      redemptionCapacityRaw: "90000000",
      redemptionCapacitySource: "morpho-vault-v2-liquidity",
      redemption: {
        capacityUsd: 90,
        freshnessKind: "same-run-api",
        routeStatus: "open",
        routeStatusSource: "protocol-api",
      },
    });
    const validation = expectValidAdapterOutput("erc4626-single-asset", result, { subjectId: id });
    expect(nonInfoWarnings(validation.warnings)).toEqual([]);
    const snapshot = trackedVaultSnapshot(id, result);
    expect(evaluateLiveReserveAdmission(
      snapshot, trackedVaultSyncState(snapshot), TRACKED_META_BY_ID.get(id), snapshot.fetchedAt,
    ).eligible).toBe(true);
  });

  it.each([
    { warnings: [{ type: "unknown", level: "RED" }] },
    { warnings: [{ type: "deposit_disabled", level: "RED" }, { type: "bad_debt", level: "RED" }] },
    { warnings: [{ type: "bad_debt", level: "RED" }, { type: "low_liquidity", level: "YELLOW" }] },
    { warnings: [{ type: "deposit_disabled", level: "YELLOW" }] },
    { warnings: [{ type: "low_liquidity", level: "RED" }] },
    { warnings: [{ type: "low_liquidity" }] },
    { warnings: [null] },
    { warnings: "malformed" },
    { warnings: {} },
  ])("rejects unknown, wrong-level or malformed warnings %j", async ({ warnings }) => {
    const id = "krusdc-keyrock";
    installTrackedMorphoV2(id, warnings);
    const result = await runTrackedVault(id);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "morpho-vault-v2-warning", effect: "degraded" }));
    expect(result.metadata?.redemption?.capacityUsd).toBe(25);
    expect(result.metadata).not.toHaveProperty("morphoVaultV2LiquidityRaw");
    const snapshot = trackedVaultSnapshot(id, result);
    expect(evaluateLiveReserveAdmission(snapshot, trackedVaultSyncState(snapshot), TRACKED_META_BY_ID.get(id), snapshot.fetchedAt).reasons).toContain("degraded-snapshot");
    expect(result.metadata?.redemption?.routeStatus).not.toBe("open");
  });

  it.each([0n, 25_000_000n])("retains protocol-API low-liquidity state for observed idle %s", async (idleBalance) => {
    installTrackedMorphoV2("krusdc-keyrock", [{ type: "low_liquidity", level: "YELLOW" }], { idleBalance });
    const result = await runTrackedVault("krusdc-keyrock");
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: Number(idleBalance) / 1e6, routeStatus: "degraded",
      freshnessKind: "same-run-onchain", routeStatusSource: "protocol-api",
    });
  });

  it("keeps onchain pause ahead of API low liquidity while admitting complete composition", async () => {
    const id = "krusdc-keyrock";
    installTrackedMorphoV2(id, [{ type: "low_liquidity", level: "YELLOW" }], { paused: 1 });
    const result = await runTrackedVault(id);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-redemption-paused", effect: "info" }));
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 25, routeStatus: "paused", routeStatusSource: "onchain" });
    const snapshot = trackedVaultSnapshot(id, result);
    expect(evaluateLiveReserveAdmission(snapshot, trackedVaultSyncState(snapshot), TRACKED_META_BY_ID.get(id), snapshot.fetchedAt).eligible).toBe(true);
  });

  it("does not exempt missing idle attribution or fabricate capacity", async () => {
    const id = "krusdc-keyrock";
    installTrackedMorphoV2(id, [{ type: "low_liquidity", level: "YELLOW" }], { idleBalance: null });
    const result = await runTrackedVault(id);
    expect(result.metadata).toMatchObject({ unknownExposurePct: 100, redemption: { routeStatus: "degraded", routeStatusSource: "protocol-api" } });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-idle-balance-unavailable", effect: "degraded" }));
    const snapshot = trackedVaultSnapshot(id, result);
    expect(evaluateLiveReserveAdmission(snapshot, trackedVaultSyncState(snapshot), TRACKED_META_BY_ID.get(id), snapshot.fetchedAt).reasons).toContain("degraded-snapshot");
  });

  it("keeps NAV divergence a composition defect without inferring withdrawal impairment", async () => {
    const id = "steakusdg-steakhouse";
    installTrackedMorphoV2(id, [{ type: "deposit_disabled", level: "RED" }], { convertedAssets: 110_000_000n });
    const result = await runTrackedVault(id);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-nav-divergence", effect: "degraded" }));
    expect(result.metadata?.redemption?.routeStatus).toBe("unknown");
    const snapshot = trackedVaultSnapshot(id, result);
    expect(evaluateLiveReserveAdmission(snapshot, trackedVaultSyncState(snapshot), TRACKED_META_BY_ID.get(id), snapshot.fetchedAt).reasons).toContain("degraded-snapshot");
  });

  it("does not exempt a warned API payload with an identity mismatch or malformed amount", async () => {
    const id = "steakusdg-steakhouse";
    for (const vaultOverrides of [
      { address: "0x000000000000000000000000000000000000dead" },
      { asset: { address: "0x000000000000000000000000000000000000dead" } },
      { liquidity: "invalid" },
      { liquidityUsd: "invalid" },
      { forceDeallocatableLiquidity: "invalid" },
      { listed: false },
    ]) {
      installTrackedMorphoV2(id, [{ type: "deposit_disabled", level: "RED" }], {}, vaultOverrides);
      const result = await runTrackedVault(id);
      expect(nonInfoWarnings(result.warnings)).not.toEqual([]);
      const snapshot = trackedVaultSnapshot(id, result);
      expect(evaluateLiveReserveAdmission(snapshot, trackedVaultSyncState(snapshot), TRACKED_META_BY_ID.get(id), snapshot.fetchedAt).reasons).toContain("degraded-snapshot");
    }
  });

  it("does not infer route impairment from an unrelated NAV warning", async () => {
    installErc4626Network({ paused: 0, convertedAssets: 110_000_000n });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-nav-divergence", effect: "degraded" }));
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 25, routeStatus: "open", routeStatusSource: "onchain" });
  });

  it("retains a known low-liquidity diagnosis even when an earlier unknown tag rejects composition", async () => {
    installTrackedMorphoV2("krusdc-keyrock", [
      { type: "bad_debt", level: "RED" },
      { type: "low_liquidity", level: "YELLOW" },
    ]);
    const result = await runTrackedVault("krusdc-keyrock");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "morpho-vault-v2-warning", effect: "degraded" }));
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 25, routeStatus: "degraded", routeStatusSource: "protocol-api" });
  });
});

describe("sfrxUSD generic completion boundary", () => {
  it.each([0n, 500_000_000n])("never turns remote withdrawability or idle %s into generic unbounded capacity", (idleCapacityRaw) => {
    const telemetry = finalizeErc4626RedemptionCapacity({
      supplyAssetsRaw: 1_000_000_000n,
      idleCapacityRaw,
      pause: { paused: false, shutdown: null },
      configured: {
        source: "fraxtal-hop-withdrawable", capacityRaw: 100_000_000n, underlyingDecimals: 6,
        warnings: [], diagnostics: {}, telemetry: {},
        route: {
          freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain",
          capacityKind: "documented-bound", settlementBoundUnproven: true,
          sourceTimestamp: 1_790_000_000,
        },
      },
    });
    expect(telemetry).toBeNull();
  });
});

describe("ERC-4626 held versus deployed exposure", () => {
  it("does not claim USDC holdings for YieldFi's zero-idle live observation", async () => {
    installErc4626Network({
      vault: "0x19ebd191f7a24ece672ba13a302212b5ef7f35cb",
      totalAssets: 10_696_286_730_934n,
      convertedAssets: 10_696_286_730_934n,
      idleBalance: 0n,
    });
    const result = await runTrackedVault("yusd-yieldfi");
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, risk: "high" })]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.metadata?.unknownExposurePct).toBe(100);
  });

  it("attributes only measured idle USDC while retaining the deployed remainder", async () => {
    installErc4626Network({ idleBalance: 25_000_000n });
    const result = await runTrackedVault("syrupusdc-maple", asUnderlyingFixture);
    expect(result.slices).toEqual([
      expect.objectContaining({ pct: 25, coinId: "usdc-circle" }),
      expect.objectContaining({ pct: 75, risk: "high" }),
    ]);
    expect(result.slices[1]).not.toHaveProperty("coinId");
    expect(result.slices[1]).not.toHaveProperty("depType");
    expect(result.metadata?.unknownExposurePct).toBe(75);
    expect(result.metadata).not.toHaveProperty("deployedPct");
  });

  it.each([100_000_000n, 120_000_000n])("keeps a single underlying slice when holdings cover totalAssets (%s)", async (idleBalance) => {
    installErc4626Network({ idleBalance });
    const result = await runTrackedVault("syrupusdc-maple", asUnderlyingFixture);
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, coinId: "usdc-circle", risk: "medium" })]);
    expect(result.metadata?.unknownExposurePct).toBe(0);
  });

  it("does not invent an idle holding when the balance probe is unreadable", async () => {
    installErc4626Network({ idleBalance: null });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, assetClass: "protocol-position" })]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.metadata?.unknownExposurePct).toBe(100);
    expect(result.metadata).not.toHaveProperty("deployedPct");
    expect(result.metadata).not.toHaveProperty("deployedExposureBasis");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-idle-balance-unavailable", effect: "degraded" }));
  });
});
