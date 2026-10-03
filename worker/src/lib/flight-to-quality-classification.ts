import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import { SafetyGradesResponseSchema, V9PublicationHealthSchema } from "@shared/types/report-cards-v9";
import type { SafetyScoreGradeSnapshot } from "./safety-score-index";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { isSafetyScoreV9SnapshotFresh } from "./safety-score-v9/consumer-freshness";
import { RISKY_GRADES, SAFE_GRADES } from "@shared/lib/safety-grade-buckets";

const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

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
        | "lifecycle-not-approved"
        | "publication-held"
        | "source-stale"
        | "source-contract-invalid";
    };


/** Builds FTQ cohorts from the canonical current V9 publication. */
export function buildFlightToQualityClassificationFromV9Snapshot(
  snapshot: SafetyScoreGradeSnapshot,
): FlightToQualityClassificationResult {
  if (snapshot.lifecycle !== "active") {
    return { kind: "unavailable", reason: "lifecycle-not-approved" };
  }
  const grades = SafetyGradesResponseSchema.safeParse({
    schemaVersion: 1,
    model: "v9",
    asOfSec: snapshot.asOfSec,
    updatedAt: snapshot.updatedAt,
    publicationStatus: snapshot.publicationHealth.status,
    methodologyVersion: snapshot.methodology.version,
    grades: snapshot.cards.map(({ id, score, grade, ratingStatus, partialEvidence }) => ({
      id, score, grade, ratingStatus,
      partialEvidence: partialEvidence === null ? null : {
        reasonCode: partialEvidence.reasonCode,
        excludedPillars: partialEvidence.excludedPillars,
        causes: partialEvidence.causes,
      },
    })),
  });
  const identity = SafetyScorePublicationIdentitySchema.safeParse(snapshot.safetyScoreIdentity);
  const health = V9PublicationHealthSchema.safeParse(snapshot.publicationHealth);
  if (!grades.success || !identity.success || !health.success
    || grades.data.grades.length !== snapshot.completeness.expectedCount
    || new Set(grades.data.grades.map(card => card.id)).size !== grades.data.grades.length) {
    return { kind: "unavailable", reason: "source-contract-invalid" };
  }
  const source = snapshot;
  if (source.publicationHealth.status === "held") {
    return { kind: "unavailable", reason: "publication-held" };
  }
  if (!isSafetyScoreV9SnapshotFresh(source)) {
    return { kind: "unavailable", reason: "source-stale" };
  }
  const safetyScoreIdentity = identity.data;

  const safeIds = new Set<string>();
  const riskyIds = new Set<string>();
  for (const card of grades.data.grades) {
    if (!TRACKED_IDS.has(card.id) || card.ratingStatus !== "rated" || card.grade === null) continue;
    if (SAFE_GRADES.has(card.grade)) {
      safeIds.add(card.id);
    } else if (RISKY_GRADES.has(card.grade)) {
      riskyIds.add(card.id);
    }
  }
  return {
    kind: "ok",
    classification: {
      safeIds,
      riskyIds,
      safetyScoreIdentity,
    },
  };
}
