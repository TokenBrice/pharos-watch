import { SELECTOR_SNAPSHOT_VERIFICATION_KIND } from "./vocabulary";
import { isRecord } from "../type-guards";
import { canonicalizeForSid } from "./canonicalize";
import { normalizeSelectorCanonicalSources, normalizeSelectorInput, normalizeSelectorSnapshot } from "./snapshot-normalize";
import { sha256Hex } from "../sha256";
import {
  SelectorInput,
  SelectorOutput,
  SelectorCanonicalSourceEvidence,
} from "./types";
import { SelectorInputSchema, OutputShapeSchema } from "./snapshot-schemas";
export {
  SelectorInputSchema,
  SelectorComponentSchema,
  LowestSubDimensionSchema,
  RecommendedSourceSchema,
  SelectorChainHintsSchema,
  SelectorRankRobustnessSchema,
  SelectorConfidenceReasonSchema,
  TreasuryRecommendationSchema,
  YieldRecommendationSchema,
  TradingRecommendationSchema,
  SelectorRecommendationSchema,
  SelectorLowerRankedSchema,
  SkippedCoinSchema,
  SelectorCoverageWarningsSchema,
  MethodologyVersionsSchema,
  SelectorExclusionSummaryItemSchema,
  SelectorClosestSurvivorSchema,
  SelectorRelaxableConstraintSchema,
  SelectorSnapshotVerificationSchema,
  SelectorOutputSchema,
} from "./snapshot-schemas";

export const SELECTOR_SNAPSHOT_SID_PATTERN = /^[0-9a-f]{32}$/;
export const SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES = 100 * 1024;
export const SELECTOR_SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;
// Unauthenticated POSTs get a bounded unread TTL; the first successful read
// extends the snapshot to the full retention TTL. Caps the storage blast
// radius of write spam without weakening retention for links actually shared.
export const SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS = 60 * 60 * 24 * 90;

const MAX_JSON_DEPTH = 12;

export type SelectorSnapshotValidationError = "unsafe" | "shape";

export type SelectorSnapshotValidationResult =
  | { ok: true; snapshot: SelectorOutput }
  | { ok: false; error: SelectorSnapshotValidationError };

export type SelectorSnapshotInputValidationResult =
  | { ok: true; input: SelectorInput }
  | { ok: false; error: SelectorSnapshotValidationError };

export function isSelectorSnapshotSid(value: string): boolean {
  return SELECTOR_SNAPSHOT_SID_PATTERN.test(value);
}

export function isSelectorSnapshotStructurallySafe(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    return value.every((item) => isSelectorSnapshotStructurallySafe(item, depth + 1));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return false;
    }
    if (!isSelectorSnapshotStructurallySafe((value as Record<string, unknown>)[key], depth + 1)) {
      return false;
    }
  }
  return true;
}

export function stripDebugFromSelectorSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const { debug: _debug, ...snapshot } = value;
  return snapshot;
}

export function validateSelectorSnapshotInput(value: unknown): SelectorSnapshotInputValidationResult {
  if (!isSelectorSnapshotStructurallySafe(value)) {
    return { ok: false, error: "unsafe" };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "shape" };
  }
  const candidate = isRecord(value.input) ? value.input : value;
  const parsed = SelectorInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: "shape" };
  }
  return { ok: true, input: normalizeSelectorInput(candidate as unknown as SelectorInput) };
}

export function validateSelectorSnapshot(value: unknown): SelectorSnapshotValidationResult {
  if (!isSelectorSnapshotStructurallySafe(value)) {
    return { ok: false, error: "unsafe" };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "shape" };
  }
  const snapshot = stripDebugFromSelectorSnapshot(value);
  if (!isSelectorOutputShape(snapshot)) {
    return { ok: false, error: "shape" };
  }
  const normalized = normalizeSelectorSnapshot(snapshot);
  return normalized
    ? { ok: true, snapshot: normalized }
    : { ok: false, error: "shape" };
}

function attachVerifiedSnapshotBinding(
  snapshot: SelectorOutput,
  canonicalSources?: SelectorCanonicalSourceEvidence[],
): SelectorOutput {
  return {
    ...snapshot,
    provenance: "pharos-verified",
    snapshotSchemaVersion: 3,
    verification: {
      kind: SELECTOR_SNAPSHOT_VERIFICATION_KIND,
      datasetHash: snapshot.datasetHash,
      engineVersion: snapshot.engineVersion,
      ...(canonicalSources === undefined ? {} : { canonicalSources }),
    },
  };
}

export function createVerifiedSelectorSnapshot(
  output: SelectorOutput,
  canonicalSources?: SelectorCanonicalSourceEvidence[],
): SelectorOutput {
  const validation = validateSelectorSnapshot(output);
  if (!validation.ok) {
    throw new Error("Server-recomputed selector output failed snapshot validation");
  }
  const evidence = canonicalSources === undefined ? undefined : normalizeSelectorCanonicalSources(canonicalSources);
  if (evidence === null) throw new Error("Server-fetched selector source evidence failed snapshot validation");
  return attachVerifiedSnapshotBinding(validation.snapshot, evidence);
}

export function validateVerifiedSelectorSnapshot(value: unknown): SelectorSnapshotValidationResult {
  if (!isSelectorSnapshotStructurallySafe(value) || !isRecord(value) || "debug" in value) {
    return { ok: false, error: "unsafe" };
  }
  if (!isSelectorOutputShape(value) || !isRecord(value.verification)) {
    return { ok: false, error: "shape" };
  }
  if (
    value.provenance !== "pharos-verified"
    || value.snapshotSchemaVersion !== 3
    || value.verification.kind !== SELECTOR_SNAPSHOT_VERIFICATION_KIND
    || value.verification.datasetHash !== value.datasetHash
    || value.verification.engineVersion !== value.engineVersion
  ) {
    return { ok: false, error: "shape" };
  }

  const normalized = normalizeSelectorSnapshot(value);
  if (!normalized) return { ok: false, error: "shape" };
  const evidence = value.verification.canonicalSources === undefined
    ? undefined
    : normalizeSelectorCanonicalSources(value.verification.canonicalSources);
  if (evidence === null) return { ok: false, error: "shape" };
  const verified = attachVerifiedSnapshotBinding(normalized, evidence);
  return canonicalizeForSid(value) === canonicalizeForSid(verified)
    ? { ok: true, snapshot: verified }
    : { ok: false, error: "shape" };
}

/**
 * Validates a snapshot returned by the trusted Pages Function boundary.
 * Verified-looking payloads must satisfy the exact verified contract; they
 * are never silently downgraded to the legacy client-unverified projection.
 */
export function validateSelectorSnapshotResponse(value: unknown): SelectorSnapshotValidationResult {
  if (
    isRecord(value)
    && (
      value.provenance === "pharos-verified"
      || value.snapshotSchemaVersion === 3
      || value.verification !== undefined
    )
  ) {
    return validateVerifiedSelectorSnapshot(value);
  }
  return validateSelectorSnapshot(value);
}

export function computeSelectorSnapshotSid(snapshot: unknown): string {
  return sha256Hex(canonicalizeForSid(snapshot)).slice(0, 32);
}

function isSelectorOutputShape(value: unknown): value is SelectorOutput {
  // Never feed a schema-stripped/defaulted clone into semantic normalization:
  // historical unknown fields and verified canonical equality have their own
  // projection rules, independent of structural admission.
  return OutputShapeSchema.safeParse(value).success;
}
