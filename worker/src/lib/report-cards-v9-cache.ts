import { toErrorMessage } from "@shared/lib/error-utils";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9-current";
import { loadSafetyScoreV9Publication } from "./safety-score-v9/publication-store";
import { loadSafetyScoreV9PublicationHealth } from "./safety-score-v9/publication-health";
import { projectSafetyScoreV9PublicationToPublicSnapshot } from "./report-cards-v9-projection";
export {
  buildSafetyScoreV9PublicationIdentity,
  projectSafetyScoreV9PublicationToPublicSnapshot,
  projectSafetyScoreV9PublicationForMaterialization,
} from "./report-cards-v9-projection";

export class ReportCardsV9SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsV9SnapshotUnavailableError";
  }
}

export async function loadPublishedReportCardsV9Snapshot(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ReportCardsV9CurrentResponse> {
  let publication;
  let publicationHealth;
  try {
    [publication, publicationHealth] = await Promise.all([
      loadSafetyScoreV9Publication(db, signal),
      loadSafetyScoreV9PublicationHealth(db, signal),
    ]);
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 publication is unavailable: ${
        toErrorMessage(error)
      }`,
    );
  }
  if (publication === null) {
    throw new ReportCardsV9SnapshotUnavailableError(
      "Canonical Safety Score V9 publication is unavailable",
    );
  }
  if (publicationHealth === null) {
    throw new ReportCardsV9SnapshotUnavailableError(
      "Safety Score V9 publication health is unavailable",
    );
  }
  try {
    return projectSafetyScoreV9PublicationToPublicSnapshot(
      publication,
      publicationHealth,
    );
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 publication is incompatible: ${
        toErrorMessage(error)
      }`,
    );
  }
}
