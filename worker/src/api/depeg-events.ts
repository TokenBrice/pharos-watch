import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import {
  withErrorHandler,
  resolveOrReject,
  buildMethodologyEnvelope,
  buildPaginatedEventResponse,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
} from "@shared/lib/depeg-dews-version";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-version";

export const handleDepegEvents = withErrorHandler(
  "depeg-events",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
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

    return buildPaginatedEventResponse<DepegRow, ReturnType<typeof rowToDepegEvent>>(db, {
      tableName: "depeg_events",
      orderBy: "started_at DESC, id DESC",
      conditions,
      filterBindings,
      mapRow: rowToDepegEvent,
      searchParams: params,
      pagination: { defaultLimit: 100, minLimit: 1, maxLimit: 1000, maxOffset: 50_000 },
      cursor: {
        columns: [
          { column: "started_at", type: "number", direction: "DESC", getValue: (row) => row.started_at },
          { column: "id", type: "number", direction: "DESC", getValue: (row) => row.id },
        ],
      },
      freshness: {
        producerJob: "sync-stablecoins",
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegEvents,
        fallbackTimestamp: (events) => (events.length > 0 ? events[0].startedAt : Math.floor(Date.now() / 1000)),
      },
      cacheControl: CACHE_PROFILES.realtime,
      buildExtraBody: (_events, _total, latestEventTs) => {
        const methodologyVersion = getDepegDewsMethodologyVersionAt(latestEventTs);
        return {
          methodology: buildMethodologyEnvelope({
            version: methodologyVersion,
            versionLabel: toMethodologyVersionLabel(methodologyVersion),
            currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
            currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
            changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
            asOf: latestEventTs,
          }),
        };
      },
    });
  },
);
