/**
 * Shared internals of the Safety Score v9 baseline extension builder.
 *
 * The extension builder was one 2,500-line module; the reserve, bridge, and
 * oracle adapters now live in sibling files. This holds their extension-asset
 * aliases and small clock/status helpers; registry metadata is owned by the
 * shared scoring-catalog contract. Runtime-neutral reviewed evidence construction
 * lives in shared/lib; Worker consumers inject native incremental SHA-256.
 */
import { createHash } from "node:crypto";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import type { V9SameChainSystemTransport, V9WeightedQuorum } from "@shared/types/safety-score-v9-control-scope";
import type { MintAuthorityControl } from "@shared/types/core";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import type { SafetyScoreV9FactSetExtensionV2 } from "./fact-set-schema";
import { parseBoundedDateSec } from "@shared/lib/safety-score-v9/review-evidence";
import type { ResearchEvidence } from "@shared/types/safety-score-v9-research-evidence";

export type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
export type ControlOverlay = NonNullable<
  Extract<NonNullable<ExtensionAsset["controlReview"]>, { state: "partially-reviewed-controls" }>
>["controls"][number];
export type ReserveClassification = ExtensionAsset["reserveClassifications"][number];

function authorityModelForType(
  authorityType: MintAuthorityControl["authorityType"],
): NonNullable<ControlOverlay["authority"]>["model"] {
  if (authorityType === "safe" || authorityType === "multisig") return "multisig";
  if (authorityType === "eoa") return "eoa";
  if (authorityType === "dao-governor") return "governance";
  if (authorityType === "issuer-backend" || authorityType === "custodian") return "issuer-backend";
  if (authorityType === "validator-quorum") return "validator-quorum";
  if (authorityType === "chain-consensus") return "chain-consensus";
  if (authorityType === "contract" || authorityType === "timelock" || authorityType === "bridge") return "contract";
  return authorityType === "none" ? "none" : "unknown";
}

export function projectControlAuthority(args: {
  authorityType: MintAuthorityControl["authorityType"];
  chain?: string;
  address?: string;
  fallbackKey: string | null;
  threshold?: number;
  signerCount?: number;
  weightedQuorum?: V9WeightedQuorum;
  executionScope?: MintAuthorityControl["executionScope"];
  sameChainSystemTransport?: V9SameChainSystemTransport;
}): ControlOverlay["authority"] {
  if (args.authorityType === "chain-consensus") {
    return args.sameChainSystemTransport
      ? { authorityKey: "consensus:hyperliquid", model: "chain-consensus", threshold: null, sameChainSystemTransport: args.sameChainSystemTransport }
      : { authorityKey: args.fallbackKey ?? "consensus:unresolved", model: "unknown", threshold: null };
  }
  const authorityKey = args.address
    ? args.executionScope || args.weightedQuorum
      ? normalizeDeploymentId(`${args.chain ?? "chain-unresolved"}:${args.address}`)
      : `${args.chain ?? "chain-unresolved"}:${args.address.toLowerCase()}`
    : args.fallbackKey;
  if (!authorityKey) return null;
  const model = authorityModelForType(args.authorityType);
  return {
    authorityKey, model,
    threshold: !args.weightedQuorum && model === "multisig" && args.threshold != null && args.signerCount != null ? { required: args.threshold, total: args.signerCount } : null,
    ...(args.weightedQuorum ? { weightedQuorum: args.weightedQuorum } : {}),
  };
}

export const DEPLOYMENT_MATERIAL_SHARE_THRESHOLD =
  V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
// RULED D-J (2026-07-19): below this floor the unrecognized-chain-label pool is
// a bounded/diagnostic condition; at or above it the pool stays fail-closed.
export const COMMON_MODE_MATERIAL_SHARE_THRESHOLD = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.commonModeShareThreshold;


export const isoDateStartSec = parseBoundedDateSec;

export function nativeReviewEvidenceDigest(chunks: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

export function confidenceForResearch(
  value: "verified" | "probable" | "manual-review" | "limited" | "unknown" | undefined,
): ResearchEvidence["confidence"] {
  return value ?? "manual-review";
}


export function requiredStatus(
  policyRuleId: string,
  observationState: V9FactStatusV2["observationState"],
  componentKey: string,
  evidenceKeys: readonly string[] = [],
): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId, rationale: null, gapId: null },
    observationState,
    evidenceRefIds:
      observationState === "known" || observationState === "stale" || observationState === "bounded-unknown"
        ? [...evidenceKeys]
        : [],
    gapIds: observationState === "known" ? [] : [`extension-gap:${componentKey}`],
  };
}

export function notApplicableStatus(policyRuleId: string, rationale: string, evidenceKeys: readonly string[]): V9FactStatusV2 {
  // The fact-set compiler rebinds statuses to research-overlay evidence; a
  // sentinel id only satisfies the known-state evidence invariant until then.
  return {
    applicability: { state: "not-applicable", policyRuleId, rationale, gapId: null },
    observationState: "known",
    evidenceRefIds: evidenceKeys.length > 0 ? [...evidenceKeys] : [`extension-evidence:${policyRuleId}`],
    gapIds: [],
  };
}

export function reviewedObservationState(confidence: ResearchEvidence["confidence"]): "known" | "bounded-unknown" | "missing" {
  if (confidence === "verified" || confidence === "probable" || confidence === "manual-review") return "known";
  return confidence === "limited" ? "bounded-unknown" : "missing";
}

export function boundedObservedAt(value: number | null | undefined, clockSec: number): number {
  if (value == null || !Number.isFinite(value)) return clockSec;
  return Math.max(0, Math.min(clockSec, Math.floor(value)));
}

export function maximumObservedAt(values: readonly (number | null | undefined)[], fallback: number, clockSec: number): number {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  return boundedObservedAt(finite.length > 0 ? Math.max(...finite) : fallback, clockSec);
}

export function conservativeDateEndSec(value: string | undefined, clockSec: number): number | null {
  if (!value) return null;
  let timestampMs: number;
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(value);
  if (quarterMatch) {
    const [, year, quarter] = quarterMatch;
    timestampMs = Date.UTC(Number(year), Number(quarter) * 3, 0, 23, 59, 59);
  } else if (/^\d{4}$/.test(value)) {
    timestampMs = Date.UTC(Number(value), 11, 31, 23, 59, 59);
  } else if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    timestampMs = Date.UTC(year!, month!, 0, 23, 59, 59);
  } else {
    timestampMs = Date.parse(value);
  }
  if (!Number.isFinite(timestampMs)) return null;
  const timestampSec = Math.floor(timestampMs / 1_000);
  return timestampSec <= clockSec ? timestampSec : null;
}

/** Hardware storage has its own review clock; it never inherits an older control pin. */
export function reviewedKeyCustody(
  attestation: MintAuthorityControl["keyCustodyAttestation"],
  clockSec: number,
): ControlOverlay["keyCustody"] {
  if (!attestation) return "unknown";
  if (attestation.kind !== "hardware-wallet") return attestation.kind;
  const reviewSec = conservativeDateEndSec(attestation.reviewedAt, clockSec);
  if (reviewSec === null || clockSec - reviewSec > V9_REVIEW_EVIDENCE_MAX_AGE_SEC) return "unknown";
  if (attestation.reviewedAt?.length === 10 && reviewSec + 86_400 > clockSec) return "unknown";
  return "hardware-wallet";
}

export function accessEvidenceObservationState(reviewedAt: string, clockSec: number): "current" | "stale" {
  const reviewedAtSec = Date.parse(`${reviewedAt}T00:00:00.000Z`) / 1_000;
  if (!Number.isFinite(reviewedAtSec)) throw new Error("Safety Score v9 access review has an invalid review date");
  if (reviewedAtSec > clockSec) throw new Error("Safety Score v9 access review is later than the scoring clock");
  return clockSec - reviewedAtSec <= V9_ACCESS_EVIDENCE_MAX_AGE_SEC ? "current" : "stale";
}

/**
 * Reviewed bridge/mint/oracle research shares the D11 review cadence. A review
 * older than the window supports no known claims: the fact degrades to stale
 * with its evidence still attached (mirroring the access-evidence treatment).
 */
export function researchReviewObservationState(reviewedAt: string, clockSec: number): "current" | "stale" {
  const reviewedAtSec = parseBoundedDateSec(reviewedAt, clockSec, "research review");
  return clockSec - reviewedAtSec <= V9_REVIEW_EVIDENCE_MAX_AGE_SEC ? "current" : "stale";
}
