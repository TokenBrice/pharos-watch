import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import iusdInfiniFiAsset from "@shared/data/stablecoins/coins/iusd-infinifi.json";
import sboldAsset from "@shared/data/stablecoins/coins/sbold-k3-capital.json";
import sdaiAsset from "@shared/data/stablecoins/coins/sdai-sky.json";
import susdaiAsset from "@shared/data/stablecoins/coins/susdai-usd-ai.json";
import wmAsset from "@shared/data/stablecoins/coins/wm-m0.json";
import { resolveV9WrapperStrategyTier } from "@shared/lib/safety-score-v9/evaluate-set";
import { resolveWrapperForm } from "../safety-score-v9/fact-set-wrapper";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/collateral-redeem";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/offchain-issuer";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/queue-redeem";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/stablecoin-redeem/configs";
import type { StablecoinMeta } from "@shared/types/core";
import { describe, expect, it } from "vitest";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  MechanismReviewOverlaySchema,
  buildSafetyScoreV9MechanismReview,
  getSafetyScoreV9MechanismExitFacts,
} from "../safety-score-v9/extension-mechanism";

type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

// 2026-09-05: one UTC day past the 2026-09-04 curation batch, with the
// overlay same-day admission gate fully elapsed.
const PROFILE_CLOCK_SEC = Date.UTC(2026, 8, 5) / 1_000;
const PROFILE_FIXED_INPUT = {
  clockSec: PROFILE_CLOCK_SEC,
  liveReserveMap: {},
} as unknown as ReportCardsFixedInput;

function namedOverlay(assetId: string) {
  const raw = mechanismReviewOverlaysAsset.overlays.find((overlay) => overlay.assetId === assetId);
  if (!raw) throw new Error(`Missing production mechanism overlay ${assetId}`);
  return MechanismReviewOverlaySchema.parse(raw);
}

describe("Safety Score v9 production-shaped archetype fixtures", () => {
  it("admits the dated Chronicle BUIDL and STAC reviews as complete mechanism evidence", () => {
    const buidl = buildSafetyScoreV9MechanismReview(
      PROFILE_FIXED_INPUT,
      ACTIVE_META_BY_ID.get("buidl-blackrock")!,
      "tbill",
    );
    const stac = buildSafetyScoreV9MechanismReview(
      PROFILE_FIXED_INPUT,
      ACTIVE_META_BY_ID.get("stac-securitize")!,
      "rwa-credit-fund",
    );

    expect(buidl).toMatchObject({
      archetype: "tbill",
      fundClaimAndSeniority: { status: { observationState: "known" }, quality: "limited" },
      navValuation: { status: { observationState: "known" }, quality: "adequate" },
      durationAndLiquidity: { status: { observationState: "known" }, quality: "adequate" },
      lossRecoveryDesign: { status: { observationState: "known" }, quality: "adequate" },
    });
    expect(stac).toMatchObject({
      archetype: "rwa-credit-fund",
      weightedAverageMaturityDays: 4499.21,
      valuationCadenceDays: 1,
      creditQuality: { status: { observationState: "known" }, quality: "adequate" },
      seniority: { status: { observationState: "known" }, quality: "limited" },
      legalEnforceability: { status: { observationState: "known" }, quality: "limited" },
      valuationCadence: { status: { observationState: "known" }, quality: "adequate" },
      maturityAndLiquidity: { status: { observationState: "known" }, quality: "adequate" },
      custody: { status: { observationState: "known" }, quality: "adequate" },
      recovery: { status: { observationState: "known" }, quality: "limited" },
    });
  });

  // v9.14 phase-2 result. This case was the phase-1 tripwire: it pinned XAUT to
  // the fiat-cash projection byte-for-byte precisely so the migration could not
  // land unnoticed. It now pins the migrated shape and, more importantly, the
  // invariant the migration had to preserve — the Exit pillar still sees the
  // same `physical-redemption` fact, now DERIVED from the curated backing
  // component instead of declared a second time inside a profile.
  it("carries XAUT allocated-commodity facts into the commodity-claim components", () => {
    const overlay = namedOverlay("xaut-tether");
    expect(overlay.archetype).toBe("commodity-claim");
    // Structurally forbidden: every profile projection declares fiat-cash or
    // algorithmic, so a commodity overlay cannot carry one.
    expect(overlay.profileReview).toBeUndefined();
    expect(ACTIVE_META_BY_ID.get("xaut-tether")?.mechanismArchetype).toBe("commodity-claim");
    // 15 registry coins migrated; 13 are in the active scored set (GRAMG and
    // GRAMS are tracked but carry no `llamaId`, so they never enter it). 13
    // curated overlays — the same two ride the conservative compiler fallback.
    expect(
      [...ACTIVE_META_BY_ID.values()].filter((meta) => meta.mechanismArchetype === "commodity-claim").length,
    ).toBe(13);
    expect(
      mechanismReviewOverlaysAsset.overlays.filter((entry) => entry.archetype === "commodity-claim").length,
    ).toBe(13);

    const review = buildSafetyScoreV9MechanismReview(
      PROFILE_FIXED_INPUT,
      { id: "xaut-tether" } as MechanismMeta,
      "commodity-claim",
    );
    if (review?.archetype !== "commodity-claim") throw new Error("expected the migrated XAUT commodity review");

    // Unchanged from the profile era. Dropping this would regress XAUT's exit
    // reason from a bounded ceiling to an unbounded pillar reason.
    expect(getSafetyScoreV9MechanismExitFacts("xaut-tether", "commodity-claim", PROFILE_CLOCK_SEC)).toEqual([
      {
        factKey: "physical-redemption",
        disposition: "supported",
        quality: "limited",
      },
    ]);
    // The nine profile facts fold onto four components without losing a grade:
    // title takes the weakest of holderTitle / physicalAllocation /
    // custodianSegregation / bankruptcyRemoteness, custody stays the sourced
    // nondisclosure that covered custodyContinuity and insurance, assurance
    // takes the weaker of auditCadence / reserveReconciliation, and redemption
    // is the fact the profile could only express as an exit declaration.
    expect(review).toMatchObject({
      archetype: "commodity-claim",
      titleAndAllocation: {
        status: { observationState: "known" },
        quality: "limited",
      },
      custodyContinuity: {
        status: { observationState: "bounded-unknown" },
        quality: null,
      },
      assuranceAndReconciliation: {
        status: { observationState: "known" },
        quality: "adequate",
      },
      physicalRedemption: {
        status: { observationState: "known" },
        quality: "limited",
      },
    });
  });

  it("gives FPI a CPI-hybrid review without erasing FRAX/reflexive exposure", () => {
    const overlay = namedOverlay("fpi-frax");
    expect(overlay.profileReview).toBeUndefined();
    expect(overlay).toMatchObject({
      archetype: "algorithmic",
      metrics: {
        exogenousBackingShare: 0.871,
        reflexiveBackingShare: 0.0,
        contractionCapacityRatio: 0.871,
      },
      components: {
        contractionCapacity: { applicability: "measured", quality: "adequate" },
        confidenceAndIncentives: { applicability: "measured", quality: "limited" },
        oracleAndControlAssumptions: { applicability: "measured", quality: "adequate" },
        emergencyRecovery: { applicability: "measured", quality: "limited" },
        lossRecovery: {
          applicability: "unavailable",
          sourceUrl: "https://docs.frax.com/protocol/assets/fpi/overview",
        },
      },
    });
    const review = buildSafetyScoreV9MechanismReview(
      PROFILE_FIXED_INPUT,
      { id: "fpi-frax" } as MechanismMeta,
      "algorithmic",
    );
    if (review?.archetype !== "algorithmic") throw new Error("expected the production FPI mechanism review");

    expect(getSafetyScoreV9MechanismExitFacts("fpi-frax", "algorithmic", PROFILE_CLOCK_SEC)).toEqual([]);
    expect(review).toMatchObject({
      archetype: "algorithmic",
      exogenousBackingShare: 0.871,
      reflexiveBackingShare: 0.0,
      contractionCapacityRatio: 0.871,
      contractionCapacity: {
        status: { observationState: "known" },
        quality: "adequate",
      },
      confidenceAndIncentives: {
        status: { observationState: "known" },
        quality: "limited",
      },
      oracleAndControlAssumptions: {
        status: { observationState: "known" },
        quality: "adequate",
      },
      emergencyRecovery: {
        status: { observationState: "known" },
        quality: "limited",
      },
      lossRecovery: {
        status: { observationState: "bounded-unknown" },
        quality: null,
      },
    });
  });

  it("keeps pure wrappers, native savings, Stability Pools, and strategy vaults distinct", () => {
    // Raw source file: `flags.navToken` is a schema default and is intentionally
    // absent here (`StablecoinFlagsSchema` supplies `false`).
    expect(wmAsset.flags).not.toHaveProperty("navToken");
    expect(wmAsset).toMatchObject({
      variantOf: "m-m0",
      variantKind: "pure-wrapper",
      pegReferenceId: "m-m0",
    });
    expect(sdaiAsset.variantKind).toBe("savings-passthrough");
    expect(sboldAsset.variantKind).toBe("risk-absorption");
    expect(sboldAsset.wrapperOperator).toBe("third-party");
    expect(susdaiAsset.variantKind).toBe("strategy-vault");
    expect(iusdInfiniFiAsset.mechanismArchetype).toBe("rwa-credit-fund");
    expect(iusdInfiniFiAsset).not.toHaveProperty("variantOf");

    expect(
      resolveV9WrapperStrategyTier(
        {
          variantKind: wmAsset.variantKind,
          dependencies: {
            edges: [
              {
                pathKind: "serial-dependency",
                dependencyType: "wrapper",
                upstreamAssetId: wmAsset.variantOf,
              },
            ],
          },
        } as unknown as Parameters<typeof resolveV9WrapperStrategyTier>[0],
        {
          assetId: wmAsset.id,
          serial: [{ upstreamAssetId: wmAsset.variantOf, score: 80, blocked: false }],
          basket: [],
          cycleBlocked: false,
        },
        undefined,
      ),
    ).toBe("pure");

    expect(
      resolveWrapperForm({
        variantKind: sboldAsset.variantKind,
        wrapperOperator: sboldAsset.wrapperOperator,
        dependencies: { edges: [] },
      } as never),
    ).toBe("strategy-vault");
  });

  it("retains product-shaped exit families instead of treating delayed exits as absent", () => {
    expect(OFFCHAIN_ISSUER_BACKSTOP_CONFIGS["xaut-tether"]).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      outputAssetType: "bluechip-collateral",
    });
    expect(COLLATERAL_REDEEM_BACKSTOP_CONFIGS["fpi-frax"]).toMatchObject({
      routeFamily: "collateral-redeem",
      settlementModel: "atomic",
      outputAssets: ["asset:frax"],
      capacityModel: { kind: "reserve-sync-metadata" },
    });
    expect(QUEUE_REDEEM_BACKSTOP_CONFIGS["iusd-infinifi"]).toMatchObject({
      routeFamily: "queue-redeem",
      settlementModel: "queued",
      outputAssets: ["usdc-circle"],
    });
    expect(QUEUE_REDEEM_BACKSTOP_CONFIGS["susdai-usd-ai"]).toMatchObject({
      routeFamily: "queue-redeem",
      settlementModel: "queued",
    });
    expect(STABLECOIN_REDEEM_BACKSTOP_CONFIGS["sdai-sky"]).toMatchObject({
      routeFamily: "stablecoin-redeem",
      settlementModel: "atomic",
    });
    expect(STABLECOIN_REDEEM_BACKSTOP_CONFIGS["sbold-k3-capital"]).toMatchObject({
      routeFamily: "stablecoin-redeem",
      settlementModel: "atomic",
    });
    expect(STABLECOIN_REDEEM_BACKSTOP_CONFIGS["wm-m0"]).toMatchObject({
      routeFamily: "stablecoin-redeem",
      settlementModel: "atomic",
      outputAssets: ["m-m0"],
    });
  });
});
