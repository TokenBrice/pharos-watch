import { describe, expect, it } from "vitest";
import { evaluateAdapterSnapshotAdmission, runAdapter } from "./reserve-adapter.test-support";
import {
  MONOLITH_LENDER_COIN,
  MONOLITH_LENDER_NOW_SEC,
  MONOLITH_LENDER_PIN,
  collateralPriceWord,
  pinnedNetwork,
} from "./monolith-lender.test-support";

const ADAPTER_KEY = "monolith-lender";
const PIN = MONOLITH_LENDER_PIN;
const NOW_SEC = MONOLITH_LENDER_NOW_SEC;

describe("monolith-lender adapter", () => {
  it("reads the pinned swanUSD Lender in one block-pinned Multicall and publishes debt-based cover", async () => {
    const { result, network, report } = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork(),
      nowSec: NOW_SEC,
    });

    expect(report.warnings).toEqual([]);
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toHaveLength(2);
    expect(result.slices[0]).toMatchObject({
      sourceKey: `monolith-lender:ethereum:${PIN.collateral}`,
      name: "wstETH collateral (Monolith Lender)",
      risk: "low",
    });
    expect(result.slices[0]!.pct).toBeCloseTo(90.30498446704837, 8);
    expect(result.slices[1]).toMatchObject({
      sourceKey: `monolith-lender:ethereum:${PIN.psmVault}`,
      name: "sUSDS PSM reserve (Monolith Lender)",
      risk: "low",
      coinId: "susds-sky",
      depType: "collateral",
    });
    expect(result.slices[1]!.pct).toBeCloseTo(9.695015532951636, 8);

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      supplyTokens: expect.closeTo(420092.200246431, 5),
      unknownExposurePct: 0,
      redemption: {
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 0,
        blockNumber: PIN.blockNumber,
        outputAssetKeys: ["usds-sky"],
      },
      details: {
        proofKind: "monolith-lender-cdp-accounting",
        capacityBindingSource: "lender-free-psm-assets",
        capacityRatioDenominator: "coin.totalSupply()",
        collateralPriceUsd: expect.closeTo(2933.7350950331315, 6),
        collateralPriceReduceOnly: false,
        collateralAllowLiquidations: true,
        collateralFeedUpdatedAt: PIN.feedUpdatedAt,
        collateralFeedAgeSec: 44_892,
        collateralStalenessThresholdSec: 108_000,
        ratioBasis: "collateral-value-over-cdp-debt",
        freePsmAssetsRaw: PIN.freePsmAssets.toString(),
        psmVaultMaxWithdrawRaw: PIN.psmVaultMaxWithdraw.toString(),
        // The pinned book reconciles to the wei: supply is exactly recognised
        // debt plus the free PSM assets.
        supplyBackingRaw: PIN.totalSupply.toString(),
        supplyShortfallRaw: "0",
        supplyShortfallTokens: 0,
        supplyShortfallToleranceRaw: (PIN.totalSupply / 10_000n).toString(),
      },
    });
    // Ratio and totals are the pinned values: wstETH value over recognised CDP debt.
    // The shared price helper rounds the oracle to micro-dollars before valuing.
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(662_249.514, 2);
    expect(result.metadata?.totalDebtUsd).toBeCloseTo(355_887.0069934302, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.68043314, 8);
    expect(result.metadata?.redemption?.capacityUsd).toBeCloseTo(64_205.19325300078, 6);
    expect(result.metadata?.redemption?.capacityRatioOfSupply).toBeCloseTo(0.1528359565, 10);
    expect(result.metadata?.redemption?.routeStatusReason).toContain(
      `freePsmAssets() is ${PIN.freePsmAssets}`,
    );

    // Exactly one Multicall3 batch, pinned to the captured block.
    const blocks = new Set(network.rpcCalls.map((call) => call.block));
    expect(blocks).toEqual(new Set([`0x${PIN.blockNumber.toString(16)}`]));
    expect(network.rpcCalls.every((call) => call.viaMulticall)).toBe(true);
    expect(network.rpcCalls).toHaveLength(20);
    expect(network.unmatched).toEqual([]);
  });

  it("admits the emitted snapshot as independent collateral evidence for the catalog coin", async () => {
    const run = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork(),
      nowSec: NOW_SEC,
    });
    const admission = evaluateAdapterSnapshotAdmission(run, NOW_SEC);
    expect(admission.eligible, JSON.stringify(admission.reasons)).toBe(true);
    expect(admission.freshness).toMatchObject({ stale: false });
  });

  it("publishes a reduce-only protocol oracle as degradation without closing the PSM rail", async () => {
    const { result } = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:getCollateralPrice()`]: collateralPriceWord(PIN.collateralPrice, true, true),
      }),
      nowSec: NOW_SEC,
    });

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "monolith-lender-oracle-degraded",
      effect: "degraded",
    }));
    // The PSM sell never reads the collateral oracle, so the route stays open.
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open", feeBps: 0 });
  });

  it("fails closed when the protocol oracle cannot value the collateral", async () => {
    await expect(runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:getCollateralPrice()`]: collateralPriceWord(0n, true, false),
      }),
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow(/collateral oracle is unusable/);
  });

  it("fails closed when Lender.coin() no longer resolves to the tracked contract", async () => {
    await expect(runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:coin()`]: "0x0000000000000000000000000000000000000001",
      }),
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow(/coin\(\) mismatch/);
  });

  it("fails closed when the PSM vault no longer holds the configured PSM asset", async () => {
    await expect(runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.psmVault}:asset()`]: PIN.collateral,
      }),
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow(/psmVault\.asset\(\) mismatch/);
  });

  it("fails closed rather than assuming 1:1 when the PSM sell conversion changes", async () => {
    await expect(runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:getSellAmountOut(uint256)`]: 990_000_000_000_000_000n,
      }),
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow(/1:1 conversion/);
  });

  it("fails closed when a required state read is unanswered", async () => {
    await expect(runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({ [`ethereum:${PIN.lender}:freePsmAssets()`]: null }),
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow(/free-psm-assets/);
  });

  it("binds capacity to the sUSDS payout ceiling when the vault pays less than the accounting", async () => {
    const ceiling = 60_000_000_000_000_000_000_000n;
    const { result } = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({ [`ethereum:${PIN.psmVault}:maxWithdraw(address)`]: ceiling }),
      nowSec: NOW_SEC,
    });

    expect(result.metadata?.redemption?.capacityUsd).toBeCloseTo(60_000, 6);
    expect(result.metadata?.details).toMatchObject({ capacityBindingSource: "psm-vault-max-withdraw" });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "monolith-lender-psm-vault-ceiling-binds",
      effect: "info",
    }));
    // Reserve composition still reports the full Lender-held PSM reserve.
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(662_249.514, 2);
  });

  it("withholds capacity and route status when the sUSDS payout ceiling is unreadable", async () => {
    const { result } = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({ [`ethereum:${PIN.psmVault}:maxWithdraw(address)`]: null }),
      nowSec: NOW_SEC,
    });

    // freePsmAssets() is the Lender's accounting limit, not proof the same-tx
    // sUSDS redemption can pay: without the payout bound neither a positive
    // capacity nor an open route may be claimed.
    const redemption = result.metadata?.redemption as Record<string, unknown> | undefined;
    expect(redemption).toBeDefined();
    expect(redemption).not.toHaveProperty("capacityUsd");
    expect(redemption).not.toHaveProperty("capacityRatioOfSupply");
    expect(redemption).not.toHaveProperty("capacityKind");
    expect(redemption).toMatchObject({
      freshnessKind: "same-run-onchain",
      routeStatus: "unknown",
      routeStatusSource: "static-config",
      feeBps: 0,
      holderEligibility: "any-holder",
    });
    expect(String(redemption?.routeStatusReason)).toMatch(/maxWithdraw\(\) .*was unreadable/);
    expect(result.metadata?.details).toMatchObject({
      capacityBindingSource: null,
      psmVaultMaxWithdrawRaw: null,
      freePsmAssetsRaw: PIN.freePsmAssets.toString(),
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "monolith-lender-psm-vault-ceiling-unobserved",
      effect: "info",
    }));
    // Reserve composition keeps its own successful reads.
    expect(result.slices).toHaveLength(2);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(662_249.514, 2);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.68043314, 8);
  });

  it("admits a solvent PSM-only book: measured zero debt and collateral withhold the ratio, not the reserve", async () => {
    const run = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:totalPaidDebt()`]: 0n,
        [`ethereum:${PIN.lender}:totalFreeDebt()`]: 0n,
        [`ethereum:${PIN.collateral}:balanceOf(address)`]: 0n,
        // Every coin in circulation was PSM-issued, so the PSM reserve covers it.
        [`ethereum:${PIN.coin}:totalSupply()`]: PIN.freePsmAssets,
      }),
      nowSec: NOW_SEC,
    });
    const { result } = run;

    expect(result.warnings).toBeUndefined();
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({
      sourceKey: `monolith-lender:ethereum:${PIN.psmVault}`,
      name: "sUSDS PSM reserve (Monolith Lender)",
      coinId: "susds-sky",
      pct: 100,
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(64_205.19325300078, 6);
    // Zero recognised debt is a measured state, not a failed read: the ratio and
    // its denominator are withheld together and the reason is machine-readable.
    expect(result.metadata?.totalDebtUsd).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.ratioUnavailableReason).toBe("zero-liability-denominator");
    expect(result.metadata?.details).toMatchObject({
      collateralUnitsRaw: "0",
      totalPaidDebtRaw: "0",
      totalFreeDebtRaw: "0",
      debtShareOfSupply: 0,
      supplyBackingRaw: PIN.freePsmAssets.toString(),
      supplyShortfallRaw: "0",
    });
    expect(result.metadata?.details).not.toHaveProperty("ratioBasis");
    // The PSM rail and its telemetry survive the empty CDP book.
    expect(result.metadata?.redemption?.capacityUsd).toBeCloseTo(64_205.19325300078, 6);
    expect(result.metadata?.redemption).toMatchObject({
      capacityRatioOfSupply: 1,
      routeStatus: "open",
      routeStatusSource: "onchain",
    });
    // Supply never exceeds its PSM backing, so the snapshot stays clean evidence.
    expect(evaluateAdapterSnapshotAdmission(run, NOW_SEC).eligible).toBe(true);
  });

  it("marks a last-borrower write-off book as unbacked supply instead of clean PSM cover", async () => {
    // writeOff() deletes the last borrower's debt without burning its coin, so a
    // zero-debt book can still carry 420,092.20 supply while only the 64,205.19
    // PSM reserve backs it.
    const run = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:totalPaidDebt()`]: 0n,
        [`ethereum:${PIN.lender}:totalFreeDebt()`]: 0n,
        [`ethereum:${PIN.collateral}:balanceOf(address)`]: 0n,
      }),
      nowSec: NOW_SEC,
    });
    const { result } = run;

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        severity: "warning",
        effect: "degraded",
        message: expect.stringContaining("355887.006993430199851968 tokens"),
      }),
    ]);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]!.pct).toBe(100);
    expect(result.metadata?.details).toMatchObject({
      supplyBackingRaw: PIN.freePsmAssets.toString(),
      supplyShortfallRaw: (PIN.totalSupply - PIN.freePsmAssets).toString(),
    });
    // The measured zero debt still withholds the CDP ratio, and the PSM bound is
    // the real executable capacity: the shortfall does not alter either.
    expect(result.metadata?.ratioUnavailableReason).toBe("zero-liability-denominator");
    expect(result.metadata?.redemption?.capacityUsd).toBeCloseTo(64_205.19325300078, 6);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open", routeStatusSource: "onchain" });
    // Adverse evidence, never clean backing: the snapshot is stored (the warning
    // is not fatal) but stays out of independent reserve scoring.
    const admission = evaluateAdapterSnapshotAdmission(run, NOW_SEC);
    expect(admission.eligible).toBe(false);
    expect(admission.reasons).toContain("degraded-snapshot");
  });

  it("warns when recognised debt plus PSM assets no longer cover supply", async () => {
    const run = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:totalPaidDebt()`]: 100_000n * 10n ** 18n,
        [`ethereum:${PIN.lender}:totalFreeDebt()`]: 0n,
      }),
      nowSec: NOW_SEC,
    });
    const { result } = run;

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }),
    ]);
    expect(result.metadata?.details).toMatchObject({
      supplyBackingRaw: (100_000n * 10n ** 18n + PIN.freePsmAssets).toString(),
      supplyShortfallRaw: (PIN.totalSupply - 100_000n * 10n ** 18n - PIN.freePsmAssets).toString(),
    });
    // This warning is about supply cover, not the CDP ratio: the ratio keeps its
    // measured denominator.
    expect(result.metadata?.totalDebtUsd).toBeCloseTo(100_000, 6);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.metadata?.ratioUnavailableReason).toBeUndefined();
    expect(evaluateAdapterSnapshotAdmission(run, NOW_SEC).reasons).toContain("degraded-snapshot");
  });

  it("keeps a sub-tolerance shortfall visible without degrading the snapshot", async () => {
    // One token of drift sits inside the max(1 token, 1 bp of supply) tolerance,
    // so it is published in details but is not adverse evidence.
    const { result } = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:totalPaidDebt()`]: PIN.totalPaidDebt - 10n ** 18n,
      }),
      nowSec: NOW_SEC,
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.details).toMatchObject({
      supplyShortfallRaw: (10n ** 18n).toString(),
      supplyShortfallTokens: 1,
    });
  });

  it("values a zero collateral balance as zero instead of failing the whole snapshot", async () => {
    const { result } = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.collateral}:balanceOf(address)`]: 0n,
        // The Lender prices redemptions off the same read: with debt standing and
        // no collateral it reports reduce-only, which stays adverse evidence.
        [`ethereum:${PIN.lender}:getCollateralPrice()`]: collateralPriceWord(PIN.collateralPrice, true, true),
      }),
      nowSec: NOW_SEC,
    });

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "monolith-lender-oracle-degraded",
      effect: "degraded",
    }));
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]!.sourceKey).toBe(`monolith-lender:ethereum:${PIN.psmVault}`);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(64_205.19325300078, 6);
    // Debt is still measured, so the ratio keeps a denominator and reports 0.
    expect(result.metadata?.totalDebtUsd).toBeCloseTo(355_887.0069934302, 6);
    expect(result.metadata?.collateralizationRatio).toBe(0);
    expect(result.metadata?.ratioUnavailableReason).toBeUndefined();
  });

  it("fails closed when every reserve bucket is measured zero", async () => {
    await expect(runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.psmVault}:balanceOf(address)`]: 0n,
        [`ethereum:${PIN.lender}:freePsmAssets()`]: 0n,
        [`ethereum:${PIN.collateral}:balanceOf(address)`]: 0n,
      }),
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow(/both measured zero/);
  });

  it("publishes a measured zero PSM reserve as a degraded route, never as missing capacity", async () => {
    const { result } = await runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({
        [`ethereum:${PIN.lender}:freePsmAssets()`]: 0n,
        [`ethereum:${PIN.psmVault}:balanceOf(address)`]: 0n,
        [`ethereum:${PIN.psmVault}:maxWithdraw(address)`]: 0n,
      }),
      nowSec: NOW_SEC,
    });

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      capacityRatioOfSupply: 0,
      routeStatus: "degraded",
      routeStatusSource: "onchain",
    });
    expect(result.metadata?.redemption?.routeStatusReason).toContain("freePsmAssets() is zero");
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]!.pct).toBe(100);
  });

  it("rejects an unreadable collateral scale instead of rescaling a price by guesswork", async () => {
    await expect(runAdapter(ADAPTER_KEY, MONOLITH_LENDER_COIN, {
      network: pinnedNetwork({ [`ethereum:${PIN.collateral}:decimals()`]: 6n }),
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow(/collateral decimals drifted/);
  });

  it("keeps the catalog params pinned to the reviewed swanUSD instance", () => {
    const params = MONOLITH_LENDER_COIN.liveReservesConfig?.params as Record<string, unknown>;
    expect(params).toMatchObject({
      lenderAddress: PIN.lender,
      psmAssetUnitValueUsd: 1,
      redemptionOutputAssetKey: "usds-sky",
      collateral: { address: PIN.collateral, decimals: 18 },
      psmAsset: { address: PIN.psmAsset, decimals: 18 },
      psmVault: { address: PIN.psmVault, coinId: "susds-sky" },
    });
  });
});
