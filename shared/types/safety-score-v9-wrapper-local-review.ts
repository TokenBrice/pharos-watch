import { z } from "zod";
import { CanonicalChainIdSchema, CanonicalTextSchema, UnixSecondsSchema, V9RouteHolderAccessSchema, V9RouteExecutionModelSchema } from "./safety-score-v9-fact-input-primitives";
import { V9AllocationScopeIdentityReviewSchema, allocationReviewClockSec } from "./safety-score-v9-allocation";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

const CommonReviewFields = {
  assetId: CanonicalTextSchema,
  reviewer: CanonicalTextSchema,
  reviewedAt: z.union([StrictIsoDateSchema, z.iso.datetime()]),
  observedAtSec: UnixSecondsSchema,
  expiresAtSec: UnixSecondsSchema,
  rationale: CanonicalTextSchema,
  sources: z.array(z.object({ label: CanonicalTextSchema, url: z.string().url() }).strict()).min(1),
  observations: z.array(z.object({ sourceUrl: z.string().url(), description: CanonicalTextSchema }).strict()).min(1),
};
const ReviewFields = { ...CommonReviewFields, identity: V9AllocationScopeIdentityReviewSchema };
// Published terms bind a holder deployment, not a live implementation or an
// executable-capacity observation. Code-certified favorable accounting keeps the
// stricter pinned identity path above.
const PublishedIdentitySchema = z.object({
  assetId: CanonicalTextSchema,
  deployments: z.array(z.object({
    chain: CanonicalChainIdSchema, address: CanonicalTextSchema, sourceUrl: z.string().url(),
  }).strict()).min(1),
}).strict();
const PublishedFields = { ...CommonReviewFields, identity: PublishedIdentitySchema };
const WithdrawalTermSchema = z.object({
  routeKey: CanonicalTextSchema,
  deploymentKey: CanonicalTextSchema,
  sourceUrl: z.string().url(),
  outputAssetIds: z.array(CanonicalTextSchema).min(1),
  holderAccess: V9RouteHolderAccessSchema,
  executionModel: V9RouteExecutionModelSchema,
  cooldownSec: UnixSecondsSchema.nullable(),
  // A cooldown is an eligibility floor, never an end-to-end settlement bound.
  settlementBoundSec: UnixSecondsSchema.nullable(),
  fee: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fixed-bps"), bps: z.number().finite().nonnegative() }).strict(),
    z.object({ kind: z.literal("formula"), description: CanonicalTextSchema }).strict(),
    z.object({ kind: z.literal("undisclosed") }).strict(),
  ]),
  prerequisites: z.array(CanonicalTextSchema),
}).strict().superRefine((term, ctx) => {
  if (term.cooldownSec !== null && term.settlementBoundSec !== null && term.settlementBoundSec < term.cooldownSec) {
    ctx.addIssue({ code: "custom", path: ["settlementBoundSec"], message: "Settlement bound cannot precede eligibility" });
  }
});

// These are independent local facts, not allocation grades or executable exits.
export const SafetyScoreV9WrapperLocalReviewSchema = z.discriminatedUnion("kind", [
  z.object({ ...ReviewFields, kind: z.literal("accounting"), mechanism: z.enum(["vault-v2-share-accounting", "fixed-face-accounting"]) }).strict(),
  z.object({ ...ReviewFields, kind: z.literal("holder-entitlement"), entitlement: z.literal("no-public-holder-withdrawal-or-unwrap") }).strict(),
  z.object({ ...ReviewFields, kind: z.literal("contract-mutability"), mutability: z.literal("upgradeable-root"), minimumPublicDelaySec: UnixSecondsSchema.nullable() }).strict(),
  z.object({ ...PublishedFields, kind: z.literal("published-accounting"), mechanism: z.literal("fixed-face-accounting") }).strict(),
  z.object({ ...PublishedFields, kind: z.literal("published-emergency-controls"), capabilities: z.array(z.enum(["pause", "attester-change", "minimum-burn-change", "admin-change"])).min(1) }).strict(),
  z.object({ ...PublishedFields, kind: z.literal("published-withdrawal-terms"), terms: z.array(WithdrawalTermSchema).min(1) }).strict(),
]).superRefine((review, ctx) => {
  const fail = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (review.assetId !== review.identity.assetId) fail(["identity", "assetId"], "Local review identity must match its asset");
  if (review.observedAtSec > allocationReviewClockSec(review.reviewedAt)) fail(["reviewedAt"], "Review cannot precede its observation");
  if (review.expiresAtSec <= allocationReviewClockSec(review.reviewedAt)) fail(["expiresAtSec"], "Review expiry must follow its review");
  const sources = new Set(review.sources.map((source) => source.url));
  for (const row of review.identity.deployments) {
    if (!sources.has(row.sourceUrl) || ("observedAtSec" in row && row.observedAtSec > review.observedAtSec)) fail(["identity"], "Deployment identity must bind the reviewed sources and clock");
  }
  const deploymentKeys = review.identity.deployments.map((row) => `${row.chain}:${row.address}`);
  if (new Set(deploymentKeys).size !== deploymentKeys.length) fail(["identity"], "Deployment identities must be unique");
  if (review.kind === "contract-mutability" && !review.identity.deployments.some((row) => row.codeKind === "proxy")) {
    fail(["identity"], "Upgradeable root review requires a pinned proxy");
  }
  if (review.kind === "published-withdrawal-terms") {
    if (new Set(review.terms.map((term) => term.routeKey)).size !== review.terms.length) fail(["terms"], "Withdrawal route keys must be unique");
    for (const term of review.terms) {
      if (!sources.has(term.sourceUrl) || !deploymentKeys.includes(term.deploymentKey)) fail(["terms"], "Withdrawal terms must bind their reviewed source and holder deployment");
    }
  }
  for (const observation of review.observations) {
    if (!sources.has(observation.sourceUrl)) fail(["observations"], "Observation must bind a reviewed source");
  }
});
export type SafetyScoreV9WrapperLocalReview = z.output<typeof SafetyScoreV9WrapperLocalReviewSchema>;
