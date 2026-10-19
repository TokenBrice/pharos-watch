import type { D1Database } from "@shared/types/cloudflare-runtime";
import {
  REQUEST_ATTRIBUTION_BUCKET_SEC,
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  type ApiRequestRouteMetric,
  type BufferedAttributionEntry,
  createBufferedAttributionRecorder,
  requestAttributionInverseRate,
  selectRequestAttributionSample,
} from "@shared/lib/request-attribution";
import type {
  SiteDataRequestDeliveryPath,
  SiteDataRequestUpstreamLane,
} from "@pharos/contracts/request-source";

export { isRequestSourceAttributionDisabled } from "@shared/lib/request-attribution";

const REQUEST_ATTRIBUTION_RETENTION_SEC = REQUEST_ATTRIBUTION_RETENTION_DAYS * 24 * 60 * 60;
const REQUEST_ATTRIBUTION_FLUSH_DELAY_MS = 10;
const REQUEST_ATTRIBUTION_BATCH_SIZE = 50;

interface BufferedSiteDataRequestAttribution extends BufferedAttributionEntry {
  deliveryPath: SiteDataRequestDeliveryPath;
  upstreamLane: SiteDataRequestUpstreamLane;
  sampleInverseRate: number;
}

const siteDataRequestRecorder = createBufferedAttributionRecorder<BufferedSiteDataRequestAttribution, D1Database>({
  batchSize: REQUEST_ATTRIBUTION_BATCH_SIZE,
  flushDelayMs: REQUEST_ATTRIBUTION_FLUSH_DELAY_MS,
  pruneIntervalSec: REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  retentionSec: REQUEST_ATTRIBUTION_RETENTION_SEC,
  insertSql: `INSERT INTO site_data_request_samples (
           bucket_start,
           route_key,
           route_path,
           delivery_path,
           upstream_lane,
           sample_inverse_rate,
           sample_count
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket_start, route_key, delivery_path, upstream_lane, sample_inverse_rate)
         DO UPDATE SET
           sample_count = sample_count + excluded.sample_count,
           route_path = excluded.route_path`,
  pruneSql: [],
  logLabel: "site-data",
  buildKey: (entry) => `${entry.bucketStart}\t${entry.route.routeKey}\t${entry.deliveryPath}\t${entry.upstreamLane}\t${entry.sampleInverseRate}`,
  bindInsertParams: (entry) => [
    entry.bucketStart,
    entry.route.routeKey,
    entry.route.routePath,
    entry.deliveryPath,
    entry.upstreamLane,
    entry.sampleInverseRate,
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
  const sampleInverseRate = requestAttributionInverseRate(deliveryPath);
  if (sampleInverseRate !== 1 && !selectRequestAttributionSample(sampleInverseRate)) return;
  const bucketStart = nowSec - (nowSec % REQUEST_ATTRIBUTION_BUCKET_SEC);
  await siteDataRequestRecorder.record(
    db,
    {
      bucketStart,
      route,
      deliveryPath,
      upstreamLane,
      sampleInverseRate,
      requestCount: 1,
    },
    nowSec,
  );
}
