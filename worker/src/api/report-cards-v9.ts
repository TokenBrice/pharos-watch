import { jsonResponse, safetyScoreSnapshotHeaders, withRepresentationEtag } from "../lib/api-response";
import { loadV9PublicMaterializedResponse, V9PublicMaterializationUnavailableError } from "../lib/report-cards-v9-materialization";

/** Every invocation admits live accepted identity/health; only immutable bytes are reused. */
export const handleReportCardsV9 = async (db: D1Database): Promise<Response> => {
  try {
    const snapshot = await loadV9PublicMaterializedResponse(db);
    return withRepresentationEtag(new Response(snapshot.body, { headers: safetyScoreSnapshotHeaders(snapshot) }),
      ["report-cards-v9", snapshot.representationIdentity, snapshot.publicationHealth]);
  } catch (error) {
    const reason = error instanceof V9PublicMaterializationUnavailableError
      ? error.reason : "v9-public-materialization-read-failed";
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Canonical V9 representation is unavailable", reason },
      { status: 503, noStore: true },
    );
  }
};
