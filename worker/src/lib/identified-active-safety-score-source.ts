import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { loadActiveSafetyScoreSource } from "./safety-score-active-source";

export type IdentifiedActiveSafetyScoreSource =
  | {
      kind: "v9";
      expectedModel: "v9";
      identity: SafetyScoreV9PublicationIdentity;
      publishedAtSec: number;
      snapshot: ReportCardsV9CurrentResponse;
    }
  | {
      kind: "error";
      expectedModel: "v9";
      reason: string;
      detail: string;
    };

export async function loadIdentifiedActiveSafetyScoreSource(
  db: D1Database,
  signal?: AbortSignal,
): Promise<IdentifiedActiveSafetyScoreSource> {
  const active = await loadActiveSafetyScoreSource(db, signal);
  if (active.kind === "error") return active;
  if (active.snapshot.publicationHealth.status === "held") {
    return {
      kind: "error",
      expectedModel: "v9",
      reason: "v9-publication-held",
      detail:
        "Canonical Safety Score V9 ratings are held at the last verified snapshot",
    };
  }
  return {
    kind: "v9",
    expectedModel: "v9",
    identity: active.snapshot.safetyScoreIdentity,
    publishedAtSec: active.snapshot.updatedAt,
    snapshot: active.snapshot,
  };
}
