import { z } from "zod";
import { CanonicalTextSchema, StrictIsoDateSchema } from "@shared/lib/safety-schema-primitives";

export const SafetyScoreV9TransferPostureSchema = z.enum([
  "permissionless",
  "restrictable",
  "permissioned",
]);

export const SafetyScoreV9TransferScopeSchema = z.enum([
  "canonical",
  "material-bridge",
  "additional",
]);

const CanonicalChainIdSchema = CanonicalTextSchema.refine(
  (value) => /^[a-z0-9][a-z0-9._:-]*$/.test(value),
  "Chain ID must be a canonical lowercase identifier",
);

export function safetyScoreV9TransferDeploymentKey(
  chainId: string,
  contractOrTokenId: string,
): string {
  const trimmed = contractOrTokenId.trim();
  const canonicalTokenId = /^0x[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  return `${chainId}:${canonicalTokenId}`;
}

export const SafetyScoreV9TransferSourceSchema = z
  .object({ label: CanonicalTextSchema, url: z.string().url() })
  .strict();

export const SafetyScoreV9ReviewedTransferDeploymentSchema = z
  .object({
    chainId: CanonicalChainIdSchema,
    contractOrTokenId: CanonicalTextSchema,
    scope: SafetyScoreV9TransferScopeSchema,
    posture: SafetyScoreV9TransferPostureSchema,
    evidence: CanonicalTextSchema,
    sources: z.array(SafetyScoreV9TransferSourceSchema).min(1),
  })
  .strict();

export const SafetyScoreV9ReviewedTransferFactSchema = z
  .object({
    assetId: CanonicalTextSchema,
    reviewedAt: StrictIsoDateSchema,
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

export const SafetyScoreV9ReviewedTransferFileSchema = z
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

export type SafetyScoreV9TransferPosture = z.infer<typeof SafetyScoreV9TransferPostureSchema>;
export type SafetyScoreV9TransferScope = z.infer<typeof SafetyScoreV9TransferScopeSchema>;
export type SafetyScoreV9ReviewedTransferDeployment = z.infer<
  typeof SafetyScoreV9ReviewedTransferDeploymentSchema
>;
export type SafetyScoreV9ReviewedTransferFact = z.infer<typeof SafetyScoreV9ReviewedTransferFactSchema>;
export type SafetyScoreV9ReviewedTransferFile = z.infer<typeof SafetyScoreV9ReviewedTransferFileSchema>;
