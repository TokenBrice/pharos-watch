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
const REQUEST_ATTRIBUTION_FLUSH_DELAY_MS = 10;
const REQUEST_ATTRIBUTION_BATCH_SIZE = 50;
export const REQUEST_SOURCE_ATTRIBUTION_DISABLED_ENV = "REQUEST_SOURCE_ATTRIBUTION_DISABLED";

interface BufferedSiteDataRequestAttribution {
  bucketStart: number;
  route: ApiRequestRouteMetric;
  deliveryPath: SiteDataRequestDeliveryPath;
  upstreamLane: SiteDataRequestUpstreamLane;
  requestCount: number;
}

let lastSiteDataRequestPruneBucket: number | null = null;
let pendingSiteDataRequestPrune: Promise<void> | null = null;
const bufferedSiteDataRequestAttribution = new Map<string, BufferedSiteDataRequestAttribution>();
let pendingSiteDataRequestAttributionFlush: Promise<void> | null = null;

export function resetSiteDataRequestAttributionStateForTests(): void {
  lastSiteDataRequestPruneBucket = null;
  pendingSiteDataRequestPrune = null;
  bufferedSiteDataRequestAttribution.clear();
  pendingSiteDataRequestAttributionFlush = null;
}

export function isRequestSourceAttributionDisabled(env: unknown): boolean {
  const value = (env as Record<string, unknown> | null | undefined)?.[REQUEST_SOURCE_ATTRIBUTION_DISABLED_ENV];
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export async function recordSiteDataRequest(
  db: D1Database,
  route: ApiRequestRouteMetric,
  deliveryPath: SiteDataRequestDeliveryPath,
  upstreamLane: SiteDataRequestUpstreamLane,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucketStart = nowSec - (nowSec % 60);
  const key = `${bucketStart}\t${route.routeKey}\t${deliveryPath}\t${upstreamLane}`;
  const buffered = bufferedSiteDataRequestAttribution.get(key);
  if (buffered) {
    buffered.requestCount += 1;
    buffered.route = route;
  } else {
    bufferedSiteDataRequestAttribution.set(key, {
      bucketStart,
      route,
      deliveryPath,
      upstreamLane,
      requestCount: 1,
    });
  }

  await scheduleSiteDataRequestAttributionFlush(db, nowSec);
}

async function maybePruneSiteDataRequestStats(db: D1Database, nowSec: number): Promise<void> {
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

async function flushBufferedSiteDataRequestAttribution(db: D1Database, nowSec: number): Promise<void> {
  while (bufferedSiteDataRequestAttribution.size > 0) {
    const entries = Array.from(bufferedSiteDataRequestAttribution.values());
    bufferedSiteDataRequestAttribution.clear();

    for (let index = 0; index < entries.length; index += REQUEST_ATTRIBUTION_BATCH_SIZE) {
      const chunk = entries.slice(index, index + REQUEST_ATTRIBUTION_BATCH_SIZE);
      await db.batch(chunk.map((entry) => db.prepare(
        `INSERT INTO site_data_request_stats (
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
      )
        .bind(
          entry.bucketStart,
          entry.route.routeKey,
          entry.route.routePath,
          entry.deliveryPath,
          entry.upstreamLane,
          entry.requestCount,
        )));
    }
  }

  await maybePruneSiteDataRequestStats(db, nowSec);
}

function scheduleSiteDataRequestAttributionFlush(db: D1Database, nowSec: number): Promise<void> {
  if (pendingSiteDataRequestAttributionFlush) {
    return pendingSiteDataRequestAttributionFlush;
  }

  const flushPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, REQUEST_ATTRIBUTION_FLUSH_DELAY_MS);
  })
    .then(() => flushBufferedSiteDataRequestAttribution(db, nowSec))
    .catch((error: unknown) => {
      console.warn("[request-attribution] site-data attribution flush failed:", error);
    })
    .finally(() => {
      if (pendingSiteDataRequestAttributionFlush === flushPromise) {
        pendingSiteDataRequestAttributionFlush = null;
      }
      if (bufferedSiteDataRequestAttribution.size > 0 && !pendingSiteDataRequestAttributionFlush) {
        pendingSiteDataRequestAttributionFlush = scheduleSiteDataRequestAttributionFlush(db, Math.floor(Date.now() / 1000));
      }
    });
  pendingSiteDataRequestAttributionFlush = flushPromise;
  return flushPromise;
}
