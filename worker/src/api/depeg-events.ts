import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import {
  withErrorHandler,
  resolveOrReject,
  parseIntParam,
  jsonFreshResponse,
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
} from "@shared/lib/depeg-dews-version";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-version";

export const handleDepegEvents = withErrorHandler("depeg-events", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const limit = parseIntParam(params.get("limit"), 100, 1, 1000, "limit");
  if (limit instanceof Response) {
    return limit;
  }
  const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  if (offset instanceof Response) {
    return offset;
  }
  const stablecoin = params.get("stablecoin");
  const active = params.get("active");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    const resolved = resolveOrReject(stablecoin);
    if (resolved instanceof Response) {
      return resolved;
    }
    conditions.push("stablecoin_id = ?");
    filterBindings.push(resolved.canonicalId);
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

  return jsonFreshResponse({
    events,
    total,
    methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: toMethodologyVersionLabel(methodologyVersion),
      currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
      currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      asOf: latestEventTs,
    }),
  }, {
    cacheControl: CACHE_PROFILES.realtime,
    updatedAt: freshnessTs,
    maxAgeSec: 900,
  });
});
