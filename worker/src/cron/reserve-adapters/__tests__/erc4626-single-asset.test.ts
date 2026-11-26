import { LIVE_RESERVE_FRESHNESS_SEC } from "../../../lib/live-reserve-policy";
import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem/utils";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { computeLiveReserveConfigFingerprint, parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";
import { buildReviewedReserveClassifications } from "../../../lib/safety-score-v9/extension-reserves";
import { computeSafetyScoreV9ReserveExposureKey } from "../../../lib/safety-score-v9/fact-set";
import { expectValidAdapterOutput, runAdapterWithFakeTimers } from "./reserve-adapter.test-support";
import type { RedemptionCapacityTelemetry } from "../erc4626-capacity-observation";
import { rpowRay } from "../erc4626-capacity-stusds";
import {
  finalizeErc4626RedemptionCapacity, projectErc4626RedemptionMetadata, projectErc4626RedemptionTelemetry,
} from "../erc4626-redemption-capacity";
import {
  admission,
  asUnderlyingFixture,
  buildMorphoFailureCases,
  calcFragmentsResult,
  CATALOG_CASES as catalogCases,
  cloneConfigWithoutExpectedAsset,
  getErc4626Network,
  installErc4626Network,
  installSbold,
  installTrackedMorphoV2,
  makeMorphoCacheDb,
  mockLocks,
  mockYearnV3Rpc,
  morphoReadJson,
  nonInfoWarnings,
  RAY,
  resetErc4626NetworkForTests,
  runTrackedVault,
  STUSDS_WIRING,
  stusdsHandlers,
  trackedVaultSnapshot,
  trackedVaultSyncState,
  uint256Result,
  withLocks,
  withRedemptionLiquidity,
} from "./erc4626-single-asset.test-support";
import { resolveRedemptionCapacity } from "../../../lib/redemption-backstop/capacity";
import { liveSnapshot } from "../../../lib/__tests__/redemption-backstop-sources.test-support";

describe("fetchErc4626SingleAssetReserves", () => {

  it("drops the installed network so a later shared-cache file starts from the default fixture", () => {
    installErc4626Network({ chain: "base" });
    expect(getErc4626Network()?.chainRpcs.has("base")).toBe(true);
    resetErc4626NetworkForTests();
    expect(getErc4626Network()).toBeUndefined();
  });

  it.each([0n, 630_000_000_000_000_000n, 150_000_000_000_000_000_000n])(
    "excludes sDAI wallet donations from reviewed Pot backing: %s",
    async (idleBalance) => {
      const vault = "0x83f20f44975d03b1b09e64809b757c47f942beea";
      const asset = "0x6b175474e89094c44da98b954eedeac495271d0f";
      const accountedAssets = 100_000_000_000_000_000_000n;
      installErc4626Network({
        vault, asset, idleBalance, decimals: 18,
        totalAssets: accountedAssets, totalSupply: accountedAssets, convertedAssets: accountedAssets,
      });
      const walletCashAccounting = {
        mode: "excluded" as const,
        basis: "SavingsDai totalAssets counts Pot pie/chi; burns exit Pot and DaiJoin, never vault-held DAI donations.",
        reviewedAt: "2026-10-20",
        sourceUrl: `https://eth.blockscout.com/api/v2/smart-contracts/${vault}`,
      };
      const previous = structuredClone(TRACKED_META_BY_ID.get("sdai-sky")!.liveReservesConfig!);
      delete previous.params!.walletCashAccounting;
      const corrected = { ...previous, params: { ...previous.params, walletCashAccounting } };
      expect(parseLiveReserveAdapterParams("erc4626-single-asset", corrected.params).walletCashAccounting)
        .toEqual(walletCashAccounting);
      expect(computeLiveReserveConfigFingerprint(corrected))
        .not.toBe(computeLiveReserveConfigFingerprint(previous));

      const result = await runTrackedVault("sdai-sky", () => corrected);
      expect(result.slices).toEqual([expect.objectContaining({
        sourceKey: `erc4626-single-asset:ethereum:${vault}:deployed`,
        coinId: "dai-makerdao", depType: "wrapper", pct: 100,
      })]);
      expect(result.metadata).toMatchObject({
        totalAssetsRaw: accountedAssets.toString(),
        idleUnderlyingBalanceRaw: idleBalance.toString(),
        deployedPct: 100,
        unknownExposurePct: 0,
        details: { walletCashAccounting },
      });
    },
  );

  it("fails closed when the idle balance exceeds totalAssets instead of clamping to a 100% idle mix", async () => {
    const totalAssets = 414_526_138_576_951_556_405_870_020n;
    installErc4626Network({
      vault: "0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf",
      asset: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
      decimals: 18,
      totalAssets,
      totalSupply: totalAssets,
      convertedAssets: totalAssets,
      idleBalance: totalAssets + totalAssets / 100n,
    });

    await expect(runTrackedVault("senrlusdv2-sentora")).rejects.toThrow(/exceeds totalAssets/);
  });

  it("still absorbs a rounding-wei overage above totalAssets as fully idle", async () => {
    const totalAssets = 414_526_138_576_951_556_405_870_020n;
    installErc4626Network({
      vault: "0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf",
      asset: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
      decimals: 18,
      totalAssets,
      totalSupply: totalAssets,
      convertedAssets: totalAssets,
      idleBalance: totalAssets + 1n,
    });

    const result = await runTrackedVault("senrlusdv2-sentora");

    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: (totalAssets + 1n).toString(),
      deployedPct: 0,
      unknownExposurePct: 0,
    });
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, coinId: "rlusd-ripple", depType: "wrapper" })]);
  });

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
    installSbold({ paused: 0, onFragments: (call) => calcFragmentsCalls.push(call) });

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
    installSbold({ fragments: calcFragmentsResult(85_000_000n, 7_500_001n) });

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
    const fragments = calcFragmentsResult(85_000_000n);
    installSbold({
      paused: 0,
      fragments: unreadable === "collInBold" ? fragments.slice(0, 2 + 3 * 64) : fragments,
      maxCollateral: unreadable === "maxCollInBold" ? null : uint256Result(7_500_000n),
    });
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
    installSbold({
      paused: 1,
      fragments: calcFragmentsResult(85_000_000n, gate === "restricted" ? 7_500_001n : 0n),
      maxCollateral: gate === "unreadable" ? null : uint256Result(7_500_000n),
    });

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
    installSbold();

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
    installSbold({ fragments: "0x", maxCollateral: null });

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

  it("scores stUSDS unused funds instead of the encumbered idle balance", async () => {
    // Debt 50M x 1.2 = 60M plus 5M owed in auction leaves 35M withdrawable.
    installErc4626Network({ idleBalance: 100_000_000n, extraHandlers: [
      stusdsHandlers({ art: 50_000_000n, rate: 12n * RAY / 10n, dueRad: 5_000_000n * RAY }),
    ] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "stusds-unused-funds", ...STUSDS_WIRING }));
    expect(nonInfoWarnings(result.warnings)).toEqual([]);
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "100000000",
      redemptionCapacityRaw: "35000000",
      redemptionCapacitySource: "stusds-unused-funds",
      stusdsUnusedFundsRaw: "35000000",
      redemption: { capacityUsd: 35, capacityRatioOfSupply: 0.35, capacityKind: "live-direct", freshnessKind: "same-run-onchain" },
    });
  });

  it("accrues the Jug rate to the read block before netting stUSDS debt", async () => {
    // A 1%-per-second duty one second stale lifts 50M x 1.0 to 50.5M of debt.
    installErc4626Network({ idleBalance: 100_000_000n, extraHandlers: [
      stusdsHandlers({ art: 50_000_000n, rate: RAY, duty: RAY + RAY / 100n, rhoOffsetSec: 1n }),
    ] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "stusds-unused-funds", ...STUSDS_WIRING }));
    expect(result.metadata).toMatchObject({ redemptionCapacityRaw: "49500000", redemptionCapacitySource: "stusds-unused-funds" });
  });

  it("publishes zero stUSDS capacity at full utilization rather than the idle balance", async () => {
    installErc4626Network({ idleBalance: 100_000_000n, extraHandlers: [
      stusdsHandlers({ art: 100_000_000n, rate: RAY }),
    ] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "stusds-unused-funds", ...STUSDS_WIRING }));
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "100000000",
      redemptionCapacityRaw: "0",
      redemptionCapacitySource: "stusds-unused-funds",
      stusdsUnusedFundsRaw: "0",
      redemption: { capacityUsd: 0, capacityRatioOfSupply: 0 },
    });
  });

  it("matches DSMath rpow rounding and refuses uint256 overflow", () => {
    expect(rpowRay(0n, 0n)).toBe(RAY);
    expect(rpowRay(0n, 5n)).toBe(0n);
    expect(rpowRay(RAY + RAY / 100n, 1n)).toBe(RAY + RAY / 100n);
    expect(rpowRay(RAY + RAY / 100n, 2n)).toBe(RAY * 10_201n / 10_000n);
    expect(rpowRay(2n * RAY, 7n)).toBe(128n * RAY);
    // Sky's 50% APY per-second rate compounds to ~1.5 RAY over one year.
    const yearGrowth = rpowRay(1_000_000_012_857_214_317_438_491_659n, 31_536_000n)!;
    expect(Number(yearGrowth * 1_000_000n / RAY) / 1_000_000).toBeCloseTo(1.5, 5);
    expect(rpowRay(2n * RAY, 20_000n)).toBeNull();
  });

  it("compounds a multi-second Jug accrual before netting stUSDS debt", async () => {
    // 1% per second for 3 seconds: 50M x 1.030301 = 51,515,050 of debt.
    installErc4626Network({ idleBalance: 100_000_000n, extraHandlers: [
      stusdsHandlers({ art: 50_000_000n, rate: RAY, duty: RAY + RAY / 100n, rhoOffsetSec: 3n }),
    ] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "stusds-unused-funds", ...STUSDS_WIRING }));
    expect(result.metadata).toMatchObject({ redemptionCapacityRaw: "48484950", redemptionCapacitySource: "stusds-unused-funds" });
  });

  it.each([
    ["a missing Clipper Due() word", { dropDue: true }],
    ["a Jug rho in the future", { rhoOffsetSec: -10n }],
  ] as const)("withholds stUSDS capacity on %s instead of publishing a measured zero", async (_label, fault) => {
    installErc4626Network({ idleBalance: 100_000_000n, extraHandlers: [
      ({ call }: { call?: { to?: string; data: string } }) =>
        "dropDue" in fault && call?.data === "0x08bf162f" ? jsonResponse({ result: "0x" }) : undefined,
      stusdsHandlers({ art: 10_000_000n, rate: RAY, ...("rhoOffsetSec" in fault ? { rhoOffsetSec: fault.rhoOffsetSec } : {}) }),
    ] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "stusds-unused-funds", ...STUSDS_WIRING }));
    expect(nonInfoWarnings(result.warnings)).toEqual([
      expect.objectContaining({ code: "stusds-unused-funds-unavailable", severity: "warning" }),
    ]);
    expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
  });

  it("withholds stUSDS capacity on an implausible Jug accrual age instead of publishing zero", async () => {
    installErc4626Network({ idleBalance: 100_000_000n, extraHandlers: [
      stusdsHandlers({ art: 10_000_000n, rate: RAY, rhoOffsetSec: 400n * 86_400n }),
    ] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "stusds-unused-funds", ...STUSDS_WIRING }));
    expect(nonInfoWarnings(result.warnings)).toEqual([
      expect.objectContaining({ code: "stusds-unused-funds-unavailable", severity: "warning" }),
    ]);
    expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
  });

  it("withholds stUSDS capacity on a wiring mismatch instead of falling back to idle USDS", async () => {
    installErc4626Network({ idleBalance: 100_000_000n, extraHandlers: [
      stusdsHandlers({ art: 10_000_000n, rate: RAY, vat: "0x1111111111111111111111111111111111111111" }),
    ] });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "stusds-unused-funds", ...STUSDS_WIRING }));
    expect(nonInfoWarnings(result.warnings)).toEqual([
      expect.objectContaining({ code: "stusds-wiring-mismatch", severity: "warning" }),
    ]);
    expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
    expect(result.metadata).not.toHaveProperty("stusdsUnusedFundsRaw");
  });

  it.each([
    {
      source: "morpho-vault-v1" as const, version: "v1" as const,
      statePath: "/v0/vaults-v1/1:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b/state",
      penalties: [],
      metadata: { morphoVaultV1LiquidityRaw: "30000000", morphoVaultV1LiquidityUsd: 30 },
    },
    {
      source: "morpho-vault-v2" as const, version: "v2" as const,
      statePath: "/v1/vaults-v2/1:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b/state",
      penalties: ["20000000", "15000000"],
      metadata: {
        morphoVaultV2LiquidityRaw: "30000000", morphoVaultV2LiquidityUsd: 30,
        morphoVaultV2ForceDeallocatableLiquidityRaw: "35000000", morphoVaultV2ForceDeallocatableLiquidityUsd: 35,
      },
    },
  ])("uses $source Read API liquidity rather than idle underlying balance", async ({ source, version, statePath, penalties, metadata }) => {
    const net = installErc4626Network({
      idleBalance: 0, liquidityAdapter: 1,
      json: morphoReadJson({
        version, withdrawable: "30000000", penalties,
        // Exercise cursor pagination across two directory pages.
        overrides: {
          [`https://api.morpho.org/v0/vaults-${version}?limit=1000`]: { data: [], cursor: "p2" },
          [`https://api.morpho.org/v0/vaults-${version}?limit=1000&cursor=p2`]: {
            data: [{ chain_id: 1, vault_address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", asset_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }],
            cursor: null,
          },
        },
      }),
    });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source, chainId: 1 }));
    expect(nonInfoWarnings(result.warnings)).toEqual([]);
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "0", redemptionCapacityRaw: "30000000",
      redemptionCapacitySource: `${source}-liquidity`, ...metadata, underlyingDecimals: 6,
      redemption: { capacityUsd: 30, capacityRatioOfSupply: 0.3, capacityKind: "live-direct", freshnessKind: "same-run-api", routeStatus: "unknown" },
    });
    expect(net.requests.some((r) => r.url.endsWith(statePath))).toBe(true);
  });

  it.each([30_000_000n, 0n])("does not promote donated MetaMorpho V1 wallet assets above API liquidity %s", async (liquidityRaw) => {
    installErc4626Network({ idleBalance: 50_000_000, json: morphoReadJson({ version: "v1", withdrawable: liquidityRaw.toString() }) });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v1", chainId: 1 }));
    expect(result.metadata).toMatchObject({
      idleUnderlyingBalanceRaw: "50000000", redemptionCapacityRaw: liquidityRaw.toString(), redemptionCapacitySource: "morpho-vault-v1-liquidity",
    });
  });

  it("withholds MetaMorpho V1 capacity when API liquidity is unavailable despite donated wallet assets", async () => {
    installErc4626Network({
      idleBalance: 50_000_000,
      json: morphoReadJson({ version: "v1", overrides: { "https://api.morpho.org/v0/vaults-v1/1:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b/state": { data: null } } }),
    });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v1", chainId: 1 }));
    expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
    expect(result.metadata).toMatchObject({ redemption: { capacityKind: "documented-eventual" } });
  });

  it("keeps MetaMorpho V1 donated wallet cash outside the accounted reserve composition", async () => {
    const id = "sparkusdc-spark";
    const coin = TRACKED_META_BY_ID.get(id)!;
    const params = parseLiveReserveAdapterParams("erc4626-single-asset", coin.liveReservesConfig!.params);
    const vault = coin.contracts!.find((c) => c.chain === "base")!.address;
    installErc4626Network({ chain: "base", vault, asset: params.slice.expectedAssetAddress, idleBalance: 150_000_000n });
    const result = await runTrackedVault(id);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({ sourceKey: `erc4626-single-asset:base:${vault.toLowerCase()}:deployed`, pct: 100 });
    expect(result.metadata?.deployedPct).toBe(100);
    expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
  });

  it.each(buildMorphoFailureCases())("fails closed on Morpho Read API $label", async ({ source, opts, blockTimestamp, code, callsState }) => {
    const net = installErc4626Network({ liquidityAdapter: 1, ...(blockTimestamp !== undefined ? { blockTimestamp } : {}), json: morphoReadJson(opts) });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source, chainId: 1 }));
    expect(nonInfoWarnings(result.warnings)).toEqual([expect.objectContaining({ code, severity: "warning" })]);
    expect(result.metadata).not.toHaveProperty("morphoVaultV2LiquidityRaw");
    expect(net.requests.some((r) => r.url.endsWith("/state"))).toBe(callsState);
    if (source === "morpho-vault-v1") {
      expect(result.metadata).not.toHaveProperty("redemptionCapacityRaw");
    } else {
      expect(result.metadata).toMatchObject({
        idleUnderlyingBalanceRaw: "25000000", redemptionCapacityRaw: "25000000", redemptionCapacitySource: "erc4626-idle-underlying",
        redemption: { capacityUsd: 25, capacityRatioOfSupply: 0.25, capacityKind: "live-direct", freshnessKind: "same-run-onchain", routeStatus: "unknown" },
      });
    }
  });

  it("isolates malformed peer rows, admits old V2 accrual at fresh block, requires valid price clock, and bounds shared diagnostic deadline", async () => {
    // Healthy peer survives an unrelated malformed row; old accrual passes when indexed block is fresh; string price clock emits USD.
    installErc4626Network({
      idleBalance: 0, liquidityAdapter: 1,
      json: morphoReadJson({
        version: "v2", withdrawable: "30000000", lastAccrualTimestamp: Math.floor(Date.now() / 1000) - 86_400,
        overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { data: [
          { chain_id: 1, vault_address: "0x000000000000000000000000000000000000beef", asset_address: "bad" },
          { chain_id: 1, vault_address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", asset_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
        ], cursor: null } },
      }),
    });
    const peerOk = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }));
    expect(nonInfoWarnings(peerOk.warnings)).toEqual([]);
    expect(peerOk.metadata).toMatchObject({ redemptionCapacityRaw: "30000000", morphoVaultV2LiquidityUsd: 30 });

    // HTTP 206, null/stale/future price timestamps suppress *LiquidityUsd while preserving capacityRaw.
    for (const priceOpts of [
      { priceStatus: 206 },
      { priceTimestamp: null },
      { omitPriceTimestamp: true },
      { priceTimestamp: String(Math.floor(Date.now() / 1000) - 90_000) },
      { priceTimestamp: String(Math.floor(Date.now() / 1000) + 600) },
    ]) {
      installErc4626Network({
        idleBalance: 0, liquidityAdapter: 1,
        json: morphoReadJson({
          version: "v2", withdrawable: "30000000", ...priceOpts,
          overrides: { "https://api.morpho.org/v0/vaults-v2/1:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b/withdrawal-options": { data: { chain_id: 8453, vault_address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", adapter_penalties: [] } } },
        }),
      });
      const r = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }));
      expect(nonInfoWarnings(r.warnings)).toEqual([]);
      expect(r.metadata?.redemptionCapacityRaw).toBe("30000000");
      expect(r.metadata).not.toHaveProperty("morphoVaultV2LiquidityUsd");
      expect(r.metadata).not.toHaveProperty("morphoVaultV2ForceDeallocatableLiquidityRaw");
    }

    // Near-expired attempt deadline skips optional diagnostics while preserving validated capacityRaw.
    const tightNet = installErc4626Network({ idleBalance: 0, liquidityAdapter: 1, json: morphoReadJson({ version: "v2", withdrawable: "30000000" }) });
    const tight = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { attemptDeadlineMs: Date.now() + 1_000 });
    expect(nonInfoWarnings(tight.warnings)).toEqual([]);
    expect(tight.metadata?.redemptionCapacityRaw).toBe("30000000");
    expect(tightNet.requests.some((r) => r.url.includes("/withdrawal-options") || r.url.includes("/tokens/"))).toBe(false);
  });

  it("retries Morpho Read API 5xx once and succeeds on retry, or fails closed after 2 attempts", async () => {
    const stateUrl = "https://api.morpho.org/v1/vaults-v2/1:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b/state";
    let attempts = 0;
    installErc4626Network({
      idleBalance: 0, liquidityAdapter: 1,
      json: morphoReadJson({
        version: "v2",
        overrides: {
          [stateUrl]: () => (++attempts === 1
            ? { status: 503, json: { error: "unavailable" } }
            : { data: { chain_id: 1, address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", withdrawable_assets: "30000000", last_indexed_block: "26500000", last_accrual_timestamp: Math.floor(Date.now() / 1000) - 60 } }),
        },
      }),
    });
    const ok = await runAdapterWithFakeTimers(() => runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 })));
    expect(attempts).toBe(2);
    expect(ok.metadata?.redemptionCapacityRaw).toBe("30000000");

    let failAttempts = 0;
    installErc4626Network({
      idleBalance: 25_000_000n, liquidityAdapter: 1,
      json: morphoReadJson({ version: "v2", overrides: { [stateUrl]: () => { failAttempts += 1; return { status: 503, json: { error: "down" } }; } } }),
    });
    const failed = await runAdapterWithFakeTimers(() => runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 })));
    expect(failAttempts).toBe(2);
    expect(nonInfoWarnings(failed.warnings)).toEqual([expect.objectContaining({ code: "morpho-vault-v2-liquidity-unavailable" })]);
  });

  it("never retries HTTP 429, shares Retry-After D1 cooldown across continuations, and caches upstream outages without poisoning on local deadlines", async () => {
    const { db, rows } = makeMorphoCacheDb();
    const requestCache = new Map<string, Promise<unknown>>();
    const net = installErc4626Network({
      liquidityAdapter: 1,
      json: morphoReadJson({
        version: "v2",
        overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { status: 429, headers: { "Retry-After": "3600" }, json: { error: "rate limited" } } },
      }),
    });
    const first = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache, db });
    expect(net.requests.filter((r) => r.url.startsWith("https://api.morpho.org"))).toHaveLength(1);
    expect(nonInfoWarnings(first.warnings)).toEqual([expect.objectContaining({ code: "morpho-vault-v2-rate-limited", effect: "degraded" })]);
    const saved = JSON.parse(rows.get("yield:supplemental-sources:v1:morpho-backoff")!.value) as { backoffUntilSec: number; recordedAtSec: number; source: string };
    expect(saved).toMatchObject({ source: "retry-after", backoffUntilSec: saved.recordedAtSec + 3600 });

    const second = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v1", chainId: 1 }), { requestCache, db });
    expect(net.requests.filter((r) => r.url.startsWith("https://api.morpho.org"))).toHaveLength(1);
    expect(nonInfoWarnings(second.warnings)).toEqual([expect.objectContaining({ code: "morpho-vault-v1-rate-limited", effect: "degraded" })]);
    expect(second.metadata).not.toHaveProperty("redemptionCapacityRaw");

    // Distinct requestCache simulating scheduled continuation still respects the shared Retry-After D1 cooldown.
    const resumed = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache: new Map(), db, nowSec: saved.recordedAtSec + 1800 });
    expect(net.requests.filter((r) => r.url.startsWith("https://api.morpho.org"))).toHaveLength(1);
    expect(nonInfoWarnings(resumed.warnings)).toEqual([expect.objectContaining({ code: "morpho-vault-v2-rate-limited", effect: "degraded" })]);

    // Upstream directory outage is negatively cached, while a local attempt deadline never poisons peers.
    const errCache = new Map<string, Promise<unknown>>();
    const errNet = installErc4626Network({
      liquidityAdapter: 1,
      json: morphoReadJson({ version: "v2", overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { data: [] } } }),
    });
    await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache: errCache });
    await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache: errCache });
    expect(errNet.requests.filter((r) => r.url.includes("/v0/vaults-v2?limit=1000"))).toHaveLength(1);

    const budgetCache = new Map<string, Promise<unknown>>();
    installErc4626Network({ liquidityAdapter: 1, json: morphoReadJson({ version: "v2", withdrawable: "30000000" }) });
    const expired = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache: budgetCache, attemptDeadlineMs: Date.now() - 1 });
    expect(nonInfoWarnings(expired.warnings)).toEqual([expect.objectContaining({ code: "morpho-vault-v2-liquidity-unavailable" })]);
    const recovered = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache: budgetCache });
    expect(nonInfoWarnings(recovered.warnings)).toEqual([]);
    expect(recovered.metadata?.redemptionCapacityRaw).toBe("30000000");
  });

  it("reuses cached Morpho directory, block timestamp, and token price across vaults sharing requestCache", async () => {
    const requestCache = new Map<string, Promise<unknown>>();
    const net = installErc4626Network({ liquidityAdapter: 1, json: morphoReadJson({ version: "v2", withdrawable: "30000000" }) });
    await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache });
    await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }), { requestCache });
    expect(net.requests.filter((r) => r.url.includes("/v0/vaults-v2?limit=1000"))).toHaveLength(1);
    expect(net.requests.filter((r) => r.url.includes("/v0/tokens/"))).toHaveLength(1);
    expect(net.fetchSpy.mock.calls.filter(([, init]) => String(init?.body ?? "").includes(`0x${(26_500_000).toString(16)}`))).toHaveLength(1);
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
    const net = installErc4626Network({ idleBalance: idle, liquidityAdapter: adapter, json: morphoReadJson({ version: "v2" }) });
    const result = await runTrackedVault("syrupusdc-maple", withRedemptionLiquidity({ source: "morpho-vault-v2", chainId: 1 }));
    expect(net.requests.some((r) => r.url.startsWith("https://api.morpho.org"))).toBe(false);
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

});

describe("Morpho V2 operational conditions and composition admission", () => {
  it("keeps a raw 1 / 10^18 idle balance as a positive share and never quantizes it to zero", async () => {
    const id = "ethenausdc-steakhouse";
    const total = 10n ** 18n;
    installTrackedMorphoV2(id, { idleBalance: 1n, totalAssets: total, totalSupply: total, convertedAssets: total });
    const result = await runTrackedVault(id);
    const idle = result.slices.find((slice) => slice.sourceKey === "erc4626-single-asset:base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(idle?.pct).toBeGreaterThan(0);
    expect(idle?.pct).toBeCloseTo(1e-16, 20);
    expect(result.slices.find((slice) => slice.sourceKey?.endsWith(":deployed"))?.pct).toBeCloseTo(100, 10);
  });

  it.each([0n, 25_000_000n, 99_990_000n, 99_999_999n, 100_000_000n])(
    "keeps reviewed Ethena USDC idle and deployed composition distinct at idle %s",
    async (idleBalance) => {
      const id = "ethenausdc-steakhouse";
      installTrackedMorphoV2(id, { idleBalance });
      const result = await runTrackedVault(id);
      const coin = TRACKED_META_BY_ID.get(id)!;
      const idleKey = "erc4626-single-asset:base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
      const deployedKey = "erc4626-single-asset:base:0xbeeff0be997cca5b1c13a7433c2004637975739e:deployed";
      const idle = result.slices.find((slice) => slice.sourceKey === idleKey);
      const deployed = result.slices.find((slice) => slice.sourceKey === deployedKey);
      expect(result.slices).toHaveLength(idleBalance === 0n || idleBalance === 100_000_000n ? 1 : 2);
      if (idleBalance > 0n) expect(idle).toMatchObject({ pct: expect.closeTo(Number(idleBalance) / 1_000_000, 10), coinId: "usdc-circle" });
      else expect(idle).toBeUndefined();
      if (idleBalance < 100_000_000n) {
        expect(deployed).toMatchObject({ pct: expect.closeTo(Number(100_000_000n - idleBalance) / 1_000_000, 10), coinId: "usdc-circle", depType: "wrapper" });
      } else expect(deployed).toBeUndefined();
      const clock = Date.parse("2026-10-16T00:00:00Z") / 1000;
      const classifications = buildReviewedReserveClassifications(result.slices, coin, clock);
      for (const slice of result.slices) {
        expect(coin.reserves?.filter((reviewed) => reviewed.sourceKey === slice.sourceKey)).toHaveLength(1);
        const c = classifications.find((row) => row.exposureKey === computeSafetyScoreV9ReserveExposureKey(slice));
        expect(c?.classificationKey).toMatch(/^registry-reviewed:/);
        expect(c?.assetClass).toBe(slice.sourceKey === idleKey ? "stablecoin" : "protocol-position");
      }
      expect(result.metadata?.unknownExposurePct).toBe(0);
      expectValidAdapterOutput("erc4626-single-asset", result, { subjectId: id });
    },
  );

  it("fails closed on duplicate reviewed keys or competing live rows", async () => {
    const id = "ethenausdc-steakhouse";
    installTrackedMorphoV2(id, { idleBalance: 0n });
    const result = await runTrackedVault(id);
    const coin = TRACKED_META_BY_ID.get(id)!;
    const clock = Date.parse("2026-10-16T00:00:00Z") / 1000;
    const reviewed = coin.reserves!.find((row) => row.sourceKey === result.slices[0]!.sourceKey)!;
    expect(buildReviewedReserveClassifications(result.slices, { ...coin, reserves: [reviewed, reviewed] }, clock)[0]?.classificationKey).toMatch(/^source-native:/);
    expect(result.slices[0]).not.toHaveProperty("issuerOrObligor");
    const competing = buildReviewedReserveClassifications([result.slices[0]!, { ...result.slices[0]!, name: "Competing" }], coin, clock);
    expect(competing.every((row) => row.classificationKey.startsWith("source-native:"))).toBe(true);
  });

  it.each([
    { id: "steakusdg-steakhouse", paused: undefined as number | undefined, routeStatus: "unknown" as const },
    { id: "krusdc-keyrock", paused: 0 as number | undefined, routeStatus: "open" as const },
  ])("admits healthy $id via Read API and enforces admission gates", async ({ id, paused, routeStatus }) => {
    installTrackedMorphoV2(id, { paused });
    const result = await runTrackedVault(id);
    expect(nonInfoWarnings(result.warnings)).toEqual([]);
    expect(result.slices.map((s) => s.pct)).toEqual([25, 75]);
    expect(result.slices[1]).toMatchObject({ risk: "high", depType: "wrapper" });
    expect(result.metadata).toMatchObject({
      unknownExposurePct: 0, morphoVaultV2LiquidityRaw: "90000000", redemptionCapacityRaw: "90000000",
      redemptionCapacitySource: "morpho-vault-v2-liquidity",
      redemption: {
        capacityUsd: 90, freshnessKind: "same-run-api", routeStatus,
        ...(routeStatus === "open" ? { routeStatusSource: "protocol-api" } : {}),
      },
    });
    if (routeStatus === "unknown") expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
    expect(nonInfoWarnings(expectValidAdapterOutput("erc4626-single-asset", result, { subjectId: id }).warnings)).toEqual([]);
    const coin = TRACKED_META_BY_ID.get(id)!;
    const snap = trackedVaultSnapshot(id, result);
    const state = trackedVaultSyncState(snap);
    expect(evaluateLiveReserveAdmission(snap, state, coin, snap.fetchedAt).eligible).toBe(true);
    expect(evaluateLiveReserveAdmission(snap, { ...state, lastSuccessAttemptId: "other" }, coin, snap.fetchedAt).reasons).toContain("inconsistent-snapshot");
    expect(evaluateLiveReserveAdmission(snap, state, coin, snap.fetchedAt + LIVE_RESERVE_FRESHNESS_SEC + 1).reasons).toContain("stale");
    expect(evaluateLiveReserveAdmission({ ...snap, configFingerprint: "old" }, state, coin, snap.fetchedAt).reasons).toContain("config-mismatch");
    expect(evaluateLiveReserveAdmission({
      ...snap, metadata: { ...snap.metadata, freshnessMode: "verified", sourceTimestamp: snap.fetchedAt - LIVE_RESERVE_FRESHNESS_SEC - 1 },
    }, state, coin, snap.fetchedAt).reasons).toContain("stale");
  });

  it("keeps onchain pause ahead of API liquidity, preserves missing-idle degradation, and separates NAV divergence from route impairment", async () => {
    installTrackedMorphoV2("krusdc-keyrock", { paused: 1 });
    const paused = await runTrackedVault("krusdc-keyrock");
    expect(paused.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-redemption-paused", effect: "info" }));
    expect(paused.metadata?.redemption).toMatchObject({ capacityUsd: 90, routeStatus: "paused", routeStatusSource: "onchain" });
    expect(admission("krusdc-keyrock", paused).eligible).toBe(true);

    installTrackedMorphoV2("krusdc-keyrock", { idleBalance: null });
    const noIdle = await runTrackedVault("krusdc-keyrock");
    expect(noIdle.metadata?.unknownExposurePct).toBe(100);
    expect(noIdle.metadata?.redemption).toMatchObject({ capacityUsd: 90, routeStatus: "open", routeStatusSource: "protocol-api" });
    expect(noIdle.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-idle-balance-unavailable", effect: "degraded" }));
    expect(admission("krusdc-keyrock", noIdle).reasons).toContain("degraded-snapshot");

    installTrackedMorphoV2("krusdc-keyrock", { convertedAssets: 110_000_000n });
    const nav = await runTrackedVault("krusdc-keyrock");
    expect(nav.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-nav-divergence", effect: "degraded" }));
    expect(nav.metadata?.redemption).toMatchObject({ capacityUsd: 90, routeStatus: "open", routeStatusSource: "protocol-api" });
    expect(admission("krusdc-keyrock", nav).reasons).toContain("degraded-snapshot");
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

describe("ERC-4626 capacity wire projections", () => {
  it("preserves explicit zero capacity, constraints and source diagnostics", () => {
    const telemetry: RedemptionCapacityTelemetry = {
      capacityUsd: 0, capacityRaw: "0", capacitySource: "morpho-vault-v2-liquidity",
      underlyingDecimals: 6, freshnessKind: "same-run-onchain",
      capacityRatioOfSupply: 0, settlementDelaySec: 0, blockNumber: 0, sourceTimestamp: 0,
      feeBps: 0, sourceUrls: [], holderEligibility: "any-holder",
      observerDiagnostics: { paused: false }, idleUnderlyingBalanceRaw: "0",
      yearnV3WithdrawableRaw: "0", sboldSpWithdrawableRaw: "0", stusdsUnusedFundsRaw: "0", sfrxusdCrosschainWithdrawableRaw: "0",
      morphoVaultV1LiquidityRaw: "0", morphoVaultV1LiquidityUsd: 0,
      morphoVaultV2LiquidityRaw: "0", morphoVaultV2LiquidityUsd: 0,
      morphoVaultV2ForceDeallocatableLiquidityRaw: "0", morphoVaultV2ForceDeallocatableLiquidityUsd: 0,
    };
    expect(JSON.stringify(projectErc4626RedemptionTelemetry(telemetry))).toBe(JSON.stringify({
      capacityUsd: 0, capacityRatioOfSupply: 0, capacityKind: "live-direct",
      settlementDelaySec: 0, blockNumber: 0, sourceTimestamp: 0,
      sourceUrls: [], holderEligibility: "any-holder", feeBps: 0,
      observerDiagnostics: { paused: false }, freshnessKind: "same-run-onchain",
    }));
    expect(JSON.stringify(projectErc4626RedemptionMetadata(telemetry))).toBe(JSON.stringify({
      redemptionCapacityRaw: "0", redemptionCapacitySource: "morpho-vault-v2-liquidity",
      idleUnderlyingBalanceRaw: "0", underlyingDecimals: 6,
      morphoVaultV1LiquidityRaw: "0", morphoVaultV1LiquidityUsd: 0,
      yearnV3WithdrawableRaw: "0", sboldSpWithdrawableRaw: "0", stusdsUnusedFundsRaw: "0", sfrxusdCrosschainWithdrawableRaw: "0",
      morphoVaultV2LiquidityRaw: "0", morphoVaultV2LiquidityUsd: 0,
      morphoVaultV2ForceDeallocatableLiquidityRaw: "0", morphoVaultV2ForceDeallocatableLiquidityUsd: 0,
    }));
  });

  it("omits unavailable optional fields without publishing raw or route-only fields in nested telemetry", () => {
    const telemetry = {
      capacityUsd: 1, capacityRaw: "1000000", capacitySource: "erc4626-idle-underlying",
      underlyingDecimals: 6, freshnessKind: "same-run-onchain",
      capacityRatioOfSupply: null, feeBps: undefined, observerDiagnostics: null,
      routeStatus: "degraded", routeStatusSource: "onchain", routeStatusReason: "restricted",
      morphoVaultV2LiquidityUsd: null,
    } as unknown as RedemptionCapacityTelemetry;
    expect(projectErc4626RedemptionTelemetry(telemetry)).toEqual({
      capacityUsd: 1, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
    });
    expect(projectErc4626RedemptionMetadata(telemetry)).toEqual({
      redemptionCapacityRaw: "1000000", redemptionCapacitySource: "erc4626-idle-underlying", underlyingDecimals: 6,
    });
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

describe("ERC4626 redemption locks", () => {
  it("bounds fully backed capacity by the live cooldown, without adding the withdrawal window", async () => {
    mockLocks(1728000n);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "documented-bound", capacityRatioOfSupply: 1, settlementDelaySec: 1728000, routeStatus: "open", routeStatusSource: "onchain" });
    expect(result.metadata?.unstakeWindowSec).toBe(172800);
  });
  it("publishes paused evidence as degraded without losing reserve composition", async () => {
    mockLocks(86400n, 1);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "paused", settlementDelaySec: 86400 });
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100 })]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "erc4626-redemption-paused", effect: "degraded" }));
  });
  it("does not invent a lock when no lock is configured", async () => {
    installErc4626Network({ idleBalance: 100_000_000n });
    const result = await runTrackedVault("syrupusdc-maple");
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "live-direct", routeStatus: "unknown" });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
  });
  it("permits immediate redemption when both cooldown and window are disabled", async () => {
    mockLocks(0n, 0, 0);
    const result = await runTrackedVault("syrupusdc-maple", withLocks);
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "live-direct", settlementDelaySec: 0 });
  });
  it("does not present asynchronous request backing as executable redemption capacity", async () => {
    installErc4626Network({ idleBalance: 100_000_000n });
    const result = await runTrackedVault("syrupusdc-maple", (config) => ({
      ...config, params: { ...config.params, redemptionRoute: "async-request" },
    }));
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-bound", settlementBoundUnproven: true, capacityRatioOfSupply: 1,
    });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
  });
  it("does not interpret a malformed pause word as an open or paused route", async () => {
    mockLocks(86400n, 2);
    await expect(runTrackedVault("syrupusdc-maple", withLocks)).rejects.toThrow(/redemption lock paused\(\) unreadable/);
  });
  it.each([null, 2n ** 200n])("rejects unreadable or unsafe lock durations (%s)", async (cooldown) => {
    mockLocks(cooldown);
    await expect(runTrackedVault("syrupusdc-maple", withLocks)).rejects.toThrow(/redemption lock.*malformed or unreadable/);
  });
});

describe("ERC4626 asset-targeted redemption locks", () => {
  const fxSave = "0x7743e50f534a7f9f1791dde7dcd89f7783eefc39";
  const fxSp = "0x65c9a641afceb9c0e6034e558a319488fa0fa3be";
  const coolDownSelector = toFunctionSelector("redeemCoolDownPeriod()");
  function mockFxSave(cooldown: bigint | null) {
    installErc4626Network({
      vault: fxSave, asset: fxSp, decimals: 18, idleBalance: 0n,
      totalAssets: 70n * 10n ** 24n, totalSupply: 63n * 10n ** 24n, convertedAssets: 70n * 10n ** 24n,
      extraHandlers: [({ call }) => {
        if (call?.data !== coolDownSelector) return undefined;
        // Only the underlying fxSP pool exposes the cooldown getter.
        if (call.to?.toLowerCase() !== fxSp || cooldown == null) return null;
        return jsonResponse({ result: `0x${cooldown.toString(16).padStart(64, "0")}` });
      }],
    });
  }

  it("reads the fxSP cooldown from the reviewed asset and bounds full backing instead of zero idle", async () => {
    mockFxSave(3600n);
    const result = await runTrackedVault("fxsave-f-x-protocol");
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-bound", capacityRatioOfSupply: 1, settlementDelaySec: 3600,
    });
  });
  it("projects the fxSP supply ratio to USD on the delayed settlement horizon", async () => {
    mockFxSave(3600n);
    const result = await runTrackedVault("fxsave-f-x-protocol");
    // 70M fxSP units are not $70M; withholding the unit amount keeps the
    // consumer from reading 70M / 72.8M (96.15%) instead of the measured 100%.
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    const now = Math.floor(Date.now() / 1_000);
    const supplyUsd = 72_800_000;
    const capacity = await resolveRedemptionCapacity(
      {} as D1Database, "fxsave-f-x-protocol", { kind: "reserve-sync-metadata" }, supplyUsd, now,
      { reserveSnapshotMetadata: liveSnapshot("fxsave-f-x-protocol", {
        ...result.metadata, freshnessMode: "not-applicable",
      }, { fetchedAt: now - 60, source: "erc4626-single-asset", sourceModel: "single-bucket" }) },
    );
    expect(capacity).toMatchObject({
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      capacityProfile: { eventualUsd: supplyUsd, scoringHorizon: "eventual" },
      scoringCapacityRatio: 1,
    });
  });
  it("fails closed when the asset cooldown is unreadable", async () => {
    mockFxSave(null);
    await expect(runTrackedVault("fxsave-f-x-protocol")).rejects.toThrow(/redemption lock.*malformed or unreadable/);
  });
  it("rejects an asset-targeted lock without a reviewed expected asset", async () => {
    mockFxSave(3600n);
    await expect(runTrackedVault("fxsave-f-x-protocol", (config) => ({
      ...config,
      params: { ...config.params, slice: { name: "fxSP stability-pool shares", risk: "medium" } },
    }))).rejects.toThrow(/expectedAssetAddress/);
  });
});
