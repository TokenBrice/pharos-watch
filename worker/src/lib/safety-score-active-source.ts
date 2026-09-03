import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import {
  buildSafetyScoreV9PublicationIdentity,
  loadPublishedReportCardsV9Snapshot,
  resolveSafetyScoreV9EffectivePublicationHealth,
} from "./report-cards-v9-cache";
import {
  loadSafetyScoreV9Publication,
  loadSafetyScoreV9PublicationHealth,
} from "./safety-score-v9/publication-store";

/**
 * The canonical Safety Score source in one union. `v9` is the only usable
 * state; `held` still carries the last verified snapshot (consumers that may
 * surface held ratings read it, consumers bound to live ratings must not), and
 * `error` carries no snapshot at all.
 *
 * "Publication unusable" is defined here once: `kind !== "v9"`.
 */
export type ActiveSafetyScoreSource =
  | {
      kind: "v9";
      snapshot: ReportCardsV9CurrentResponse;
    }
  | {
      kind: "held";
      reason: "v9-publication-held";
      detail: string;
      snapshot: ReportCardsV9CurrentResponse;
    }
  | {
      kind: "error";
      reason: "v9-snapshot-unavailable";
      detail: string;
      snapshot: null;
    };

/**
 * Resolves the canonical Safety Score source. V9 is the only live model;
 * unavailable or incompatible state fails closed and never selects V8.
 */
export async function loadActiveSafetyScoreSource(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ActiveSafetyScoreSource> {
  return loadPublishedReportCardsV9Snapshot(db, signal).then(
    (snapshot): ActiveSafetyScoreSource =>
      snapshot.publicationHealth.status === "held"
        ? {
            kind: "held",
            reason: "v9-publication-held",
            detail:
              "Canonical Safety Score V9 ratings are held at the last verified snapshot",
            snapshot,
          }
        : {
            kind: "v9",
            snapshot,
          },
    (error): ActiveSafetyScoreSource => ({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail:
        error instanceof Error
          ? error.message
          : "Canonical V9 publication is unavailable",
      snapshot: null,
    }),
  );
}

/**
 * Identity-only view of {@link ActiveSafetyScoreSource}. Same three states,
 * decided from the same publication and effective health, without the cards.
 */
export type ActiveSafetyScoreIdentity =
  | {
      kind: "v9";
      safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
    }
  | {
      kind: "held";
      safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
    }
  | {
      kind: "error";
      safetyScoreIdentity: null;
    };

/**
 * Resolves only the canonical publication identity. Callers that just compare
 * identities use this instead of {@link loadActiveSafetyScoreSource} so peak
 * heap never carries a second full report-card set; the state machine is
 * identical, and every unavailable or incompatible publication fails closed to
 * `error` rather than throwing.
 */
export async function loadActiveSafetyScoreIdentity(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ActiveSafetyScoreIdentity> {
  let publication;
  let publicationHealth;
  try {
    [publication, publicationHealth] = await Promise.all([
      loadSafetyScoreV9Publication(db, signal),
      loadSafetyScoreV9PublicationHealth(db, signal),
    ]);
  } catch {
    return { kind: "error", safetyScoreIdentity: null };
  }
  if (publication === null || publicationHealth === null) {
    return { kind: "error", safetyScoreIdentity: null };
  }
  try {
    const safetyScoreIdentity =
      buildSafetyScoreV9PublicationIdentity(publication);
    const effectiveHealth = resolveSafetyScoreV9EffectivePublicationHealth(
      publication,
      publicationHealth,
    );
    return effectiveHealth.status === "held"
      ? { kind: "held", safetyScoreIdentity }
      : { kind: "v9", safetyScoreIdentity };
  } catch {
    return { kind: "error", safetyScoreIdentity: null };
  }
}
