import { buildPaginatedQuery } from "./db";
import { getLatestSuccessfulCronTimestamp } from "./api-freshness";
import { parseQueryParams, type ParamSpec } from "./api-params";
import { jsonFreshResponse } from "./api-response";

const PAGINATED_TABLES = new Set(["blacklist_events", "mint_burn_events", "depeg_events"]);

const PAGINATED_ORDER_COLS = new Set([
  "timestamp",
  "block_number",
  "created_at",
  "detected_at",
  "started_at",
  "stablecoin",
  "chain_name",
  "event_type",
  "id",
]);

const PAGINATED_ORDER_DIRECTIONS = new Set(["ASC", "DESC"]);

interface PaginatedEventQueryConfig<TRow, TEvent> {
  tableName: string;
  orderBy: string;
  conditions: string[];
  filterBindings: (string | number)[];
  limit: number;
  offset: number;
  mapRow: (row: TRow) => TEvent;
}

interface PaginatedEventPaginationConfig {
  defaultLimit: number;
  minLimit: number;
  maxLimit: number;
  zeroLimitAsDefault?: boolean;
}

interface PaginatedEventResponseConfig<TRow, TEvent, TExtra extends Record<string, unknown>> {
  tableName: string;
  orderBy: string;
  conditions: string[];
  filterBindings: (string | number)[];
  mapRow: (row: TRow) => TEvent;
  searchParams: URLSearchParams;
  pagination: PaginatedEventPaginationConfig;
  freshness: {
    producerJob: string;
    maxAgeSec: number;
    fallbackTimestamp: (events: TEvent[]) => number;
  };
  cacheControl: string;
  buildExtraBody?: (events: TEvent[], total: number, fallbackTimestamp: number) => TExtra | Promise<TExtra>;
}

export async function fetchPaginatedEvents<TRow, TEvent>(
  db: D1Database,
  config: PaginatedEventQueryConfig<TRow, TEvent>,
): Promise<{ events: TEvent[]; total: number }> {
  if (!PAGINATED_TABLES.has(config.tableName)) throw new Error(`Invalid table: ${config.tableName}`);

  const normalizedOrderBy = config.orderBy.trim().replace(/\s+/g, " ");
  const orderClauses = normalizedOrderBy
    .split(",")
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (orderClauses.length === 0) throw new Error(`Invalid orderBy: ${config.orderBy}`);

  for (const clause of orderClauses) {
    const [orderColumn, orderDirection, ...extraOrderTokens] = clause.split(" ");
    if (!PAGINATED_ORDER_COLS.has(orderColumn)) throw new Error(`Invalid orderBy column: ${orderColumn}`);
    if (extraOrderTokens.length > 0) throw new Error(`Invalid orderBy: ${config.orderBy}`);
    if (orderDirection && !PAGINATED_ORDER_DIRECTIONS.has(orderDirection)) {
      throw new Error(`Invalid orderBy direction: ${orderDirection}`);
    }
  }

  const { where, limitClause, offsetClause, paginationBindings } = buildPaginatedQuery({
    conditions: config.conditions,
    limit: config.limit,
    offset: config.offset,
  });

  // SAFETY: `tableName` and every `ORDER BY` clause token are validated against allowlists above.
  const dataSql = `SELECT * FROM ${config.tableName}${where} ORDER BY ${normalizedOrderBy}${limitClause}${offsetClause}`;
  const [countBatch, dataBatch] = await db.batch([
    // SAFETY: `tableName` has already passed the explicit `PAGINATED_TABLES` allowlist check above.
    db.prepare(`SELECT COUNT(*) as total FROM ${config.tableName}${where}`).bind(...config.filterBindings),
    db.prepare(dataSql).bind(...config.filterBindings, ...paginationBindings),
  ]);

  const total = ((countBatch.results ?? []) as { total: number }[])[0]?.total ?? 0;
  const events = ((dataBatch.results ?? []) as TRow[]).map(config.mapRow);
  return { events, total };
}

export function parsePaginatedEventParams(
  searchParams: URLSearchParams,
  config: PaginatedEventPaginationConfig,
): { limit: number; offset: number } | Response {
  const parsed = parseQueryParams(searchParams, {
    limit: {
      type: "int",
      default: config.defaultLimit,
      min: config.minLimit,
      max: config.maxLimit,
      rangePolicy: "reject",
    },
    offset: {
      type: "int",
      default: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      rangePolicy: "reject",
    },
  } satisfies Record<"limit" | "offset", ParamSpec>);
  if (parsed instanceof Response) return parsed;

  return {
    limit: config.zeroLimitAsDefault && parsed.limit === 0 ? config.defaultLimit : parsed.limit,
    offset: parsed.offset,
  };
}

export async function buildPaginatedEventResponse<
  TRow,
  TEvent,
  TExtra extends Record<string, unknown> = Record<string, unknown>,
>(db: D1Database, config: PaginatedEventResponseConfig<TRow, TEvent, TExtra>): Promise<Response> {
  const pagination = parsePaginatedEventParams(config.searchParams, config.pagination);
  if (pagination instanceof Response) return pagination;

  const { events, total } = await fetchPaginatedEvents<TRow, TEvent>(db, {
    tableName: config.tableName,
    orderBy: config.orderBy,
    conditions: config.conditions,
    filterBindings: config.filterBindings,
    limit: pagination.limit,
    offset: pagination.offset,
    mapRow: config.mapRow,
  });

  const fallbackTimestamp = config.freshness.fallbackTimestamp(events);
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, config.freshness.producerJob, fallbackTimestamp);
  const extraBody = config.buildExtraBody ? await config.buildExtraBody(events, total, fallbackTimestamp) : {};

  return jsonFreshResponse(
    {
      events,
      total,
      ...extraBody,
    },
    {
      cacheControl: config.cacheControl,
      updatedAt: freshnessTs,
      maxAgeSec: config.freshness.maxAgeSec,
    },
  );
}
