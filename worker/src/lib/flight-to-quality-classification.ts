import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import type { ReportCardCachePayload } from "./report-card-cache";
import {
  ReportCardsV9TransitionResponseSchema,
  type ReportCardsV9TransitionResponse,
} from "@shared/types/report-cards-v9";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { isCurrentSafetyScoreV8Identity } from "./safety-score-current-identity";

const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

const SAFE_GRADES = new Set(["A+", "A", "A-", "B+", "B", "B-"]);
const RISKY_GRADES = new Set(["D", "F"]);

export interface FlightToQualityClassificationInput {
  scores: Record<string, { score: number; grade: string }>;
  safetyScoreIdentity?: unknown;
  /** Callers must establish source-specific publication completeness first. */
  identityComplete: boolean;
  /** A cached decision is valid only for this exact active identity. */
  expectedIdentity?: SafetyScorePublicationIdentity | null;
}

export interface FlightToQualityClassification {
  safeIds: Set<string>;
  riskyIds: Set<string>;
  safetyScoreIdentity: SafetyScorePublicationIdentity;
}

export type FlightToQualityClassificationResult =
  | { kind: "ok"; classification: FlightToQualityClassification }
  | {
      kind: "unavailable";
      reason:
        | "identity-missing"
        | "identity-incomplete"
        | "identity-invalid"
        | "identity-not-current"
        | "identity-mismatch"
        | "lifecycle-not-approved"
        | "publication-held"
        | "source-contract-invalid";
    };

function identitiesMatch(left: SafetyScorePublicationIdentity, right: SafetyScorePublicationIdentity): boolean {
  if (
    left.model !== right.model ||
    left.schemaVersion !== right.schemaVersion ||
    left.methodologyVersion !== right.methodologyVersion ||
    left.evaluationBuildDigest !== right.evaluationBuildDigest ||
    left.baseInputGenerationId !== right.baseInputGenerationId ||
    left.publicationGenerationId !== right.publicationGenerationId
  ) {
    return false;
  }
  if (left.model === "v8") return right.model === "v8";
  return right.model === "v9" && left.policyId === right.policyId && left.policyDigest === right.policyDigest;
}

export function buildFlightToQualityClassification(
  payload: FlightToQualityClassificationInput,
): FlightToQualityClassificationResult {
  if (!payload.identityComplete) return { kind: "unavailable", reason: "identity-incomplete" };
  if (!payload.safetyScoreIdentity) return { kind: "unavailable", reason: "identity-missing" };
  const parsedIdentity = SafetyScorePublicationIdentitySchema.safeParse(payload.safetyScoreIdentity);
  if (!parsedIdentity.success) return { kind: "unavailable", reason: "identity-invalid" };
  const identity = parsedIdentity.data;
  if (identity.model === "v8" && !isCurrentSafetyScoreV8Identity(identity)) {
    return { kind: "unavailable", reason: "identity-not-current" };
  }
  if (payload.expectedIdentity && !identitiesMatch(identity, payload.expectedIdentity)) {
    return { kind: "unavailable", reason: "identity-mismatch" };
  }

  const safeIds = new Set<string>();
  const riskyIds = new Set<string>();

  for (const [id, entry] of Object.entries(payload.scores)) {
    if (!TRACKED_IDS.has(id)) continue;
    if (SAFE_GRADES.has(entry.grade)) {
      safeIds.add(id);
      continue;
    }
    if (RISKY_GRADES.has(entry.grade)) {
      riskyIds.add(id);
    }
  }

  return { kind: "ok", classification: { safeIds, riskyIds, safetyScoreIdentity: identity } };
}

/** Current V8 compact-cache call sites establish this before classification. */
export function buildFlightToQualityClassificationFromV8Cache(
  payload: ReportCardCachePayload,
): FlightToQualityClassificationResult {
  return buildFlightToQualityClassification({ ...payload, identityComplete: true });
}

/**
 * Explicit model-aware V9 adapter. Shadow callers must opt in deliberately;
 * an active V9 publication is accepted directly.
 */
export function buildFlightToQualityClassificationFromV9Snapshot(
  snapshot: ReportCardsV9TransitionResponse,
  options: { allowShadowLifecycle: boolean; expectedIdentity?: SafetyScorePublicationIdentity | null },
): FlightToQualityClassificationResult {
  if (
    snapshot.lifecycle !== "active" &&
    (snapshot.lifecycle !== "shadow" || !options.allowShadowLifecycle)
  ) {
    return { kind: "unavailable", reason: "lifecycle-not-approved" };
  }
  const parsed = ReportCardsV9TransitionResponseSchema.safeParse(snapshot);
  if (!parsed.success) return { kind: "unavailable", reason: "source-contract-invalid" };
  const source = parsed.data;
  if (source.publicationHealth.status === "held") {
    return { kind: "unavailable", reason: "publication-held" };
  }
  return buildFlightToQualityClassification({
    scores: Object.fromEntries(source.cards.map((card) => [card.id, { score: card.score ?? 0, grade: card.grade }])),
    safetyScoreIdentity: source.safetyScoreIdentity,
    identityComplete: true,
    expectedIdentity: options.expectedIdentity ?? source.safetyScoreIdentity,
  });
}
