import { readFileSync } from "node:fs";
import { z } from "zod";

export const RESOURCE_HARNESS_REVISION = "full-path-post-p2-v2";
export const RESOURCE_PHASES = ["module-initialized", "native-envelope-loaded", "native-inflate-decoded", "native-input-decoded", "enrichment-loaded", "accepted-baseline-row-loaded", "accepted-baseline-parsed", "accepted-baseline-ready", "extension-built", "facts-compiled", "evaluation-complete", "candidate-finalized", "gate-assessed", "replay-serialized", "store-admitted", "publication-gzip-complete", "score-index-serialized", "publication-committed", "alert-envelope-projected", "journal-complete", "archive-string-built", "archive-upload-pending", "publication-settled"] as const;
export const GLOBAL_HEAP_BYTES = 112 * 1024 * 1024;
export const CALIBRATION_MAX_BYTES = 110 * 1024 * 1024;
export const TOLERANCE_BYTES = 2 * 1024 * 1024;
export const ROUNDING_BYTES = 256 * 1024;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().positive().max(GLOBAL_HEAP_BYTES);
export const ResourceIdentitySchema = z.object({
  harnessRevision: z.literal(RESOURCE_HARNESS_REVISION), phaseManifest: z.literal("post-p2"),
  node: z.string().min(1), v8: z.string().min(1), esbuild: z.string().min(1), wrangler: z.string().min(1),
  platform: z.string().min(1), arch: z.string().min(1),
  runner: z.object({ kind: z.enum(["github", "local"]), description: z.string().min(1), image: z.string().min(1), version: z.string().min(1) }).strict(),
  fixture: z.object({ kind: z.literal("current-full-registry-native"), sourceSha256: sha256, manifestSha256: sha256 }).strict(),
  protocolSha256: sha256,
  configSha256: sha256,
}).strict();
export type ResourceIdentity = z.infer<typeof ResourceIdentitySchema>;
// Runner images, protocol/source hashes (including package-lock) are evidence,
// not build identity. Keep this projection shared with calibration.
export function resourceBuildIdentity(identity: ResourceIdentity) {
  const { runner: _runner, protocolSha256: _protocol, ...build } = ResourceIdentitySchema.parse(identity);
  return build;
}
export const ResourcePolicySchema = z.object({
  schemaVersion: z.literal(1), identity: ResourceIdentitySchema,
  globalPostGcHeapBytes: z.literal(GLOBAL_HEAP_BYTES), hardCapOldSpaceMiB: z.literal(128), measurementOldSpaceMiB: z.literal(256),
  toleranceBytes: z.literal(TOLERANCE_BYTES), roundingBytes: z.literal(ROUNDING_BYTES),
  phaseLimitsBytes: z.record(z.string(), bytes),
  calibration: z.object({
    revision: z.string().min(1), reportSha256s: z.array(sha256).length(5), natural128MiBSuccesses: z.literal(5),
    phaseMaximaBytes: z.record(z.string(), z.number().int().positive().max(CALIBRATION_MAX_BYTES)),
  }).strict(),
}).strict().superRefine((policy, ctx) => {
  if (new Set(policy.calibration.reportSha256s).size !== 5) ctx.addIssue({ code: "custom", message: "five distinct report hashes required" });
  for (const field of ["phaseLimitsBytes", "calibration"] as const) {
    const values = field === "calibration" ? policy.calibration.phaseMaximaBytes : policy.phaseLimitsBytes;
    if (Object.keys(values).length !== RESOURCE_PHASES.length || RESOURCE_PHASES.some((phase) => !(phase in values))) ctx.addIssue({ code: "custom", message: `invalid phase set: ${field}` });
  }
  for (const phase of RESOURCE_PHASES) {
    const expected = Math.min(GLOBAL_HEAP_BYTES, Math.ceil((policy.calibration.phaseMaximaBytes[phase] + TOLERANCE_BYTES) / ROUNDING_BYTES) * ROUNDING_BYTES);
    if (policy.phaseLimitsBytes[phase] !== expected) ctx.addIssue({ code: "custom", message: `invalid calibrated limit: ${phase}` });
  }
});
export type ResourcePolicy = z.infer<typeof ResourcePolicySchema>;
export function validateResourcePolicy(value: unknown, identity: ResourceIdentity): ResourcePolicy {
  const policy = ResourcePolicySchema.parse(value);
  const expected = resourceBuildIdentity(identity);
  const actual = resourceBuildIdentity(policy.identity);
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) throw new Error(`resource-policy-identity-mismatch:${key}`);
  }
  return policy;
}

export function loadResourcePolicy(path: string, identity: ResourceIdentity, allowUnqualified = false): ResourcePolicy | null {
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch (error) {
    // Only an explicitly absent file can be unqualified; invalid existing evidence is never a fallback.
    if (allowUnqualified && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return validateResourcePolicy(JSON.parse(content), identity);
}
