import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import iusdInfiniFiAsset from "@shared/data/stablecoins/coins/iusd-infinifi.json";
import sboldAsset from "@shared/data/stablecoins/coins/sbold-k3-capital.json";
import sdaiAsset from "@shared/data/stablecoins/coins/sdai-sky.json";
import susdaiAsset from "@shared/data/stablecoins/coins/susdai-usd-ai.json";
import wmAsset from "@shared/data/stablecoins/coins/wm-m0.json";
import {
  evaluateV9MechanismProfileCoverage,
  projectV9MechanismProfile,
} from "@shared/lib/safety-score-v9/mechanism-profiles";
import { resolveV9WrapperStrategyTier } from "@shared/lib/safety-score-v9/evaluate-set";
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
} from "../safety-score-v9-extension-mechanism";

type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

const PROFILE_CLOCK_SEC = Date.UTC(2026, 6, 25) / 1_000;
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
  it("carries XAUT allocated-commodity facts and explicit issuer nondisclosure into backing", () => {
    const overlay = namedOverlay("xaut-tether");
    expect(overlay.profileReview?.profile).toBe("allocated-commodity-claim");
    const profile = projectV9MechanismProfile(overlay.profileReview!);
    const coverage = evaluateV9MechanismProfileCoverage(overlay.profileReview!);
    const review = buildSafetyScoreV9MechanismReview(
      PROFILE_FIXED_INPUT,
      { id: "xaut-tether" } as MechanismMeta,
      "fiat-cash",
    );
    if (review?.archetype !== "fiat-cash") throw new Error("expected the production XAUT profile review");

    expect(profile.exitFacts.physicalRedemption).toEqual({
      disposition: "supported",
      quality: "limited",
    });
    expect(getSafetyScoreV9MechanismExitFacts("xaut-tether", "fiat-cash", PROFILE_CLOCK_SEC)).toEqual([
      {
        factKey: "physical-redemption",
        disposition: "supported",
        quality: "limited",
      },
    ]);
    expect(coverage.gaps).toEqual([
      { factKey: "custodyContinuity", responsibility: "issuer-undisclosed" },
      { factKey: "insurance", responsibility: "issuer-undisclosed" },
    ]);
    expect(review).toMatchObject({
      archetype: "fiat-cash",
      claimAndSegregation: {
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
    });
  });

  it("gives FPI a CPI-hybrid review without erasing FRAX/reflexive exposure", () => {
    const overlay = namedOverlay("fpi-frax");
    expect(overlay.profileReview?.profile).toBe("inflation-index-hybrid");
    const profile = projectV9MechanismProfile(overlay.profileReview!);
    const review = buildSafetyScoreV9MechanismReview(
      PROFILE_FIXED_INPUT,
      { id: "fpi-frax" } as MechanismMeta,
      "algorithmic",
    );
    if (review?.archetype !== "algorithmic") throw new Error("expected the production FPI profile review");

    expect(profile.metrics).toEqual({
      exogenousBackingShare: 0.817,
      reflexiveBackingShare: 0.076,
      contractionCapacityRatio: 0.817,
    });
    expect(getSafetyScoreV9MechanismExitFacts("fpi-frax", "algorithmic", PROFILE_CLOCK_SEC)).toEqual([
      {
        factKey: "protocol-redemption",
        disposition: "supported",
        quality: "adequate",
      },
    ]);
    expect(review).toMatchObject({
      archetype: "algorithmic",
      exogenousBackingShare: 0.817,
      reflexiveBackingShare: 0.076,
      contractionCapacityRatio: 0.817,
      contractionCapacity: {
        status: { observationState: "bounded-unknown" },
        quality: null,
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
        status: { observationState: "bounded-unknown" },
        quality: null,
      },
      lossRecovery: {
        status: { observationState: "bounded-unknown" },
        quality: null,
      },
    });
  });

  it("keeps pure wrappers, native savings, Stability Pools, and strategy vaults distinct", () => {
    expect(wmAsset).toMatchObject({
      variantOf: "m-m0",
      variantKind: "pure-wrapper",
      pegReferenceId: "m-m0",
      flags: { navToken: false },
    });
    expect(sdaiAsset.variantKind).toBe("savings-passthrough");
    expect(sboldAsset.variantKind).toBe("risk-absorption");
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
