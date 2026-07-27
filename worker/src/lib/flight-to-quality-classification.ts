import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import {
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
} from "@shared/types/report-cards-v9";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";

const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

const SAFE_GRADES = new Set(["A+", "A", "A-", "B+", "B", "B-"]);
const RISKY_GRADES = new Set(["D", "F"]);

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
  return (
    left.model === "v9" &&
    right.model === "v9" &&
    left.policyId === right.policyId &&
    left.policyDigest === right.policyDigest
  );
}

/** Builds FTQ cohorts from the canonical current V9 publication. */
export function buildFlightToQualityClassificationFromV9Snapshot(
  snapshot: ReportCardsV9CurrentResponse,
  options: { expectedIdentity?: SafetyScorePublicationIdentity | null },
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
  const identity = SafetyScorePublicationIdentitySchema.parse(
    source.safetyScoreIdentity,
  );
  const expectedIdentity = options.expectedIdentity ?? identity;
  if (!identitiesMatch(identity, expectedIdentity)) {
    return { kind: "unavailable", reason: "identity-mismatch" };
  }

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
