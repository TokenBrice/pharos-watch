import { errorResponse, jsonFreshResponse, jsonResponse } from "./api-response";
import { parseIntParam, resolveOrReject, type NumericRangePolicy } from "./api-params";

export interface StablecoinHistoryQueryOptions {
  defaultDays: number;
  minDays: number;
  maxDays: number;
  rangePolicy?: NumericRangePolicy;
}

export interface StablecoinHistoryQuery {
  stablecoinId: string;
  days: number;
  cutoff: number;
}

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
    { rangePolicy: opts.rangePolicy ?? "clamp" },
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

interface StablecoinHistoryHandlerConfig<TRow, THistory, TBody = THistory[]> {
  query: StablecoinHistoryQueryOptions;
  cacheControl: string;
  fetchRows: (ctx: { db: D1Database; stablecoinId: string; cutoff: number }) => Promise<TRow[]>;
  mapRow: (row: TRow) => THistory;
  buildBody?: (
    ctx: StablecoinHistoryContext<TRow, THistory>,
  ) => Promise<TBody> | TBody;
  freshness?: (
    ctx: StablecoinHistoryContext<TRow, THistory>,
  ) => Promise<{ updatedAt: number; maxAgeSec: number } | null> | { updatedAt: number; maxAgeSec: number } | null;
  buildHeaders?: (
    ctx: StablecoinHistoryContext<TRow, THistory>,
  ) => Promise<Record<string, string>> | Record<string, string>;
}

export async function handleStablecoinHistoryRequest<TRow, THistory, TBody = THistory[]>(
  db: D1Database,
  url: URL,
  config: StablecoinHistoryHandlerConfig<TRow, THistory, TBody>,
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

  const context = {
    db,
    stablecoinId: parsed.stablecoinId,
    cutoff: parsed.cutoff,
    rows,
    history,
  };
  const body = config.buildBody ? await config.buildBody(context) : history;

  const extraHeaders = config.buildHeaders
    ? await config.buildHeaders(context)
    : undefined;

  const freshness = config.freshness ? await config.freshness(context) : null;

  if (!freshness) {
    return jsonResponse(body, {
      headers: {
        "Cache-Control": config.cacheControl,
        ...(extraHeaders ?? {}),
      },
    });
  }

  return jsonFreshResponse(body, {
    cacheControl: config.cacheControl,
    updatedAt: freshness.updatedAt,
    maxAgeSec: freshness.maxAgeSec,
    headers: extraHeaders,
  });
}
