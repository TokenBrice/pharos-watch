import { jsonResponse } from "../lib/api-response";
import { safetyScoreSnapshotHeaders, withSafetyScoreRepresentationEtag as withRepresentationEtag } from "../lib/safety-score-v9/http-response";
import { readCoinProjectionId } from "../lib/api-coin-projection";
import { loadV9PublicMaterializedResponse, V9PublicMaterializationUnavailableError } from "../lib/report-cards-v9-materialization";
import { projectV9WireBody, readV9WireOptions } from "./report-cards-v9-freshness";

async function respond(db: D1Database, representationKey: string, url?: URL): Promise<Response> {
  try {
    const snapshot = await loadV9PublicMaterializedResponse(db, representationKey);
    const options = readV9WireOptions(url);
    const body = representationKey === "table" ? snapshot.body : projectV9WireBody(snapshot.body, options);
    return withRepresentationEtag(new Response(body, { headers: safetyScoreSnapshotHeaders(snapshot, snapshot.representationIdentity.generationId) }), {
      representationKey, ...(options.operands ? { freshness: "operands" } : {}),
      ...(options.reserveAdmission ? { reserveAdmission: "diagnostics" } : {}),
      ...snapshot.representationIdentity, publicationHealth: snapshot.publicationHealth,
    });
  } catch (error) {
    return jsonResponse({ error: "Canonical V9 projection is unavailable",
      reason: error instanceof V9PublicMaterializationUnavailableError ? error.reason : "v9-site-materialization-read-failed" },
    { status: 503, noStore: true });
  }
}
export const handleReportCardsV9Table = (db: D1Database) => respond(db, "table");
export async function handleReportCardsV9Detail(db: D1Database, url: URL): Promise<Response> {
  const id = readCoinProjectionId(url);
  return id instanceof Response ? id : respond(db, `coin:${id}`, url);
}
