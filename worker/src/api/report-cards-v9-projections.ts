import { jsonResponse, safetyScoreSnapshotHeaders, withRepresentationEtag } from "../lib/api-response";
import { readCoinProjectionId } from "../lib/api-coin-projection";
import { loadV9PublicMaterializedResponse, V9PublicMaterializationUnavailableError } from "../lib/report-cards-v9-materialization";
import { legacyV9FreshnessBody } from "./report-cards-v9-freshness";

async function respond(db: D1Database, representationKey: string, operands = false): Promise<Response> {
  try {
    const snapshot = await loadV9PublicMaterializedResponse(db, representationKey);
    const body = representationKey === "table" || operands ? snapshot.body : legacyV9FreshnessBody(snapshot.body);
    return withRepresentationEtag(new Response(body, { headers: safetyScoreSnapshotHeaders(snapshot) }), {
      representationKey, ...(operands ? { freshness: "operands" } : {}), ...snapshot.representationIdentity, publicationHealth: snapshot.publicationHealth,
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
  return id instanceof Response ? id : respond(db, `coin:${id}`, url.searchParams.get("freshness") === "operands");
}
