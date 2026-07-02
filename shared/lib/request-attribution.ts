import { findDynamicEndpointDescriptor, getEndpointDefinition } from "./api-endpoints";
import { PHAROS_WEB_ACCEPT_MARKER } from "./request-source-marker";
import { SITE_ORIGIN } from "./runtime-origins";
import type { ApiRequestConsumerClass } from "../types/request-source";

export const REQUEST_ATTRIBUTION_RETENTION_DAYS = 35;
export const REQUEST_ATTRIBUTION_PRUNE_INTERVAL_SEC = 3600;
export const REQUEST_SOURCE_ATTRIBUTION_DISABLED_ENV = "REQUEST_SOURCE_ATTRIBUTION_DISABLED";

const SAME_SITE_FETCH_VALUES = new Set(["same-site", "same-origin"]);

export interface ApiRequestRouteMetric {
  routeKey: string;
  routePath: string;
}

function safeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function classifyBrowserRequestConsumer(request: Request): ApiRequestConsumerClass {
  const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
  const hasPharosAcceptMarker = accept.includes(PHAROS_WEB_ACCEPT_MARKER);
  const origin = safeOrigin(request.headers.get("Origin"));
  const refererOrigin = safeOrigin(request.headers.get("Referer"));
  const secFetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase() ?? "";

  if (origin === SITE_ORIGIN || refererOrigin === SITE_ORIGIN) {
    return "site";
  }

  if (hasPharosAcceptMarker && SAME_SITE_FETCH_VALUES.has(secFetchSite)) {
    return "site";
  }

  return "external";
}

export function resolveApiRequestRouteMetric(pathname: string): ApiRequestRouteMetric | null {
  if (!pathname.startsWith("/api/")) return null;
  if (pathname === "/api/telegram-webhook") return null;
  const dynamicDescriptor = findDynamicEndpointDescriptor(pathname);
  if (dynamicDescriptor) {
    return dynamicDescriptor.requestAttribution;
  }

  const endpoint = getEndpointDefinition(pathname);
  if (endpoint?.adminRequired) {
    return null;
  }

  if (!endpoint) {
    return {
      routeKey: "unknown-public-api",
      routePath: "/api/*",
    };
  }

  return {
    routeKey: endpoint.key,
    routePath: endpoint.path,
  };
}

export function isEnvFlagEnabled(env: unknown, envName: string): boolean {
  const value = (env as Record<string, unknown> | null | undefined)?.[envName];
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isRequestSourceAttributionDisabled(env: unknown): boolean {
  return isEnvFlagEnabled(env, REQUEST_SOURCE_ATTRIBUTION_DISABLED_ENV);
}

export interface AttributionDb {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => { run: () => Promise<unknown> };
  };
  batch: (statements: never[]) => Promise<unknown>;
}

export interface BufferedAttributionEntry {
  bucketStart: number;
  route: ApiRequestRouteMetric;
  requestCount: number;
}

export interface CreateBufferedAttributionRecorderOptions<TEntry extends BufferedAttributionEntry> {
  batchSize: number;
  flushDelayMs: number;
  pruneIntervalSec: number;
  retentionSec: number;
  insertSql: string;
  pruneSql: readonly string[];
  logLabel: string;
  buildKey: (entry: TEntry) => string;
  bindInsertParams: (entry: TEntry) => unknown[];
  mergeBuffered: (existing: TEntry, incoming: TEntry) => void;
}

export interface BufferedAttributionRecorder<TEntry extends BufferedAttributionEntry, TDb extends AttributionDb = AttributionDb> {
  record: (db: TDb, entry: TEntry, nowSec: number) => Promise<void>;
  maybePrune: (db: TDb, nowSec: number) => Promise<void>;
  reset: () => void;
}

export function createBufferedAttributionRecorder<TEntry extends BufferedAttributionEntry, TDb extends AttributionDb = AttributionDb>(
  options: CreateBufferedAttributionRecorderOptions<TEntry>,
): BufferedAttributionRecorder<TEntry, TDb> {
  let lastPruneBucket: number | null = null;
  let pendingPrune: Promise<void> | null = null;
  const buffered = new Map<string, TEntry>();
  let pendingFlush: Promise<void> | null = null;
  let generation = 0;

  function reset(): void {
    generation++;
    lastPruneBucket = null;
    pendingPrune = null;
    buffered.clear();
    pendingFlush = null;
  }

  async function maybePrune(db: TDb, nowSec: number): Promise<void> {
    const pruneBucket = nowSec - (nowSec % options.pruneIntervalSec);
    if (lastPruneBucket !== pruneBucket && !pendingPrune) {
      lastPruneBucket = pruneBucket;
      const cutoff = nowSec - options.retentionSec;
      const prunePromise = Promise.all(
        options.pruneSql.map((sql) => db.prepare(sql).bind(cutoff).run()),
      )
        .then(() => {})
        .catch((error: unknown) => {
          console.warn(`[request-attribution] ${options.logLabel} prune failed:`, error);
        })
        .finally(() => {
          if (pendingPrune === prunePromise) {
            pendingPrune = null;
          }
        });
      pendingPrune = prunePromise;
    }

    if (pendingPrune) {
      await pendingPrune;
    }
  }

  async function flush(db: TDb, nowSec: number): Promise<void> {
    while (buffered.size > 0) {
      const entries = Array.from(buffered.values());
      buffered.clear();

      for (let index = 0; index < entries.length; index += options.batchSize) {
        const chunk = entries.slice(index, index + options.batchSize);
        const statements = chunk.map((entry) => db
          .prepare(options.insertSql)
          .bind(...options.bindInsertParams(entry)));
        await db.batch(statements as never[]);
      }
    }

    await maybePrune(db, nowSec);
  }

  function scheduleFlush(db: TDb, nowSec: number): Promise<void> {
    if (pendingFlush) {
      return pendingFlush;
    }

    const flushGeneration = generation;
    const flushPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, options.flushDelayMs);
    })
      .then(() => {
        if (flushGeneration !== generation) return;
        return flush(db, nowSec);
      })
      .catch((error: unknown) => {
        console.warn(`[request-attribution] ${options.logLabel} attribution flush failed:`, error);
      })
      .finally(() => {
        if (pendingFlush === flushPromise) {
          pendingFlush = null;
        }
        if (buffered.size > 0 && !pendingFlush) {
          pendingFlush = scheduleFlush(db, Math.floor(Date.now() / 1000));
        }
      });
    pendingFlush = flushPromise;
    return flushPromise;
  }

  async function record(db: TDb, entry: TEntry, nowSec: number): Promise<void> {
    const key = options.buildKey(entry);
    const existing = buffered.get(key);
    if (existing) {
      options.mergeBuffered(existing, entry);
    } else {
      buffered.set(key, entry);
    }

    await scheduleFlush(db, nowSec);
  }

  return { record, maybePrune, reset };
}
