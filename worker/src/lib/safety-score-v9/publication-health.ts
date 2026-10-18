import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { V9PublicationHealthSchema, type V9PublicationHealth } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { getCache } from "../db-cache";
import { parseJson } from "../json-parse";
import { SafetyScoreV9SchemaCutoverPendingError } from "./publication-codec";

/** Shared cache identities and health admission without publication materialization. */
export const SAFETY_SCORE_V9_CACHE_KEYS = {
  publication: "report-cards:v9",
  scoreIndex: "report-cards:v9:score-index",
  acceptedBaseline: "report-cards:v9:accepted-baseline:v1",
  lenderCollateral: "report-cards:v9:lender-collateral:v1",
  publicationHealth: "report-cards:v9:publication-health",
  publicationAttempt: "report-cards:v9:last-attempt",
  failedPublicationAttempt: "report-cards:v9:last-failed-attempt",
} as const;

export async function loadSafetyScoreV9PublicationHealth(
  db: D1Database,
  signal?: AbortSignal,
): Promise<V9PublicationHealth | null> {
  const row = await getCache(db, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth, signal);
  if (!row) return null;
  return parseSafetyScoreV9PublicationHealthCache(row);
}

/** Strict health decoding kept separate from I/O for provenance-aware readers. */
export function parseSafetyScoreV9PublicationHealthCache(
  row: { value: string; updatedAt: number },
): V9PublicationHealth {
  const parsed = parseJson(row.value);
  if (!parsed.ok) throw new Error(`Malformed Safety Score v9 publication health JSON: ${parsed.message}`);
  if (parsed.value !== null && typeof parsed.value === "object" &&
      "schemaVersion" in parsed.value && parsed.value.schemaVersion === 1) {
    throw new SafetyScoreV9SchemaCutoverPendingError("health", row.updatedAt);
  }
  const health = V9PublicationHealthSchema.parse(parsed.value);
  if (stableJsonStringifyV1(health) !== row.value) {
    throw new Error("Safety Score v9 publication health JSON is not canonical");
  }
  if (row.updatedAt !== health.attemptedAtSec) {
    throw new Error(
      "Safety Score v9 publication health cache timestamp mismatch",
    );
  }
  return health;
}

/** Mismatched health holds the accepted generation instead of endorsing it. */
export function resolveSafetyScoreV9EffectivePublicationHealth(
  publication: Pick<SafetyScoreV9CurrentResponse, "publicationGenerationId" | "publishedAtSec">,
  publicationHealth: V9PublicationHealth,
): V9PublicationHealth {
  const healthMatchesPublication =
    publicationHealth.acceptedPublicationGenerationId ===
      publication.publicationGenerationId &&
    publicationHealth.acceptedAtSec === publication.publishedAtSec;
  return healthMatchesPublication
    ? publicationHealth
    : {
        ...publicationHealth,
        status: "held" as const,
        acceptedPublicationGenerationId: publication.publicationGenerationId,
        acceptedAtSec: publication.publishedAtSec,
        attemptedAtSec: Math.max(
          publicationHealth.attemptedAtSec,
          publication.publishedAtSec,
        ),
        heldSinceSec: publicationHealth.status === "held" &&
          publicationHealth.heldSinceSec !== null
          ? Math.max(
              publicationHealth.heldSinceSec,
              publication.publishedAtSec,
            )
          : Math.max(
              publicationHealth.attemptedAtSec,
              publication.publishedAtSec,
            ),
        reasons: [{
          code: "assessment-failed" as const,
          detail: "Publication health did not match the stored snapshot; serving the last-known-good snapshot as held.",
        }],
      };
}
