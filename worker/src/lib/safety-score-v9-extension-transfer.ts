import transferReviewOverlaysAsset from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import { resolveChainId } from "@shared/lib/chains";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SafetyScoreV9ReviewedTransferFileSchema,
  safetyScoreV9TransferDeploymentKey,
  type SafetyScoreV9ReviewedTransferFact,
} from "@shared/types/safety-score-v9-transfer-overlays";

export { safetyScoreV9TransferDeploymentKey };
export type { SafetyScoreV9ReviewedTransferFact };

const REVIEWED_TRANSFER_FILE = SafetyScoreV9ReviewedTransferFileSchema.parse(transferReviewOverlaysAsset);

export function computeSafetyScoreV9ReviewedTransferFactsDigest(
  reviews: Iterable<SafetyScoreV9ReviewedTransferFact>,
): string {
  const canonicalReviews = [...reviews].sort((left, right) => left.assetId.localeCompare(right.assetId));
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.reviewed-transfer-overlays.v1",
      schemaVersion: 1,
      reviews: canonicalReviews,
    }),
  );
}

export const SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS: ReadonlyMap<string, SafetyScoreV9ReviewedTransferFact> = new Map(
  REVIEWED_TRANSFER_FILE.reviews.map((review) => [review.assetId, review]),
);

/**
 * Whether the asset has any surface the contract-addressed scope machinery can
 * measure. `non-contract-native` means the registry declares no contract
 * deployment on a supported chain AND no supported chain carries a material
 * share of supply — the shape of a chain-native asset (a Zano confidential
 * asset, a Zephyr protocol asset) that can never have `contracts[]` rows.
 */
export type SafetyScoreV9TransferDeploymentModel = "contract-addressable" | "non-contract-native";

export interface SafetyScoreV9TransferMaterialScope {
  authoritativeDeploymentKeys: readonly string[];
  materialDeploymentKeys: readonly string[];
  materialDeploymentScopeComplete: boolean;
  deploymentModel: SafetyScoreV9TransferDeploymentModel;
}

export interface SafetyScoreV9ResolvedTransferReview {
  observationState: "known" | "stale" | "bounded-unknown";
  posture: "permissionless" | "restrictable" | "permissioned" | null;
  structuralDisposition?: "non-contract-native";
}

/**
 * Owner ruling 2026-08-10. The material-scope test proves a review covers every
 * material *contract* deployment, so an asset whose deployment model has no
 * contracts by design was permanently bounded-unknown — reported as
 * `missing-access-review` ("we never looked") even with a complete, current,
 * primary-sourced review on file. This is the transfer-side twin of the freeze
 * `structuralDisposition` (owner ruling 2026-07-27): the honest verdict is that
 * the scope machinery is inapplicable, not that the data is missing.
 *
 * It stays fail-closed on all three legs. The registry must offer nothing
 * addressable (no supported-chain contract, no material supported-chain
 * supply), every reviewed deployment must sit on a chain outside the supported
 * chain registry (so an unreviewed EVM deployment can never be waved through as
 * "native"), and a current curated review must exist — an asset that merely
 * lacks curation has no review to reach this path at all.
 */
function reviewIsOutsideContractScope(
  review: SafetyScoreV9ReviewedTransferFact,
  materialScope: SafetyScoreV9TransferMaterialScope,
): boolean {
  return (
    materialScope.deploymentModel === "non-contract-native" &&
    review.deployments.every((deployment) => resolveChainId(deployment.chainId) === null)
  );
}

function mostRestrictiveReviewedPosture(
  review: SafetyScoreV9ReviewedTransferFact,
): "permissionless" | "restrictable" | "permissioned" {
  const postureRank = { permissionless: 0, restrictable: 1, permissioned: 2 } as const;
  return [...review.deployments].sort((left, right) => postureRank[right.posture] - postureRank[left.posture])[0]!
    .posture;
}

/**
 * Reduces deployment facts only after every material registry deployment is
 * represented by an exact chain + token identity with an applicable scope.
 * The most restrictive reviewed deployment wins; incomplete or stale scope
 * cannot publish an asset-level posture.
 */
export function resolveSafetyScoreV9ReviewedTransferFact(
  review: SafetyScoreV9ReviewedTransferFact,
  clockSec: number,
  materialScope: SafetyScoreV9TransferMaterialScope,
): SafetyScoreV9ResolvedTransferReview {
  const reviewedAtSec = Date.parse(`${review.reviewedAt}T00:00:00.000Z`) / 1_000;
  if (!Number.isFinite(reviewedAtSec)) throw new Error(`Invalid reviewed transfer date for ${review.assetId}`);
  if (reviewedAtSec > clockSec) throw new Error(`Reviewed transfer fact for ${review.assetId} is future-dated`);
  if (clockSec - reviewedAtSec > V9_ACCESS_EVIDENCE_MAX_AGE_SEC) {
    return { observationState: "stale", posture: null };
  }

  const authoritativeDeploymentKeys = new Set(materialScope.authoritativeDeploymentKeys);
  const reviewedDeploymentKeys = new Set(
    review.deployments
      .filter((deployment) => deployment.scope !== "additional")
      .map((deployment) => safetyScoreV9TransferDeploymentKey(deployment.chainId, deployment.contractOrTokenId)),
  );
  const reviewedDeploymentsAreAuthoritative = review.deployments.every((deployment) =>
    authoritativeDeploymentKeys.has(
      safetyScoreV9TransferDeploymentKey(deployment.chainId, deployment.contractOrTokenId),
    ),
  );
  const materialScopeComplete =
    materialScope.materialDeploymentScopeComplete &&
    reviewedDeploymentsAreAuthoritative &&
    materialScope.materialDeploymentKeys.every((deploymentKey) => reviewedDeploymentKeys.has(deploymentKey));
  if (!materialScopeComplete) {
    if (!reviewIsOutsideContractScope(review, materialScope)) {
      return { observationState: "bounded-unknown", posture: null };
    }
    return {
      observationState: "known",
      posture: mostRestrictiveReviewedPosture(review),
      structuralDisposition: "non-contract-native",
    };
  }

  return { observationState: "known", posture: mostRestrictiveReviewedPosture(review) };
}
