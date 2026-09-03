/**
 * Shared internals of the Safety Score v9 baseline extension builder.
 *
 * The extension builder was one 2,500-line module; the reserve, bridge, and
 * oracle adapters now live in sibling files. This holds what all of them need:
 * the registry-meta projection, the extension-asset aliases, the reviewed-
 * research evidence builder, and the small clock/status helpers. Pure move —
 * every function here is byte-identical to its previous definition in
 * `safety-score-v9-extension.ts`.
 */
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import type { V9PublishedEvidenceAttribution } from "@shared/lib/safety-score-v9/evidence";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import type { MintAuthorityControl, StablecoinLink, StablecoinMeta } from "@shared/types/core";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import type { SafetyScoreV9FactSetExtensionV2 } from "./fact-set";
import { buildSafetyScoreV9ReserveClassifications } from "./extension-reserves";

export type V9ExtensionRegistryMeta = Pick<
  StablecoinMeta,
  | "id"
  | "status"
  | "variantOf"
  | "variantKind"
  | "wrapperOperator"
  | "archetypeOverride"
  | "mechanismArchetype"
  | "implementationLaunchDate"
  | "launchDate"
  | "reserves"
  | "reserveReview"
  | "custodyProfile"
  | "liveReservesConfig"
  | "proofOfReserves"
  | "genius"
  | "dependencies"
  | "dependencyReview"
  | "mintAuthority"
  | "oracleRisk"
  | "bridgeRouteRisk"
  | "blacklistabilityReview"
  | "contracts"
> &
  Partial<Pick<StablecoinMeta, "flags">>;
export type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
export type ResearchEvidence = ExtensionAsset["researchEvidence"][number];
export type ComponentEvidence = ExtensionAsset["componentEvidence"][number];
export type ControlOverlay = NonNullable<
  Extract<NonNullable<ExtensionAsset["controlReview"]>, { state: "partially-reviewed-controls" }>
>["controls"][number];
export type ReserveClassification = ReturnType<typeof buildSafetyScoreV9ReserveClassifications>[number];

export function authorityModelForType(
  authorityType: MintAuthorityControl["authorityType"],
): NonNullable<ControlOverlay["authority"]>["model"] {
  if (authorityType === "safe" || authorityType === "multisig") return "multisig";
  if (authorityType === "eoa") return "eoa";
  if (authorityType === "dao-governor") return "governance";
  if (authorityType === "issuer-backend" || authorityType === "custodian") return "issuer-backend";
  if (authorityType === "validator-quorum") return "validator-quorum";
  if (authorityType === "contract" || authorityType === "timelock" || authorityType === "bridge") return "contract";
  return authorityType === "none" ? "none" : "unknown";
}

export const DEPLOYMENT_MATERIAL_SHARE_THRESHOLD =
  V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
// RULED D-J (2026-07-19): below this floor the unrecognized-chain-label pool is
// a bounded/diagnostic condition; at or above it the pool stays fail-closed.
export const COMMON_MODE_MATERIAL_SHARE_THRESHOLD = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.commonModeShareThreshold;

export function isoDateStartSec(value: string, clockSec: number, label: string): number {
  const timestampMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestampMs)) throw new Error(`Safety Score v9 ${label} has an invalid review date`);
  const timestampSec = Math.floor(timestampMs / 1_000);
  if (timestampSec > clockSec) throw new Error(`Safety Score v9 ${label} review is later than the scoring clock`);
  return timestampSec;
}

export function confidenceForResearch(
  value: "verified" | "probable" | "manual-review" | "limited" | "unknown" | undefined,
): ResearchEvidence["confidence"] {
  return value ?? "manual-review";
}

export class ReviewEvidenceBuilder {
  readonly evidence = new Map<string, ResearchEvidence>();
  readonly bindings = new Map<string, Set<string>>();

  constructor(
    private readonly assetId: string,
    private readonly clockSec: number,
  ) {}

  add(args: {
    componentKeys: readonly string[];
    sourceId: string;
    reviewedAt: string;
    observedAt?: string;
    publishedAt?: string;
    publishedBy?: V9PublishedEvidenceAttribution;
    confidence?: ResearchEvidence["confidence"];
    sources?: readonly StablecoinLink[];
    payload: unknown;
    maxAgeSec?: number | null;
  }): string[] {
    isoDateStartSec(args.reviewedAt, this.clockSec, `${this.assetId}:${args.sourceId}:reviewed`);
    const observedAtSec = isoDateStartSec(
      args.observedAt ?? args.reviewedAt,
      this.clockSec,
      `${this.assetId}:${args.sourceId}:observed`,
    );
    const publishedAtSec = args.publishedAt
      ? isoDateStartSec(args.publishedAt, this.clockSec, `${this.assetId}:${args.sourceId}:published`)
      : null;
    const sources = args.sources?.length
      ? [...args.sources].sort(
          (left, right) => compareText(left.url, right.url) || compareText(left.label, right.label),
        )
      : [null];
    const evidenceKeys = sources.map((source, index) => {
      const contentSha256 = domainDigest("safety-score-v9.reviewed-metadata-evidence.v2", {
        assetId: this.assetId,
        sourceId: args.sourceId,
        reviewedAt: args.reviewedAt,
        observedAt: args.observedAt ?? args.reviewedAt,
        publishedAt: args.publishedAt ?? null,
        publishedBy: args.publishedBy ?? "unknown",
        confidence: args.confidence ?? "manual-review",
        source,
        payload: args.payload,
      });
      const evidenceKey = `${args.sourceId}:${index}:${contentSha256.slice(0, 16)}`;
      this.evidence.set(evidenceKey, {
        evidenceKey,
        sourceId: args.sourceId,
        observedAtSec,
        publishedAtSec,
        ...(args.publishedBy === undefined ? {} : { publishedBy: args.publishedBy }),
        url: source?.url ?? null,
        contentSha256,
        confidence: args.confidence ?? "manual-review",
        maxAgeSec: args.maxAgeSec ?? null,
      });
      return evidenceKey;
    });
    for (const componentKey of args.componentKeys) {
      const binding = this.bindings.get(componentKey) ?? new Set<string>();
      for (const evidenceKey of evidenceKeys) binding.add(evidenceKey);
      this.bindings.set(componentKey, binding);
    }
    return evidenceKeys;
  }

  finish(): { researchEvidence: ResearchEvidence[]; componentEvidence: ComponentEvidence[] } {
    return {
      researchEvidence: [...this.evidence.values()].sort((left, right) =>
        compareText(left.evidenceKey, right.evidenceKey),
      ),
      componentEvidence: [...this.bindings.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([componentKey, evidenceKeys]) => ({
          componentKey,
          evidenceKeys: [...evidenceKeys].sort(compareText),
        })),
    };
  }
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
  const reviewedAtSec = isoDateStartSec(reviewedAt, clockSec, "research review");
  return clockSec - reviewedAtSec <= V9_REVIEW_EVIDENCE_MAX_AGE_SEC ? "current" : "stale";
}
