import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { loadPublishedReportCardsV9Snapshot } from "./report-cards-v9-cache";

export type ActiveSafetyScoreSource =
  | {
      kind: "v9";
      expectedModel: "v9";
      snapshot: ReportCardsV9CurrentResponse;
    }
  | {
      kind: "error";
      expectedModel: "v9";
      reason: "v9-snapshot-unavailable";
      snapshot: null;
      detail: string;
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
    (snapshot): ActiveSafetyScoreSource => ({
      kind: "v9",
      expectedModel: "v9",
      snapshot,
    }),
    (error): ActiveSafetyScoreSource => ({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail:
        error instanceof Error
          ? error.message
          : "Canonical V9 publication is unavailable",
    }),
  );
}
