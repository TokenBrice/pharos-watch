import { readFileSync } from "node:fs";
import { z } from "zod";

export const RESOURCE_HARNESS_REVISION = "full-path-post-p2-v5-calibrated-bytes";
export const RESOURCE_PHASES = ["module-initialized", "native-envelope-loaded", "native-inflate-decoded", "native-input-decoded", "enrichment-loaded", "accepted-baseline-row-loaded", "accepted-baseline-parsed", "accepted-baseline-ready", "extension-built", "facts-compiled", "evaluation-complete", "candidate-finalized", "gate-assessed", "replay-serialized", "store-admitted", "publication-gzip-complete", "score-index-serialized", "publication-committed", "alert-envelope-projected", "journal-complete", "archive-string-built", "archive-upload-pending", "publication-settled"] as const;
// PR validation runs the nine-scenario contagion matrix only when the diff can
// change it: the evaluator's esbuild import closure (shared lib/types/data
// entries below, asserted by the closure case in
// worker/scripts/__tests__/measure-v9-resource.test.ts), the probe's fact-set
// compile path, the resource harness itself and toolchain files. Any other PR
// skips contagion; no PR base (nightly/manual/local) or an unreadable diff runs it.
export const V9_CONTAGION_INPUT_PREFIXES: readonly string[] = [
  "shared/lib/safety-score-v9/",
  "shared/lib/business-calendars.ts",
  "shared/lib/compare.ts",
  "shared/lib/depeg-config.ts",
  "shared/lib/dependency-derivation.ts",
  "shared/lib/dependency-graph.ts",
  "shared/lib/evm-address.ts",
  "shared/lib/exit-route-scoring.ts",
  "shared/lib/live-reserve-adapter-descriptors.ts",
  "shared/lib/live-reserve-adapters.ts",
  "shared/lib/math.ts",
  "shared/lib/sha256.ts",
  "shared/lib/stable-json.ts",
  "shared/lib/strongly-connected-components.ts",
  "shared/lib/type-guards.ts",
  "shared/data/safety-score-v9/",
  "shared/data/business-calendars/reviewed.ts",
  "shared/types/safety-score-v9",
  "shared/types/business-calendars.ts",
  "shared/types/chain-identity.ts",
  "shared/types/coin-projection.ts",
  "shared/types/contagion.ts",
  "shared/types/core.ts",
  "shared/types/date-primitives.ts",
  "shared/types/deployment-amounts.ts",
  "shared/types/deployment-id.ts",
  "shared/types/dependency-types.ts",
  "shared/types/exit-route-identity.ts",
  "shared/types/exit-route.ts",
  "shared/types/live-reserve-adapter-declarations.ts",
  "shared/types/live-reserve-adapter-policy.ts",
  "shared/types/live-reserve-core.ts",
  "shared/types/measured-execution.ts",
  "shared/types/methodology-envelope.ts",
  "shared/types/redemption.ts",
  "shared/types/report-card-grade.ts",
  "shared/types/reserve-bounded-facts.ts",
  "shared/types/reserve-input.ts",
  "shared/types/reserve-nav-supply.ts",
  "shared/types/reserves.ts",
  "shared/types/safety-schema-primitives.ts",
  "shared/types/stablecoin-meta-control-schemas.ts",
  "shared/types/stablecoin-meta-mint-authority-refinements.ts",
  "shared/types/stablecoin-meta-primitives.ts",
  "shared/types/stablecoin-taxonomy.ts",
  "shared/types/validators.ts",
  "worker/src/lib/safety-score-v9/fact-set",
  "worker/src/lib/__tests__/safety-score-v9-resource-",
  "worker/src/lib/__tests__/fixtures/safety-score-v9-",
  "worker/scripts/lib/v9-resource",
  "worker/scripts/measure-v9-resource.ts",
  "worker/scripts/calibrate-v9-resource.ts",
  "scripts/maintenance/run-v9-resource-lane.ts",
];
// Package metadata, tsconfig/vitest/wrangler config and Node version files can
// change the probe build or its runtime; mirror the deploy classifier's rule.
const V9_CONTAGION_TOOLCHAIN_PATTERN = /(^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vitest[^/]*|wrangler[^/]*|\.nvmrc|\.npmrc|\.node-version|\.tool-versions|mise\.toml|\.mise\.toml)$/;
export function hasV9ContagionInput(files: readonly string[]): boolean {
  return files.some((raw) => {
    const file = raw.replaceAll("\\", "/");
    return V9_CONTAGION_INPUT_PREFIXES.some((prefix) => file.startsWith(prefix)) || V9_CONTAGION_TOOLCHAIN_PATTERN.test(file);
  });
}
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
