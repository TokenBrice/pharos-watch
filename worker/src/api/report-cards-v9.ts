import { jsonResponse } from "../lib/api-response";
import { safetyScoreSnapshotHeaders, withSafetyScoreRepresentationEtag as withRepresentationEtag } from "../lib/safety-score-v9/http-response";
import { loadV9PublicMaterializedResponse, V9PublicMaterializationUnavailableError } from "../lib/report-cards-v9-materialization";
import { projectV9WireBody, readV9WireOptions } from "./report-cards-v9-freshness";

/** Every invocation admits live accepted identity/health; only immutable bytes are reused. */
export const handleReportCardsV9 = async (db: D1Database, url?: URL): Promise<Response> => {
  try {
    const snapshot = await loadV9PublicMaterializedResponse(db);
    const options = readV9WireOptions(url);
    return withRepresentationEtag(new Response(projectV9WireBody(snapshot.body, options),
      { headers: safetyScoreSnapshotHeaders(snapshot, snapshot.representationIdentity.generationId) }),
      ["report-cards-v9", ...(options.operands ? ["operands"] : []), ...(options.reserveAdmission ? ["reserve-admission"] : []),
        snapshot.representationIdentity, snapshot.publicationHealth]);
  } catch (error) {
    const reason = error instanceof V9PublicMaterializationUnavailableError
      ? error.reason : "v9-public-materialization-read-failed";
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Canonical V9 representation is unavailable", reason },
      { status: 503, noStore: true },
    );
  }
};
