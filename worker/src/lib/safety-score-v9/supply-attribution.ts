import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { supplyAttributionPinMaxAgeSec, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9_EVIDENCE_PRODUCER_INTERVAL_SEC } from "@shared/lib/cron-cadences";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import { XAUT_ASSET_ID, XAUT_SUPPLY_ATTRIBUTION_CARRY_FORWARD_MAX_AGE_SEC, XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC } from "./xaut-supply-attribution-contract";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { SupplyAttributionJournalV1 } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { CENTRIFUGE_BURN_MINT_ASSET_IDS, REVIEWED_ECONOMIC_SUPPLY_PLANS, SUPPLY_ATTRIBUTION_CARRY_FORWARD_EXTRA_AGE_SEC, hasCompleteEligibleProviderSupply } from "./supply-attribution-contract";
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

/**
 * When a sync-stablecoins run does not re-observe an asset, the producer keeps
 * its last observed supply with the original supplyObservedAt. That retained
 * per-asset observation stays usable for four more producer intervals beyond
 * the chain-supply budget (1800s to 5400s): the next scheduled sync, up to two
 * missed provider observations, and one retry. A fresh observation always
 * replaces it, so the window cannot mask a supply move the provider reports.
 */
export const CHAIN_SUPPLY_CARRY_FORWARD_EXTRA_AGE_SEC = V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-stablecoins"] * 4;

export function safetyScoreV9ChainSupplyMaxAgeSec(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  fallbackMaxAgeSec: number | null,
): number | null {
  const attribution =
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  // XAUT's finalized Ethereum observation has an explicit one-hour window.
  // Preserve that same bound when the accepted packet becomes fact evidence;
  // otherwise the generic chain-supply window would immediately contradict
  // the per-asset admission contract.
  if (attribution?.model === "reviewed-economic-deployment-partition-v1") {
    return supplyAttributionPinMaxAgeSec(attribution.deployments.map((row) => row.chainId));
  }
  if (assetId === XAUT_ASSET_ID && attribution?.model === "canonical-lock-mint-group-partition-v2") {
    return attribution.carriedForwardFromGenerationId === undefined
      ? XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC
      : XAUT_SUPPLY_ATTRIBUTION_CARRY_FORWARD_MAX_AGE_SEC;
  }
  // A carried-forward packet keeps its original observation clock; its
  // evidence stays current only through the bounded carry window.
  if (attribution?.model === "reviewed-deployment-unit-partition-v1" &&
      attribution.carriedForwardFromGenerationId !== undefined && fallbackMaxAgeSec !== null) {
    return fallbackMaxAgeSec + SUPPLY_ATTRIBUTION_CARRY_FORWARD_EXTRA_AGE_SEC;
  }
  // Only a per-asset observation the producer retained past the chain-supply
  // budget is carried; the evidence names the widened budget and its age.
  const aggregateObservedAtSec = fixedInput.aggregateCirculatingById[assetId]?.observedAtSec;
  if (!attribution && fallbackMaxAgeSec !== null && aggregateObservedAtSec != null &&
      fixedInput.clockSec - aggregateObservedAtSec > fallbackMaxAgeSec) {
    return fallbackMaxAgeSec + CHAIN_SUPPLY_CARRY_FORWARD_EXTRA_AGE_SEC;
  }
  return fallbackMaxAgeSec;
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
