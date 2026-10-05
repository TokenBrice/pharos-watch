import { z } from "zod";
import { CanonicalTextSchema, UnixSecondsSchema } from "./safety-score-v9-fact-input-primitives";
import { V9AllocationScopeIdentityReviewSchema, allocationReviewClockSec } from "./safety-score-v9-allocation";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

const ReviewFields = {
  assetId: CanonicalTextSchema,
  reviewer: CanonicalTextSchema,
  reviewedAt: z.union([StrictIsoDateSchema, z.iso.datetime()]),
  observedAtSec: UnixSecondsSchema,
  expiresAtSec: UnixSecondsSchema,
  identity: V9AllocationScopeIdentityReviewSchema,
  rationale: CanonicalTextSchema,
  sources: z.array(z.object({ label: CanonicalTextSchema, url: z.string().url() }).strict()).min(1),
  observations: z.array(z.object({ sourceUrl: z.string().url(), description: CanonicalTextSchema }).strict()).min(1),
};

// These are independent local facts, not allocation grades or executable exits.
export const SafetyScoreV9WrapperLocalReviewSchema = z.discriminatedUnion("kind", [
  z.object({ ...ReviewFields, kind: z.literal("accounting"), mechanism: z.enum(["vault-v2-share-accounting", "fixed-face-accounting"]) }).strict(),
  z.object({ ...ReviewFields, kind: z.literal("holder-entitlement"), entitlement: z.literal("no-public-holder-withdrawal-or-unwrap") }).strict(),
]).superRefine((review, ctx) => {
  const fail = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (review.assetId !== review.identity.assetId) fail(["identity", "assetId"], "Local review identity must match its asset");
  if (review.observedAtSec > allocationReviewClockSec(review.reviewedAt)) fail(["reviewedAt"], "Review cannot precede its observation");
  if (review.expiresAtSec <= allocationReviewClockSec(review.reviewedAt)) fail(["expiresAtSec"], "Review expiry must follow its review");
  const sources = new Set(review.sources.map((source) => source.url));
  for (const row of review.identity.deployments) {
    if (!sources.has(row.sourceUrl) || row.observedAtSec > review.observedAtSec) fail(["identity"], "Deployment pins must bind the reviewed sources and clock");
  }
  for (const observation of review.observations) {
    if (!sources.has(observation.sourceUrl)) fail(["observations"], "Observation must bind a reviewed source");
  }
});
export type SafetyScoreV9WrapperLocalReview = z.output<typeof SafetyScoreV9WrapperLocalReviewSchema>;
