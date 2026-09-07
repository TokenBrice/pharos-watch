import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { adaptIdleCdoEpochVariantSnapshot, type IdleCdoEpochVariantSnapshot } from "../idle-cdo-epoch-variant";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const CDO = "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d";
const AA_TRANCHE = "0xc26a6fa2c37b38e549a4a1807543801db684f99c";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

/**
 * Live read of the FalconX credit vault at finalized Ethereum block 25882423
 * (Ethereum PublicNode, 2026-09-01). `getContractValue()` and `lastNAVAA()` are
 * both 168,514,335.693873 USDC, `lastNAVBB()` is zero, the BB tranche has zero
 * supply, and `USDC.balanceOf(cdo)` is zero — the credit cycle is fully drawn,
 * so the composition is 100% borrower receivable with no cash-equivalent slice.
 */
const LIVE_BLOCK_25882423: IdleCdoEpochVariantSnapshot = {
  cdoAddress: CDO,
  trancheAddress: AA_TRANCHE,
  tranche: "AA",
  underlyingAddress: USDC,
  underlyingDecimals: 6,
  contractValueRaw: 168_514_335_693_873n,
  unlentRaw: 0n,
  navAaRaw: 168_514_335_693_873n,
  navBbRaw: 0n,
  unclaimedFeesRaw: 0n,
  trancheSupplyRaw: 152_904_200_253_644_349_146_720n,
  epochDurationSec: 2_820_960n,
  epochEndDateSec: 1_787_567_255n,
  defaulted: false,
  epochRunning: true,
};

const PARAMS: Parameters<typeof adaptIdleCdoEpochVariantSnapshot>[1] = {
  creditSlice: {
    sourceKey: "idle-cdo:falconx-credit-facility",
    name: "FalconX single-obligor credit facility",
    risk: "high",
    assetClass: "private-credit",
    issuerOrObligor: "FalconX",
    riskFactors: ["credit", "counterparty", "concentration", "liquidity", "legal"],
  },
  unlentSlice: {
    sourceKey: "idle-cdo:unlent-usdc",
    name: "Unlent USDC held by the credit vault",
    risk: "medium",
    coinId: "usdc-circle",
    depType: "collateral",
    assetClass: "stablecoin",
    riskFactors: ["counterparty", "custody", "smart-contract"],
    blacklistable: true,
  },
};

function adapt(overrides: Partial<IdleCdoEpochVariantSnapshot> = {}) {
  return adaptIdleCdoEpochVariantSnapshot({ ...LIVE_BLOCK_25882423, ...overrides }, PARAMS);
}

describe("adaptIdleCdoEpochVariantSnapshot", () => {
  it("publishes the fully drawn credit cycle as one coinId-less private-credit slice", () => {
    const result = adapt();

    expect(result.slices).toEqual([
      {
        sourceKey: "idle-cdo:falconx-credit-facility",
        name: "FalconX single-obligor credit facility",
        pct: 100,
        risk: "high",
        assetClass: "private-credit",
        issuerOrObligor: "FalconX",
        riskFactors: ["credit", "counterparty", "concentration", "liquidity", "legal"],
        liquidityHorizon: "over-seven-days",
      },
    ]);
    // The whole point of the adapter: nothing links the reserve to the parent
    // stablecoin, so backing inheritance from usdc-circle cannot fire.
    expect(result.slices.every((slice) => slice.coinId === undefined)).toBe(true);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      supplyUsd: 168_514_335.693873,
      totalReserveUsd: 168_514_335.693873,
      details: {
        proofKind: "idle-cdo-epoch-variant-onchain-accounting",
        cdoAddress: CDO,
        tranche: "AA",
        unlentRaw: "0",
        receivableRaw: "168514335693873",
        juniorSubordinationUsd: 0,
      },
    });
    expect(
      validateAdapterOutput(result, {
        adapter: getReserveAdapter("idle-cdo-epoch-variant") ?? undefined,
        subjectId: "aa-falconx-mev-capital",
      }).valid,
    ).toBe(true);
  });

  it("records the missing junior first-loss buffer instead of re-rating the senior tranche", () => {
    const result = adapt();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "idle-cdo-no-junior-subordination", effect: "degraded" }),
    );
    expect(result.slices[0]!.risk).toBe("high");
    expect(result.slices[0]!.assetClass).toBe("private-credit");
  });

  it("splits an unlent underlying balance into its own tracked cash slice when one exists", () => {
    const result = adapt({ unlentRaw: 16_851_433_569_387n });

    expect(result.slices).toEqual([
      expect.objectContaining({ name: "FalconX single-obligor credit facility", pct: 90 }),
      expect.objectContaining({
        name: "Unlent USDC held by the credit vault",
        pct: 10,
        coinId: "usdc-circle",
        depType: "collateral",
        liquidityHorizon: "immediate",
      }),
    ]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.warnings ?? []).not.toContainEqual(
      expect.objectContaining({ code: "idle-cdo-no-unlent-underlying" }),
    );
  });

  it("drops the credit liquidity horizon to unknown once the facility defaults", () => {
    const result = adapt({ defaulted: true });
    expect(result.slices[0]!.liquidityHorizon).toBe("unknown");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "idle-cdo-defaulted" }));
  });

  it("degrades when the tranche NAVs do not reconcile to the contract value", () => {
    const result = adapt({ navAaRaw: 160_000_000_000_000n });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "idle-cdo-nav-reconciliation-drift", effect: "degraded" }),
    );
  });

  it("fails closed on unusable vault state rather than publishing a partial composition", () => {
    expect(() => adapt({ contractValueRaw: 0n })).toThrow(/zero contract value/);
    expect(() => adapt({ trancheSupplyRaw: 0n })).toThrow(/zero AA tranche supply/);
    expect(() => adapt({ navAaRaw: 0n })).toThrow(/zero NAV for the AA tranche/);
    expect(() => adapt({ unlentRaw: 999_999_999_999_999n })).toThrow(/exceeds total contract value/);
  });
});

describe("aa-falconx-mev-capital liveReservesConfig", () => {
  const meta = ACTIVE_META_BY_ID.get("aa-falconx-mev-capital");

  it("binds the registered adapter with reviewed, on-chain-verifiable identities", () => {
    expect(meta?.liveReservesConfig?.adapter).toBe("idle-cdo-epoch-variant");
    const params = parseLiveReserveAdapterParams("idle-cdo-epoch-variant", meta?.liveReservesConfig?.params);
    expect(params.cdoAddress.toLowerCase()).toBe(CDO);
    expect(params.underlyingAddress.toLowerCase()).toBe(USDC);
    expect(params.tranche).toBe("AA");
    // The credit slice must never gain a coinId: that is what routes the asset
    // onto the generic reserves path instead of inheriting Circle's reserves.
    expect(params.creditSlice).not.toHaveProperty("coinId");
    expect(params.creditSlice.assetClass).toBe("private-credit");
  });

  it("keeps the declared variant relation and its serial USDC dependency edge", () => {
    expect(meta?.variantOf).toBe("usdc-circle");
    expect(meta?.variantKind).toBe("strategy-vault");
    expect(meta?.pegReferenceId).toBe("usdc-circle");
  });
});
