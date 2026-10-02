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
  const grades = SafetyGradesResponseSchema.shape.grades.safeParse(
    snapshot.cards.map(({ id, score, grade }) => ({ id, score, grade })),
  );
  const identity = SafetyScorePublicationIdentitySchema.safeParse(snapshot.safetyScoreIdentity);
  const health = V9PublicationHealthSchema.safeParse(snapshot.publicationHealth);
  if (!grades.success || !identity.success || !health.success
    || grades.data.length !== snapshot.completeness.expectedCount
    || new Set(grades.data.map(card => card.id)).size !== grades.data.length) {
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
  for (const card of grades.data) {
    if (!TRACKED_IDS.has(card.id)) continue;
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
