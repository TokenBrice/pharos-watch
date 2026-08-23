import type { D1Database } from "@cloudflare/workers-types";
import {
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  type ApiRequestRouteMetric,
  type BufferedAttributionEntry,
  createBufferedAttributionRecorder,
} from "@shared/lib/request-attribution";
import type {
  SiteDataRequestDeliveryPath,
  SiteDataRequestUpstreamLane,
} from "@shared/types";

export { isRequestSourceAttributionDisabled } from "@shared/lib/request-attribution";

const REQUEST_ATTRIBUTION_RETENTION_SEC = REQUEST_ATTRIBUTION_RETENTION_DAYS * 24 * 60 * 60;
const REQUEST_ATTRIBUTION_FLUSH_DELAY_MS = 10;
const REQUEST_ATTRIBUTION_BATCH_SIZE = 50;

interface BufferedSiteDataRequestAttribution extends BufferedAttributionEntry {
  deliveryPath: SiteDataRequestDeliveryPath;
  upstreamLane: SiteDataRequestUpstreamLane;
}

const siteDataRequestRecorder = createBufferedAttributionRecorder<BufferedSiteDataRequestAttribution, D1Database>({
  batchSize: REQUEST_ATTRIBUTION_BATCH_SIZE,
  flushDelayMs: REQUEST_ATTRIBUTION_FLUSH_DELAY_MS,
  pruneIntervalSec: REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  retentionSec: REQUEST_ATTRIBUTION_RETENTION_SEC,
  insertSql: `INSERT INTO site_data_request_stats (
           bucket_start,
           route_key,
           route_path,
           delivery_path,
           upstream_lane,
           request_count
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket_start, route_key, delivery_path, upstream_lane)
         DO UPDATE SET
           request_count = request_count + excluded.request_count,
           route_path = excluded.route_path`,
  pruneSql: ["DELETE FROM site_data_request_stats WHERE bucket_start < ?"],
  logLabel: "site-data",
  buildKey: (entry) => `${entry.bucketStart}\t${entry.route.routeKey}\t${entry.deliveryPath}\t${entry.upstreamLane}`,
  bindInsertParams: (entry) => [
    entry.bucketStart,
    entry.route.routeKey,
    entry.route.routePath,
    entry.deliveryPath,
    entry.upstreamLane,
    entry.requestCount,
  ],
  mergeBuffered: (existing, incoming) => {
    existing.requestCount += incoming.requestCount;
    existing.route = incoming.route;
  },
});

export function resetSiteDataRequestAttributionStateForTests(): void {
  siteDataRequestRecorder.reset();
}

export async function recordSiteDataRequest(
  db: D1Database,
  route: ApiRequestRouteMetric,
  deliveryPath: SiteDataRequestDeliveryPath,
  upstreamLane: SiteDataRequestUpstreamLane,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  await siteDataRequestRecorder.record(
    db,
    {
      bucketStart,
      route,
      deliveryPath,
      upstreamLane,
      requestCount: 1,
    },
    nowSec,
  );
}
