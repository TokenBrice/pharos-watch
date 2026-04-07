import { buildPaginatedQuery } from "./db";

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
  "stablecoin",
  "chain_name",
  "event_type",
  "id",
]);

const PAGINATED_ORDER_DIRECTIONS = new Set([
  "ASC",
  "DESC",
]);

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
  const orderClauses = normalizedOrderBy.split(",").map((clause) => clause.trim()).filter(Boolean);
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
