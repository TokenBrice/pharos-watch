import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { loadPublishedReportCardsV9Snapshot } from "./report-cards-v9-cache";

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
