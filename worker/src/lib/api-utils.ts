import { buildInClause, buildPaginatedQuery } from "./db";
import { getCache } from "./db-cache";
import { CACHE_FRESHNESS_THRESHOLDS } from "./constants";
import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { FRESHNESS_RATIOS, STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { CacheStatus } from "@shared/types";
import type { ZodType } from "zod";
import { buildFxCacheStatus, getFxRatesMetaKey, hydrateFxRateState } from "./fx-rate-state";

export type { CacheStatus };

export interface CacheStatusFailure {
  key: string;
  source: "cache-table" | "table-freshness";
  message: string;
}

// --- Data freshness metadata ---

export interface FreshnessMeta {
  updatedAt: number;
  ageSeconds: number;
  status: "fresh" | "degraded" | "stale";
}

export function buildFreshnessMeta(updatedAt: number, maxAgeSec: number): FreshnessMeta {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  const ratio = age / maxAgeSec;
  return {
    updatedAt,
    ageSeconds: age,
    status: ratio <= FRESHNESS_RATIOS.FRESH ? "fresh" : ratio <= FRESHNESS_RATIOS.DEGRADED ? "degraded" : "stale",
  };
}

// --- Shared cache freshness logic ---

/**
 * Keys in CACHE_FRESHNESS_THRESHOLDS that live in dedicated tables rather than
 * the `cache` key/value table, and need table-specific freshness queries.
 */
const TABLE_FRESHNESS_QUERIES: Record<string, string> = {
  // Use latest-row freshness (now - MAX(timestamp)); oldest-row checks create false stale signals.
  "dex-liquidity": "SELECT (? - MAX(updated_at)) as age FROM dex_liquidity WHERE liquidity_score > 0",
  "yield-data":    "SELECT (? - MAX(updated_at)) as age FROM yield_data WHERE is_best = 1",
  "dews":          "SELECT (? - MAX(computed_at)) as age FROM stress_signals",
};

const PAGINATED_TABLES = new Set([
  "blacklist_events",
  "mint_burn_events",
  "depeg_events",
]);

const PAGINATED_ORDER_COLS = new Set([
  "timestamp",
  "block_number",
  "created_at",
  "detected_at",
  "started_at",
]);

const PAGINATED_ORDER_DIRECTIONS = new Set([
  "ASC",
  "DESC",
]);

/**
 * Queries the cache table and evaluates freshness for every key in
 * CACHE_FRESHNESS_THRESHOLDS. Used by both /health and /status endpoints.
 *
 * For keys stored in dedicated tables (dex-liquidity, yield-data, dews), the
 * table is queried directly instead of the cache key/value store.
 */
export async function buildCacheStatuses(
  db: D1Database,
  now: number,
): Promise<{
  caches: Record<string, CacheStatus>;
  worstRatio: number;
  failures: CacheStatusFailure[];
  statusFloor: "healthy" | "degraded" | "stale";
  warnings: string[];
}> {
  // Fetch rows from the generic cache table (excludes table-backed keys)
  const cacheOnlyKeys = Object.keys(CACHE_FRESHNESS_THRESHOLDS).filter(
    (k) => !(k in TABLE_FRESHNESS_QUERIES),
  );
  const fxMetaKey = getFxRatesMetaKey();
  const cacheLookupKeys = cacheOnlyKeys.includes("fx-rates")
    ? [...cacheOnlyKeys, fxMetaKey]
    : cacheOnlyKeys;
  let cacheRows: { results?: Array<{ key: string; updated_at: number; value?: string | null }> } = { results: [] };
  const failures: CacheStatusFailure[] = [];
  if (cacheLookupKeys.length > 0) {
    try {
      const inClause = buildInClause(cacheLookupKeys);
      cacheRows = await db
        .prepare(`SELECT key, value, updated_at FROM cache WHERE key IN (${inClause.sql})`)
        .bind(...inClause.binds)
        .all<{ key: string; updated_at: number; value?: string | null }>();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({
        key: "__cache__",
        source: "cache-table",
        message,
      });
      cacheRows = { results: [] };
    }
  }
  const cacheMap = new Map((cacheRows.results ?? []).map(r => [r.key, r.updated_at]));

  const caches: Record<string, CacheStatus> = {};
  let worstRatio = 0;
  let statusFloor: "healthy" | "degraded" | "stale" = "healthy";
  const warnings: string[] = [];
  const fxState = cacheOnlyKeys.includes("fx-rates")
    ? hydrateFxRateState(
        (() => {
          const row = (cacheRows.results ?? []).find((entry) => entry.key === "fx-rates");
          return row?.value != null ? { value: row.value, updatedAt: row.updated_at } : null;
        })(),
        (() => {
          const row = (cacheRows.results ?? []).find((entry) => entry.key === fxMetaKey);
          return row?.value != null ? { value: row.value, updatedAt: row.updated_at } : null;
        })(),
      )
    : null;

  for (const [key, maxAge] of Object.entries(CACHE_FRESHNESS_THRESHOLDS)) {
    let ageSeconds: number | null;

    if (key === "fx-rates") {
      const fx = buildFxCacheStatus(fxState, maxAge, now);
      caches[key] = fx.cacheStatus;
      ageSeconds = fx.cacheStatus.ageSeconds;
      if (fx.warning) warnings.push(`fx-rates: ${fx.warning}`);
      if (fx.statusFloor === "stale") {
        statusFloor = "stale";
      } else if (fx.statusFloor === "degraded" && statusFloor === "healthy") {
        statusFloor = "degraded";
      }
    } else if (key in TABLE_FRESHNESS_QUERIES) {
      try {
        const row = await db
          .prepare(TABLE_FRESHNESS_QUERIES[key])
          .bind(now)
          .first<{ age: number | null }>();
        ageSeconds = row?.age != null ? Math.max(0, row.age) : null;
      } catch (err) {
        failures.push({
          key,
          source: "table-freshness",
          message: err instanceof Error ? err.message : String(err),
        });
        ageSeconds = null;
      }
    } else {
      const updatedAt = cacheMap.get(key);
      ageSeconds = updatedAt != null ? now - updatedAt : null;
    }

    const ratio = ageSeconds != null ? ageSeconds / maxAge : Infinity;
    if (ratio > worstRatio) worstRatio = ratio;
    if (!caches[key]) {
      caches[key] = { ageSeconds, maxAge, healthy: ratio <= FRESHNESS_RATIOS.DEGRADED };
    }
  }

  if (statusFloor !== "stale") {
    statusFloor =
      worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale
        ? "stale"
        : worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.degraded
          ? "degraded"
          : statusFloor;
  } else if (worstRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale) {
    statusFloor = "stale";
  }

  return { caches, worstRatio, failures, statusFloor, warnings };
}

/**
 * Wraps an API handler with standardized error handling.
 * Catches unhandled exceptions, logs them with the endpoint name, and returns a 500 JSON response.
 *
 * CORS headers are applied in index.ts after the handler returns,
 * so error responses from this wrapper get CORS automatically.
 */
type ApiHandler<T extends unknown[] = unknown[]> = (...args: T) => Promise<Response>;

export function withErrorHandler<T extends unknown[]>(
  endpoint: string,
  handler: ApiHandler<T>,
): ApiHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[api] Error in ${endpoint}:`, err);
      return errorResponse(500, "Internal Server Error");
    }
  };
}

/** Safely parse JSON, returning fallback on failure */
export function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (json == null) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

/**
 * Resolve a canonical stablecoin ID.
 * Returns a 404 response when unknown so handlers can early-return consistently.
 */
export function resolveOrReject(id: string): { canonicalId: string } | Response {
  const resolved = resolveStablecoinId(id);
  if (!resolved) {
    return errorResponse(404, "Unknown stablecoin");
  }
  return { canonicalId: resolved.canonicalId };
}

// --- Shared response builders ---

/** Build a JSON error response. Replaces inline `new Response(JSON.stringify({ error }), ...)` calls. */
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Parse an integer query parameter with default, min, and max bounds.
 *
 * Returns the parsed number on success, or a 400 Response on validation failure.
 * Callers MUST check `instanceof Response` before using the return value:
 *
 * ```typescript
 * const limit = parseIntParam(url.searchParams.get("limit"), 50, 1, 200, "limit");
 * if (limit instanceof Response) return limit;
 * // limit is now narrowed to number
 * ```
 *
 * This is a project convention used consistently across all API handlers.
 */
export function parseIntParam(
  value: string | null | undefined,
  defaultVal: number,
  min: number,
  max: number,
  name = "parameter",
): number | Response {
  if (value == null) return defaultVal;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  return Math.min(max, Math.max(min, parsed));
}

export function parseFloatParam(
  value: string | null | undefined,
  defaultVal: number,
  min: number,
  max: number,
  name = "parameter",
): number | Response {
  if (value == null) return defaultVal;
  const trimmed = value.trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  return Math.min(max, Math.max(min, parsed));
}

export interface MethodologyEnvelopeInput {
  version: string;
  versionLabel: string;
  currentVersion: string;
  currentVersionLabel: string;
  changelogPath: string;
  asOf: number;
}

export function buildMethodologyEnvelope({
  version,
  versionLabel,
  currentVersion,
  currentVersionLabel,
  changelogPath,
  asOf,
}: MethodologyEnvelopeInput): MethodologyEnvelopeInput & { isCurrent: boolean } {
  return {
    version,
    versionLabel,
    currentVersion,
    currentVersionLabel,
    changelogPath,
    asOf,
    isCurrent: version === currentVersion,
  };
}

export interface StablecoinHistoryQueryOptions {
  defaultDays: number;
  minDays: number;
  maxDays: number;
}

export interface StablecoinHistoryQuery {
  stablecoinId: string;
  days: number;
  cutoff: number;
}

/**
 * Parse the common `stablecoin` + `days` query params used by history endpoints.
 * Returns a Response on validation failure to preserve endpoint-specific error behavior.
 */
export function parseStablecoinHistoryQuery(
  url: URL,
  opts: StablecoinHistoryQueryOptions,
): StablecoinHistoryQuery | Response {
  const stablecoinId = url.searchParams.get("stablecoin");
  if (!stablecoinId) {
    return errorResponse(400, "Missing ?stablecoin= parameter");
  }

  const resolved = resolveOrReject(stablecoinId);
  if (resolved instanceof Response) {
    return resolved;
  }

  const days = parseIntParam(
    url.searchParams.get("days"),
    opts.defaultDays,
    opts.minDays,
    opts.maxDays,
    "days",
  );
  if (days instanceof Response) {
    return days;
  }
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;

  return { stablecoinId: resolved.canonicalId, days, cutoff };
}

interface StablecoinHistoryContext<TRow, THistory> {
  db: D1Database;
  stablecoinId: string;
  cutoff: number;
  rows: TRow[];
  history: THistory[];
}

interface StablecoinHistoryHandlerConfig<TRow, THistory> {
  query: StablecoinHistoryQueryOptions;
  cacheControl: string;
  fetchRows: (ctx: { db: D1Database; stablecoinId: string; cutoff: number }) => Promise<TRow[]>;
  mapRow: (row: TRow) => THistory;
  freshness?: (
    ctx: StablecoinHistoryContext<TRow, THistory>,
  ) => Promise<{ updatedAt: number; maxAgeSec: number } | null> | { updatedAt: number; maxAgeSec: number } | null;
  buildHeaders?: (
    ctx: StablecoinHistoryContext<TRow, THistory>,
  ) => Promise<Record<string, string>> | Record<string, string>;
}

export async function handleStablecoinHistoryRequest<TRow, THistory>(
  db: D1Database,
  url: URL,
  config: StablecoinHistoryHandlerConfig<TRow, THistory>,
): Promise<Response> {
  const parsed = parseStablecoinHistoryQuery(url, config.query);
  if (parsed instanceof Response) {
    return parsed;
  }

  const rows = await config.fetchRows({
    db,
    stablecoinId: parsed.stablecoinId,
    cutoff: parsed.cutoff,
  });
  const history = rows.map(config.mapRow);

  const extraHeaders = config.buildHeaders
    ? await config.buildHeaders({
        db,
        stablecoinId: parsed.stablecoinId,
        cutoff: parsed.cutoff,
        rows,
        history,
      })
    : undefined;

  const context = {
    db,
    stablecoinId: parsed.stablecoinId,
    cutoff: parsed.cutoff,
    rows,
    history,
  };
  const freshness = config.freshness ? await config.freshness(context) : null;

  if (!freshness) {
    return jsonResponse(history, {
      "Cache-Control": config.cacheControl,
      ...(extraHeaders ?? {}),
    });
  }

  return jsonFreshResponse(history, {
    cacheControl: config.cacheControl,
    updatedAt: freshness.updatedAt,
    maxAgeSec: freshness.maxAgeSec,
    headers: extraHeaders,
  });
}

interface PaginatedEventQueryConfig<TRow, TEvent> {
  tableName: string;
  orderBy: string;
  conditions: string[];
  filterBindings: (string | number)[];
  limit: number;
  offset: number;
  mapRow: (row: TRow) => TEvent;
}

export async function fetchPaginatedEvents<TRow, TEvent>(
  db: D1Database,
  config: PaginatedEventQueryConfig<TRow, TEvent>,
): Promise<{ events: TEvent[]; total: number }> {
  if (!PAGINATED_TABLES.has(config.tableName)) throw new Error(`Invalid table: ${config.tableName}`);

  const normalizedOrderBy = config.orderBy.trim().replace(/\s+/g, " ");
  const [orderColumn, orderDirection, ...extraOrderTokens] = normalizedOrderBy.split(" ");
  if (!PAGINATED_ORDER_COLS.has(orderColumn)) throw new Error(`Invalid orderBy column: ${orderColumn}`);
  if (extraOrderTokens.length > 0) throw new Error(`Invalid orderBy: ${config.orderBy}`);
  if (orderDirection && !PAGINATED_ORDER_DIRECTIONS.has(orderDirection)) {
    throw new Error(`Invalid orderBy direction: ${orderDirection}`);
  }

  const { where, limitClause, offsetClause, paginationBindings } = buildPaginatedQuery({
    conditions: config.conditions,
    limit: config.limit,
    offset: config.offset,
  });

  // SAFETY: validated against PAGINATED_TABLES and PAGINATED_ORDER_COLS allowlists above.
  const dataSql = `SELECT * FROM ${config.tableName}${where} ORDER BY ${normalizedOrderBy}${limitClause}${offsetClause}`;
  const [countBatch, dataBatch] = await db.batch([
    // SAFETY: validated against PAGINATED_TABLES allowlist above.
    db.prepare(`SELECT COUNT(*) as total FROM ${config.tableName}${where}`).bind(...config.filterBindings),
    db.prepare(dataSql).bind(...config.filterBindings, ...paginationBindings),
  ]);

  const total = ((countBatch.results ?? []) as { total: number }[])[0]?.total ?? 0;
  const events = ((dataBatch.results ?? []) as TRow[]).map(config.mapRow);
  return { events, total };
}

/** Build a JSON success response with optional extra headers. */
export function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface JsonFreshResponseOptions {
  cacheControl?: string;
  updatedAt?: number | null;
  maxAgeSec?: number;
  headers?: Record<string, string>;
}

export function jsonFreshResponse(body: unknown, options: JsonFreshResponseOptions): Response {
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };

  if (options.cacheControl) {
    headers["Cache-Control"] = options.cacheControl;
  }

  if (options.updatedAt != null && options.maxAgeSec != null) {
    return jsonResponse(body, addFreshnessHeaders(headers, options.updatedAt, options.maxAgeSec));
  }

  return jsonResponse(body, headers);
}

/** Validate payload with a Zod schema before cache/db write; logs parse issues for observability. */
export function validatePayloadWithSchema<T>(
  schema: ZodType<T>,
  payload: unknown,
  context: string,
): { ok: true; data: T } | { ok: false; issues: string } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
    .join(", ");
  console.error(`[validate] ${context} schema validation failed: ${issues}`);
  return { ok: false, issues };
}

export function readCachedJsonOr503<T>(
  endpoint: string,
  cacheKey: string,
  cached: { value: string },
): { ok: true; data: T } | { ok: false; response: Response } {
  try {
    return { ok: true, data: JSON.parse(cached.value) as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cache] Failed to parse ${endpoint} cached payload (${cacheKey}):`, message);
    return {
      ok: false,
      response: errorResponse(503, `Cached ${cacheKey} payload is malformed`),
    };
  }
}

/**
 * Creates a cache-passthrough API handler that reads from the cache table
 * and returns the cached JSON with freshness headers.
 */
export function createCacheHandler(
  endpoint: string,
  cacheKey: string,
  cacheControl: string,
  maxAgeSec: number,
): (db: D1Database) => Promise<Response> {
  return withErrorHandler(endpoint, async (db: D1Database): Promise<Response> => {
    const cached = await getCache(db, cacheKey);
    if (!cached) {
      return errorResponse(503, "Data not yet available");
    }

    const headers = addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    }, cached.updatedAt, maxAgeSec);

    // Inject _meta into plain-object responses (not arrays)
    const parsed = readCachedJsonOr503<unknown>(endpoint, cacheKey, cached);
    if (!parsed.ok) {
      return parsed.response;
    }
    if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
      (parsed.data as Record<string, unknown>)._meta = buildFreshnessMeta(cached.updatedAt, maxAgeSec);
      return new Response(JSON.stringify(parsed.data), { headers });
    }
    if (Array.isArray(parsed.data)) {
      return new Response(cached.value, { headers });
    }

    return new Response(cached.value, { headers });
  });
}

/**
 * Adds data freshness headers to a cache-passthrough response.
 * - X-Data-Age: seconds since cache was last updated
 * - Warning: RFC 7234 stale-data warning when data exceeds maxAgeSec
 * Purely additive — never changes response body or status.
 */
export function addFreshnessHeaders(
  headers: Record<string, string>,
  updatedAt: number,
  maxAgeSec: number,
): Record<string, string> {
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  const result: Record<string, string> = { ...headers, "X-Data-Age": String(age) };
  if (age > maxAgeSec) {
    result["Warning"] = `110 - "Response is stale (${age}s old, max ${maxAgeSec}s)"`;
  }
  return result;
}

/** Latest successful cron run timestamp for freshness metadata. */
export async function getLatestSuccessfulCronTimestamp(
  db: D1Database,
  job: string,
  fallback: number,
): Promise<number> {
  try {
    const row = await db
      .prepare(
        "SELECT MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
      )
      .bind(job)
      .first<{ started_at: number | null }>();
    if (row?.started_at != null) return row.started_at;
  } catch {
    // Non-blocking: fall back to caller-provided timestamp.
  }
  return fallback;
}
