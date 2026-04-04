import type { D1Database } from "@cloudflare/workers-types";
import {
  REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC,
  REQUEST_ATTRIBUTION_RETENTION_DAYS,
  type ApiRequestRouteMetric,
} from "@shared/lib/request-attribution";
import type {
  SiteDataRequestDeliveryPath,
  SiteDataRequestUpstreamLane,
} from "@shared/types";

const REQUEST_ATTRIBUTION_RETENTION_SEC = REQUEST_ATTRIBUTION_RETENTION_DAYS * 24 * 60 * 60;

let lastSiteDataRequestPruneBucket: number | null = null;
let pendingSiteDataRequestPrune: Promise<void> | null = null;

export function resetSiteDataRequestAttributionStateForTests(): void {
  lastSiteDataRequestPruneBucket = null;
  pendingSiteDataRequestPrune = null;
}

export async function recordSiteDataRequest(
  db: D1Database,
  route: ApiRequestRouteMetric,
  deliveryPath: SiteDataRequestDeliveryPath,
  upstreamLane: SiteDataRequestUpstreamLane,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  await db.prepare(
    `INSERT INTO site_data_request_stats (
       bucket_start,
       route_key,
       route_path,
       delivery_path,
       upstream_lane,
       request_count
     )
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(bucket_start, route_key, delivery_path, upstream_lane)
     DO UPDATE SET
       request_count = request_count + 1,
       route_path = excluded.route_path`,
  )
    .bind(bucketStart, route.routeKey, route.routePath, deliveryPath, upstreamLane)
    .run();

  const pruneBucket = nowSec - (nowSec % REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC);
  if (lastSiteDataRequestPruneBucket !== pruneBucket && !pendingSiteDataRequestPrune) {
    lastSiteDataRequestPruneBucket = pruneBucket;
    const prunePromise = db
      .prepare("DELETE FROM site_data_request_stats WHERE bucket_start < ?")
      .bind(nowSec - REQUEST_ATTRIBUTION_RETENTION_SEC)
      .run()
      .then(() => {})
      .catch((error: unknown) => {
        console.warn("[request-attribution] site-data prune failed:", error);
      })
      .finally(() => {
        if (pendingSiteDataRequestPrune === prunePromise) {
          pendingSiteDataRequestPrune = null;
        }
      });
    pendingSiteDataRequestPrune = prunePromise;
  }

  if (pendingSiteDataRequestPrune) {
    await pendingSiteDataRequestPrune;
  }
}
