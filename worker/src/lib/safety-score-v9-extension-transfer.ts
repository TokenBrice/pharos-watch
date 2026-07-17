import transferReviewOverlaysAsset from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";

const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");
const CanonicalChainIdSchema = CanonicalTextSchema.refine(
  (value) => /^[a-z0-9][a-z0-9._:-]*$/.test(value),
  "Chain ID must be a canonical lowercase identifier",
);
const TransferPostureSchema = z.enum(["permissionless", "restrictable", "permissioned"]);
const TransferSourceSchema = z.object({ label: CanonicalTextSchema, url: z.string().url() }).strict();

function canonicalTransferTokenId(contractOrTokenId: string): string {
  const trimmed = contractOrTokenId.trim();
  return /^0x[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function safetyScoreV9TransferDeploymentKey(chainId: string, contractOrTokenId: string): string {
  return `${chainId}:${canonicalTransferTokenId(contractOrTokenId)}`;
}

export const SafetyScoreV9ReviewedTransferDeploymentSchema = z
  .object({
    chainId: CanonicalChainIdSchema,
    contractOrTokenId: CanonicalTextSchema,
    scope: z.enum(["canonical", "material-bridge", "additional"]),
    posture: TransferPostureSchema,
    evidence: CanonicalTextSchema,
    sources: z.array(TransferSourceSchema).min(1),
  })
  .strict();

export const SafetyScoreV9ReviewedTransferFactSchema = z
  .object({
    assetId: CanonicalTextSchema,
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reviewer: CanonicalTextSchema,
    deployments: z.array(SafetyScoreV9ReviewedTransferDeploymentSchema).min(1),
  })
  .strict()
  .superRefine((review, ctx) => {
    const deploymentKeys = review.deployments.map((deployment) =>
      safetyScoreV9TransferDeploymentKey(deployment.chainId, deployment.contractOrTokenId),
    );
    if (new Set(deploymentKeys).size !== deploymentKeys.length) {
      ctx.addIssue({ code: "custom", path: ["deployments"], message: "Duplicate reviewed transfer deployment" });
    }
    if (!review.deployments.some((deployment) => deployment.scope === "canonical")) {
      ctx.addIssue({
        code: "custom",
        path: ["deployments"],
        message: "A reviewed transfer fact requires at least one canonical deployment",
      });
    }
  });

const SafetyScoreV9ReviewedTransferFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    note: CanonicalTextSchema,
    reviews: z.array(SafetyScoreV9ReviewedTransferFactSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const assetIds = file.reviews.map((review) => review.assetId);
    if (new Set(assetIds).size !== assetIds.length) {
      ctx.addIssue({ code: "custom", path: ["reviews"], message: "Duplicate reviewed transfer assetId" });
    }
  });

export type SafetyScoreV9ReviewedTransferFact = z.infer<typeof SafetyScoreV9ReviewedTransferFactSchema>;

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

export const SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS_DIGEST = computeSafetyScoreV9ReviewedTransferFactsDigest(
  SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS.values(),
);

export interface SafetyScoreV9TransferMaterialScope {
  authoritativeDeploymentKeys: readonly string[];
  materialDeploymentKeys: readonly string[];
  materialDeploymentScopeComplete: boolean;
}

export interface SafetyScoreV9ResolvedTransferReview {
  observationState: "known" | "stale" | "bounded-unknown";
  posture: "permissionless" | "restrictable" | "permissioned" | null;
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
  if (!materialScopeComplete) return { observationState: "bounded-unknown", posture: null };

  const postureRank = { permissionless: 0, restrictable: 1, permissioned: 2 } as const;
  const posture = [...review.deployments].sort(
    (left, right) => postureRank[right.posture] - postureRank[left.posture],
  )[0]!.posture;
  return { observationState: "known", posture };
}
