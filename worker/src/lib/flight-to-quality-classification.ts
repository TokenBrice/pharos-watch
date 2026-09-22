import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import {
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
} from "@shared/types/report-cards-v9";
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
  snapshot: ReportCardsV9CurrentResponse,
): FlightToQualityClassificationResult {
  if (snapshot.lifecycle !== "active") {
    return { kind: "unavailable", reason: "lifecycle-not-approved" };
  }
  const parsed = ReportCardsV9CurrentResponseSchema.safeParse(snapshot);
  if (!parsed.success) return { kind: "unavailable", reason: "source-contract-invalid" };
  const source = parsed.data;
  if (source.publicationHealth.status === "held") {
    return { kind: "unavailable", reason: "publication-held" };
  }
  if (!isSafetyScoreV9SnapshotFresh(source)) {
    return { kind: "unavailable", reason: "source-stale" };
  }
  const identity = SafetyScorePublicationIdentitySchema.parse(
    source.safetyScoreIdentity,
  );

  const safeIds = new Set<string>();
  const riskyIds = new Set<string>();
  for (const card of source.cards) {
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
      safetyScoreIdentity: identity,
    },
  };
}
