import { buildPaginatedQuery } from "./db";
import { getLatestSuccessfulCronTimestamp } from "./api-freshness";
import {
  encodeJsonCursor,
  parseBooleanParam,
  parseJsonCursorParam,
  parseQueryParams,
  type ParamSpec,
} from "./api-params";
import { errorResponse, jsonFreshResponse } from "./api-response";

const PAGINATED_TABLES = new Set([
  "blacklist_events",
  "mint_burn_events",
  "depeg_events",
  "depeg_events_with_provenance",
]);

const PAGINATED_INDEXES_BY_TABLE: Readonly<Record<string, ReadonlySet<string>>> = {
  blacklist_events: new Set([
    "idx_blacklist_events_public_date_page",
    "idx_blacklist_events_public_stablecoin_page",
    "idx_blacklist_events_public_chain_page",
    "idx_blacklist_events_public_chain_id_page",
    "idx_blacklist_events_public_event_page",
  ]),
};

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
  indexName?: string;
  orderBy: string;
  queryComment?: string;
  conditions: string[];
  filterBindings: (string | number)[];
  limit: number;
  offset: number;
  includeTotal?: boolean;
  mapRow: (row: TRow) => TEvent;
  cursor?: PaginatedEventCursorConfig<TRow>;
  cursorValues?: CursorPrimitive[] | null;
}

interface PaginatedEventPaginationConfig {
  defaultLimit: number;
  minLimit: number;
  maxLimit: number;
  maxOffset?: number;
  zeroLimitAsDefault?: boolean;
  includeTotalDefault?: boolean;
}

type CursorPrimitive = string | number;

interface PaginatedEventCursorColumn<TRow> {
  column: string;
  type: "number" | "string";
  direction: "ASC" | "DESC";
  getValue: (row: TRow) => CursorPrimitive | null | undefined;
}

interface PaginatedEventCursorConfig<TRow> {
  parameterName?: string;
  columns: readonly PaginatedEventCursorColumn<TRow>[];
}

interface PaginatedEventResponseConfig<TRow, TEvent, TExtra extends Record<string, unknown>> {
  tableName: string;
  indexName?: string;
  orderBy: string;
  queryComment?: string;
  conditions: string[];
  filterBindings: (string | number)[];
  mapRow: (row: TRow) => TEvent;
  searchParams: URLSearchParams;
  pagination: PaginatedEventPaginationConfig;
  cursor?: PaginatedEventCursorConfig<TRow>;
  freshness: {
    producerJob: string;
    maxAgeSec: number;
    fallbackTimestamp: (events: TEvent[]) => number;
  };
  cacheControl: string;
  buildExtraBody?: (events: TEvent[], total: number, fallbackTimestamp: number) => TExtra | Promise<TExtra>;
}

interface ParsedPagination {
  limit: number;
  offset: number;
  includeTotal: boolean;
  cursorValues: CursorPrimitive[] | null;
}

function encodeCursor(values: CursorPrimitive[]): string {
  return encodeJsonCursor({ v: 1, values });
}

function parseCursorValues<TRow>(
  rawCursor: string | null,
  config?: PaginatedEventCursorConfig<TRow>,
): CursorPrimitive[] | null | Response {
  if (!rawCursor) return null;
  if (!config) return errorResponse(400, "Invalid cursor: cursor pagination is not supported for this endpoint");

  return parseJsonCursorParam(rawCursor, (parsed) => {
    if (parsed === null || typeof parsed !== "object") return null;
    const payload = parsed as { v?: unknown; values?: unknown };
    if (payload.v !== 1 || !Array.isArray(payload.values) || payload.values.length !== config.columns.length) {
      return null;
    }

    const values: CursorPrimitive[] = [];
    for (let i = 0; i < config.columns.length; i++) {
      const column = config.columns[i]!;
      const value = payload.values[i];
      if (column.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return null;
        }
        values.push(value);
        continue;
      }
      if (typeof value !== "string") {
        return null;
      }
      values.push(value);
    }
    return values;
  });
}

function buildCursorWhereClause<TRow>(
  cursor: PaginatedEventCursorConfig<TRow>,
  values: CursorPrimitive[],
): { condition: string; bindings: CursorPrimitive[] } {
  if (cursor.columns.length === 0) throw new Error("Cursor pagination requires at least one column");
  const disjunctions: string[] = [];
  const bindings: CursorPrimitive[] = [];

  for (let i = 0; i < cursor.columns.length; i++) {
    const predicates: string[] = [];
    for (let j = 0; j < i; j++) {
      const column = cursor.columns[j]!;
      predicates.push(`${column.column} = ?`);
      bindings.push(values[j]!);
    }
    const column = cursor.columns[i]!;
    const operator = column.direction === "DESC" ? "<" : ">";
    predicates.push(`${column.column} ${operator} ?`);
    bindings.push(values[i]!);
    disjunctions.push(`(${predicates.join(" AND ")})`);
  }

  return {
    condition: `(${disjunctions.join(" OR ")})`,
    bindings,
  };
}

function validateCursorConfig<TRow>(cursor?: PaginatedEventCursorConfig<TRow>): void {
  if (!cursor) return;
  if (cursor.columns.length === 0) throw new Error("Cursor pagination requires at least one column");
  for (const column of cursor.columns) {
    if (!PAGINATED_ORDER_COLS.has(column.column)) throw new Error(`Invalid cursor column: ${column.column}`);
    if (!PAGINATED_ORDER_DIRECTIONS.has(column.direction)) {
      throw new Error(`Invalid cursor direction: ${column.direction}`);
    }
  }
}

function buildNextCursor<TRow>(
  cursor: PaginatedEventCursorConfig<TRow> | undefined,
  lastRow: TRow | undefined,
): string | null {
  if (!cursor || !lastRow) return null;
  const values: CursorPrimitive[] = [];
  for (const column of cursor.columns) {
    const value = column.getValue(lastRow);
    if (value == null) return null;
    values.push(value);
  }
  return encodeCursor(values);
}

function buildSqlComment(comment: string | undefined, suffix: string): string {
  if (!comment) return "";
  if (!/^[a-z0-9:-]+$/.test(comment)) throw new Error(`Invalid query comment: ${comment}`);
  return `/* ${comment}:${suffix} */ `;
}

function buildFromClause(tableName: string, indexName: string | undefined): string {
  if (!indexName) return tableName;
  if (!PAGINATED_INDEXES_BY_TABLE[tableName]?.has(indexName)) {
    throw new Error(`Invalid pagination index ${indexName} for table ${tableName}`);
  }
  return `${tableName} INDEXED BY ${indexName}`;
}

export async function fetchPaginatedEvents<TRow, TEvent>(
  db: D1Database,
  config: PaginatedEventQueryConfig<TRow, TEvent>,
): Promise<{ events: TEvent[]; total: number; totalExact?: boolean; nextCursor?: string | null }> {
  if (!PAGINATED_TABLES.has(config.tableName)) throw new Error(`Invalid table: ${config.tableName}`);
  validateCursorConfig(config.cursor);
  const fromClause = buildFromClause(config.tableName, config.indexName);

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

  const dataConditions = [...config.conditions];
  const dataFilterBindings = [...config.filterBindings];
  if (config.cursor && config.cursorValues) {
    const cursorClause = buildCursorWhereClause(config.cursor, config.cursorValues);
    dataConditions.push(cursorClause.condition);
    dataFilterBindings.push(...cursorClause.bindings);
  }

  const dataLimit = config.cursor ? config.limit + 1 : config.limit;
  const {
    where: dataWhere,
    limitClause,
    offsetClause,
    paginationBindings,
  } = buildPaginatedQuery({
    conditions: dataConditions,
    limit: dataLimit,
    offset: config.cursorValues ? 0 : config.offset,
  });

  // SAFETY: `tableName` and every `ORDER BY` clause token are validated against allowlists above.
  const dataSql =
    `SELECT ${buildSqlComment(config.queryComment, "page")}* FROM ${fromClause}${dataWhere} ORDER BY ${normalizedOrderBy}${limitClause}${offsetClause}`;
  const dataStatement = db.prepare(dataSql).bind(...dataFilterBindings, ...paginationBindings);

  let total: number | null = null;
  let dataBatch: D1Result<TRow>;
  if (config.includeTotal ?? true) {
    const { where: countWhere } = buildPaginatedQuery({
      conditions: config.conditions,
      limit: 0,
      offset: 0,
    });
    const [countBatch, dataResult] = await db.batch([
      // SAFETY: `tableName` has already passed the explicit `PAGINATED_TABLES` allowlist check above.
      db.prepare(
        `SELECT ${buildSqlComment(config.queryComment, "count")}COUNT(*) as total FROM ${fromClause}${countWhere}`,
      ).bind(...config.filterBindings),
      dataStatement,
    ]);
    total = ((countBatch.results ?? []) as { total: number }[])[0]?.total ?? 0;
    dataBatch = dataResult as D1Result<TRow>;
  } else {
    dataBatch = await dataStatement.all<TRow>();
  }

  const rows = (dataBatch.results ?? []) as TRow[];
  const hasMore = config.cursor ? rows.length > config.limit : false;
  const pageRows = hasMore ? rows.slice(0, config.limit) : rows;
  const events = pageRows.map(config.mapRow);
  const lowerBoundTotal = config.cursorValues
    ? events.length + (hasMore ? 1 : 0)
    : config.offset + events.length + (hasMore ? 1 : 0);
  const result: { events: TEvent[]; total: number; totalExact?: boolean; nextCursor?: string | null } = {
    events,
    total: total ?? lowerBoundTotal,
  };
  if (config.cursor) {
    result.nextCursor = hasMore ? buildNextCursor(config.cursor, pageRows[pageRows.length - 1]) : null;
    result.totalExact = total != null;
  } else if (!(config.includeTotal ?? true)) {
    result.totalExact = false;
  }
  return result;
}

export function parsePaginatedEventParams(
  searchParams: URLSearchParams,
  config: PaginatedEventPaginationConfig,
  cursor?: PaginatedEventCursorConfig<unknown>,
): ParsedPagination | Response {
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
      max: config.maxOffset ?? Number.MAX_SAFE_INTEGER,
      rangePolicy: "reject",
    },
  } satisfies Record<"limit" | "offset", ParamSpec>);
  if (parsed instanceof Response) return parsed;

  const includeTotal = parseBooleanParam(
    searchParams.get("includeTotal"),
    "includeTotal",
    config.includeTotalDefault ?? true,
  );
  if (includeTotal instanceof Response) return includeTotal;

  const cursorParamName = cursor?.parameterName ?? "cursor";
  const cursorValues = parseCursorValues(searchParams.get(cursorParamName), cursor);
  if (cursorValues instanceof Response) return cursorValues;
  if (cursorValues && parsed.offset > 0) {
    return errorResponse(400, "Invalid pagination: cursor and offset cannot be combined");
  }

  return {
    limit: config.zeroLimitAsDefault && parsed.limit === 0 ? config.defaultLimit : parsed.limit,
    offset: parsed.offset,
    includeTotal,
    cursorValues,
  };
}

export async function buildPaginatedEventResponse<
  TRow,
  TEvent,
  TExtra extends Record<string, unknown> = Record<string, unknown>,
>(db: D1Database, config: PaginatedEventResponseConfig<TRow, TEvent, TExtra>): Promise<Response> {
  const pagination = parsePaginatedEventParams(
    config.searchParams,
    config.pagination,
    config.cursor as PaginatedEventCursorConfig<unknown> | undefined,
  );
  if (pagination instanceof Response) return pagination;

  const { events, total, totalExact, nextCursor } = await fetchPaginatedEvents<TRow, TEvent>(db, {
    tableName: config.tableName,
    indexName: config.indexName,
    orderBy: config.orderBy,
    queryComment: config.queryComment,
    conditions: config.conditions,
    filterBindings: config.filterBindings,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
    mapRow: config.mapRow,
    cursor: config.cursor,
    cursorValues: pagination.cursorValues,
  });

  const fallbackTimestamp = config.freshness.fallbackTimestamp(events);
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, config.freshness.producerJob, fallbackTimestamp);
  const extraBody = config.buildExtraBody ? await config.buildExtraBody(events, total, fallbackTimestamp) : {};

  return jsonFreshResponse(
    {
      events,
      total,
      ...(config.cursor || !pagination.includeTotal ? { totalExact: totalExact ?? pagination.includeTotal } : {}),
      ...(config.cursor ? { nextCursor: nextCursor ?? null } : {}),
      ...extraBody,
    },
    {
      cacheControl: config.cacheControl,
      updatedAt: freshnessTs,
      maxAgeSec: config.freshness.maxAgeSec,
    },
  );
}
