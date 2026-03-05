import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import {
  withErrorHandler,
  addFreshnessHeaders,
  isValidStablecoinId,
  errorResponse,
  parseIntParam,
  jsonResponse,
  getLatestSuccessfulCronTimestamp,
  buildMethodologyEnvelope,
  fetchPaginatedEvents,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
  toDepegDewsMethodologyVersionLabel,
} from "@shared/lib/depeg-dews-version";

export const handleDepegEvents = withErrorHandler("depeg-events", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const limit = parseIntParam(params.get("limit"), 100, 1, 1000);
  const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const stablecoin = params.get("stablecoin");
  const active = params.get("active");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    if (!isValidStablecoinId(stablecoin)) {
      return errorResponse(400, "Invalid stablecoin ID");
    }
    conditions.push("stablecoin_id = ?");
    filterBindings.push(stablecoin);
  }
  if (active === "true") {
    conditions.push("ended_at IS NULL");
  }

  const { events, total } = await fetchPaginatedEvents<DepegRow, ReturnType<typeof rowToDepegEvent>>(db, {
    tableName: "depeg_events",
    orderBy: "started_at DESC",
    conditions,
    filterBindings,
    limit,
    offset,
    mapRow: rowToDepegEvent,
  });

  const latestEventTs = events.length > 0 ? events[0].startedAt : Math.floor(Date.now() / 1000);
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-stablecoins", latestEventTs);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(latestEventTs);

  return jsonResponse({ events, total, methodology: buildMethodologyEnvelope({
    version: methodologyVersion,
    versionLabel: toDepegDewsMethodologyVersionLabel(methodologyVersion),
    currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
    currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
    asOf: latestEventTs,
  }) }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, freshnessTs, 900));
});
