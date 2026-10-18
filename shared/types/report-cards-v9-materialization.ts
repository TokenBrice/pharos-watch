import { z } from "zod";
import { SafetyScoreV9PublicationIdentitySchema } from "./safety-score-publication";
import { Sha256Schema } from "./safety-schema-primitives";

// Independent of the compressed canonical publication's raw-size budget.
export const V9_PUBLIC_REPRESENTATION_VERSION = 1;
export const V9_PUBLIC_FRAGMENT_MAX_BYTES = 256 * 1024;
export const V9_PUBLIC_REPRESENTATION_MAX_BYTES = 16 * 1024 * 1024;
export const V9_PUBLIC_REPRESENTATION_MAX_FRAGMENTS = 128;
export const V9_PUBLIC_READ_GRACE_SEC = 300;
export const V9PublicRepresentationManifestSchema = z.object({
  version: z.literal(V9_PUBLIC_REPRESENTATION_VERSION),
  encoding: z.literal("utf8-json-health-suffix"),
  representationKey: z.string().min(1).max(200).optional(),
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
  candidateId: z.string().min(1),
  factSetDigest: Sha256Schema,
  resultDigest: Sha256Schema,
  payloadSha256: Sha256Schema,
  publishedAtSec: z.number().int().nonnegative(),
  asOfSec: z.number().int().nonnegative(),
  bytes: z.number().int().positive().max(V9_PUBLIC_REPRESENTATION_MAX_BYTES),
  sha256: Sha256Schema,
  fragments: z.array(z.object({
    bytes: z.number().int().positive().max(V9_PUBLIC_FRAGMENT_MAX_BYTES),
    sha256: Sha256Schema,
  }).strict()).min(1).max(V9_PUBLIC_REPRESENTATION_MAX_FRAGMENTS),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.fragments.reduce((sum, fragment) => sum + fragment.bytes, 0) !== manifest.bytes || manifest.asOfSec > manifest.publishedAtSec) {
    ctx.addIssue({ code: "custom", message: "Invalid public representation length or clocks" });
  }
});
export type V9PublicRepresentationManifest = z.infer<typeof V9PublicRepresentationManifestSchema>;
