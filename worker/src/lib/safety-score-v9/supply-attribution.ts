import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { supplyAttributionPinMaxAgeSec, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9_CHAIN_SUPPLY_PROVIDER_SOURCE_ID } from "@shared/types/safety-score-v9";
import { deploymentSupplyCensusMaxAgeSec } from "@shared/types/safety-score-v9-deployment-supply-census";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import { XAUT_ASSET_ID, XAUT_SUPPLY_ATTRIBUTION_CARRY_FORWARD_MAX_AGE_SEC, XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC } from "./xaut-supply-attribution-contract";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { SupplyAttributionJournalV1 } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { CENTRIFUGE_BURN_MINT_ASSET_IDS, REVIEWED_ECONOMIC_SUPPLY_PLANS, hasCompleteEligibleProviderSupply } from "./supply-attribution-contract";
import type { SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";

// Replay reads only the captured partition; observers live in supply-attribution-capture.ts.
type V9CurrentChainRows = Record<string, { current: number }>;

export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS = Object.freeze([
  "wm-m0",
  XAUT_ASSET_ID,
  ...CENTRIFUGE_BURN_MINT_ASSET_IDS,
  ...REVIEWED_ECONOMIC_SUPPLY_PLANS.keys(),
]);
if (SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.length > SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS ||
  new Set(SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS).size !== SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.length) {
  throw new Error("Supply attribution reviewed registry exceeds the bounded cohort or overlaps an existing proof lane");
}

export function safetyScoreV9ChainRows(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
): V9CurrentChainRows {
  const attribution = fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  if (attribution?.model === "canonical-lock-mint-partition-v1") {
    return Object.fromEntries(
      Object.entries(attribution.currentSupplyUsdByChain).map(([chain, current]) => [chain, { current }]),
    );
  }
  if (attribution?.model === "canonical-lock-mint-group-partition-v2") {
    return {
      [attribution.canonical.chainId]: {
        current: attribution.canonical.currentSupplyUsd,
      },
      [attribution.representationGroup.deploymentRouteKey]: {
        current: attribution.representationGroup.currentSupplyUsd,
      },
    };
  }
  if (attribution?.model === "reviewed-economic-deployment-partition-v1") {
    const rows: V9CurrentChainRows = {};
    for (const deployment of attribution.deployments) {
      rows[deployment.chainId] = { current: (rows[deployment.chainId]?.current ?? 0) + deployment.currentSupplyUsd };
    }
    if (attribution.unattributedSupplyUsd > 0) rows[`unmatched-economic:${assetId}`] = { current: attribution.unattributedSupplyUsd };
    return rows;
  }
  if (attribution?.model === "reviewed-deployment-unit-partition-v1") {
    const rows: V9CurrentChainRows = {};
    for (const deployment of attribution.deployments) {
      rows[deployment.chainId] = {
        current: (rows[deployment.chainId]?.current ?? 0) + deployment.currentSupplyUsd,
      };
    }
    return rows;
  }
  if (assetId === XAUT_ASSET_ID) return {};
  return fixedInput.chainCirculatingById[assetId] ?? {};
}

export function safetyScoreV9ChainSupplyObservedAtSec(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  fallbackObservedAtSec: number,
): number {
  const attribution =
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  const aggregateObservedAtSec =
    fixedInput.aggregateCirculatingById[assetId]?.observedAtSec;
  if (!attribution) return aggregateObservedAtSec ?? fallbackObservedAtSec;
  return Math.min(
    attribution.observedAtSec,
    aggregateObservedAtSec ?? fallbackObservedAtSec,
  );
}

/** Evidence source ids of the non-provider chain-supply lanes. */
export const SAFETY_SCORE_V9_CHAIN_SUPPLY_LOCK_MINT_SOURCE_ID = "safety-score-v9-lock-mint-attribution";
export const SAFETY_SCORE_V9_CHAIN_SUPPLY_REVIEWED_DEPLOYMENT_SOURCE_ID = "safety-score-v9-reviewed-deployment-attribution";

/** Evidence source id of the v10.38 per-deployment supply census bounds. */
export const SAFETY_SCORE_V9_CHAIN_SUPPLY_DEPLOYMENT_CENSUS_SOURCE_ID = "deployment-supply-census-v1";

/**
 * Evaluation-time ceiling for one census bound (PLAN §4.6 R3, OP-R0 S-14).
 * The store and the consumer read the one declared per-source chain-supply
 * ceiling for `deployment-supply-census-v1`, so a packet the store serves is
 * never rejected only because this lane used a narrower window. An expired
 * bound still returns the deployment's datums to required on the next capture:
 * there is no carry-forward and no re-dating.
 */
export function safetyScoreV9DeploymentSupplyCensusMaxAgeSec(): number {
  return deploymentSupplyCensusMaxAgeSec();
}

/**
 * Single authority for the evidence source id that owns an asset's chain-supply
 * rows. The published chain-supply evidence and the per-source ceiling both
 * resolve through it, so a new attribution model cannot inherit another lane's
 * ceiling by accident.
 */
export function safetyScoreV9ChainSupplySourceId(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
): string {
  const attribution = fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  switch (attribution?.model) {
    case undefined:
      return V9_CHAIN_SUPPLY_PROVIDER_SOURCE_ID;
    case "reviewed-economic-deployment-partition-v1":
      return V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.journalSourceId;
    case "canonical-lock-mint-partition-v1":
    case "canonical-lock-mint-group-partition-v2":
      return SAFETY_SCORE_V9_CHAIN_SUPPLY_LOCK_MINT_SOURCE_ID;
    case "reviewed-deployment-unit-partition-v1":
      return SAFETY_SCORE_V9_CHAIN_SUPPLY_REVIEWED_DEPLOYMENT_SOURCE_ID;
  }
}

/**
 * v10.38 per-source chain-supply ceiling
 * (`semantic.supplyAttribution.chainSupplyMaxAgeBySource`). A listed source has
 * one ceiling; an unlisted source fails closed to the policy default window
 * (base plus carry). `declaredMaxAgeSec` is the source clock's own published
 * window and may only tighten that default, never raise it.
 */
export function safetyScoreV9ChainSupplyMaxAgeSecForSource(
  sourceId: string,
  declaredMaxAgeSec: number | null = null,
): number {
  const { defaultMaxAgeSec, carryForwardExtraSec, maxAgeSecBySource } =
    V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.chainSupplyMaxAgeBySource;
  const listedMaxAgeSec = maxAgeSecBySource[sourceId];
  if (listedMaxAgeSec !== undefined) return listedMaxAgeSec;
  const baseMaxAgeSec = declaredMaxAgeSec === null
    ? defaultMaxAgeSec
    : Math.min(declaredMaxAgeSec, defaultMaxAgeSec);
  return baseMaxAgeSec + carryForwardExtraSec;
}

export function safetyScoreV9ChainSupplyMaxAgeSec(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  fallbackMaxAgeSec: number | null,
): number | null {
  const attribution =
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  // Per-asset lane admission contracts keep their reviewed windows; they are
  // narrower than the generic source ceiling and must never contradict the
  // capture-time gate that admitted the packet.
  if (attribution?.model === "reviewed-economic-deployment-partition-v1") {
    return supplyAttributionPinMaxAgeSec(attribution.deployments.map((row) => row.chainId));
  }
  if (assetId === XAUT_ASSET_ID && attribution?.model === "canonical-lock-mint-group-partition-v2") {
    return attribution.carriedForwardFromGenerationId === undefined
      ? XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC
      : XAUT_SUPPLY_ATTRIBUTION_CARRY_FORWARD_MAX_AGE_SEC;
  }
  return safetyScoreV9ChainSupplyMaxAgeSecForSource(
    safetyScoreV9ChainSupplySourceId(fixedInput, assetId),
    fallbackMaxAgeSec,
  );
}

export function safetyScoreV9ChainSupplySourcePayload(fixedInput: Readonly<SafetyScoreV9CompilerInput>) {
  const attributionById = fixedInput.safetyScoreV9SupplyAttributionById ?? {};
  return {
    chainCirculatingById: fixedInput.chainCirculatingById,
    ...(Object.keys(attributionById).length > 0
      ? { safetyScoreV9SupplyAttributionById: attributionById }
      : {}),
    dexDeploymentSupplyCoverageById: fixedInput.dexDeploymentSupplyCoverageById,
  };
}

export function safetyScoreV9ChainSupplySourceGenerationId(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
): string {
  const digest = sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.chain-supply.v1",
      payload: safetyScoreV9ChainSupplySourcePayload(fixedInput),
    }),
  );
  return `chain-supply:v1:${digest}`;
}

export function aggregateSupplyUsd(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  assetId: string,
): number | null {
  return getCirculatingRawOrNull(fixedInput.aggregateCirculatingById[assetId]);
}

function hasUpstreamChainSupply(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  assetId: string,
): boolean {
  // A positive provider subtotal cannot suppress an exhaustive deployment
  // census. Complete, current, aggregate-reconciled provider inventories still
  // win; ambiguous same-chain rows and omitted zero legs do not.
  return hasCompleteEligibleProviderSupply(fixedInput, assetId);
}

export function safetyScoreV9SupplyAttributionExpectedAssetIds(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
): string[] {
  const activeAssetIds = new Set(fixedInput.activeAssetIds);
  return SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.filter(
    (assetId) =>
      activeAssetIds.has(assetId) &&
      (assetId === XAUT_ASSET_ID ||
        !hasUpstreamChainSupply(fixedInput, assetId)),
  );
}

/**
 * Single owner of the asset → journal sourceId binding; the descriptor table
 * and the generation-side binding assertions resolve through it.
 */
export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET: Readonly<
  Record<string, SupplyAttributionJournalV1["sourceId"]>
> = {
  [XAUT_ASSET_ID]: "xaut.canonical-lock-mint-group-partition.v2",
  ...Object.fromEntries([...REVIEWED_ECONOMIC_SUPPLY_PLANS.keys()].map(assetId => [
    assetId, V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.journalSourceId,
  ])),
  "wm-m0": "wm.reviewed-deployment-unit-partition.v1",
  ...Object.fromEntries(
    CENTRIFUGE_BURN_MINT_ASSET_IDS.map(
      (assetId): [string, SupplyAttributionJournalV1["sourceId"]] => [
        assetId,
        "centrifuge.reviewed-deployment-unit-partition.v1",
      ],
    ),
  ),
};
