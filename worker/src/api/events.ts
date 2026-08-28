import {
  encodeJsonCursor,
  parseBooleanParam,
  parseJsonCursorParam,
  parseQueryParams,
  resolveOrReject,
} from "../lib/api-params";
import { errorResponse, jsonFreshResponse } from "../lib/api-response";
import { getLatestSuccessfulCronTimestamp, buildFreshnessMeta } from "../lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import { queryTapeEvents, type TapeEventQueryFilters } from "../lib/tape-event-store";
import { rowToTapeEvent } from "../lib/tape-event-helpers";
import {
  SEVERITY_RANK,
  TAPE_EVENT_SEVERITY_VALUES,
  type TapeEvent,
  type TapeEventSeverity,
} from "@shared/types/tape-event";
import { PEG_CURRENCY_VALUES } from "@shared/types/core";
import { resolveChainId } from "@shared/lib/chains";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const MAX_Q_LENGTH = 200;
const MAX_FILTER_EPOCH_MS = Date.UTC(2100, 0, 1);
// `/api/events` advertises a 10-minute freshness budget; the projector lane
// runs every 30 minutes, so `Warning: 110` fires after ~80 min absent.
const FRESHNESS_MAX_AGE_SEC = 600;

const SEVERITY_SET = new Set<string>(TAPE_EVENT_SEVERITY_VALUES);
const PEG_CURRENCY_SET = new Set<string>(PEG_CURRENCY_VALUES);

function isPrefixWildcard(value: string): boolean {
  return value.endsWith(".*");
}

function isValidSlug(value: string): boolean {
  if (value === "") return false;
  const body = value.endsWith(".*") ? value.slice(0, -2) : value;
  if (body === "") return false;
  for (const segment of body.split(".")) {
    if (!/^[a-z0-9_]+$/.test(segment)) return false;
  }
  return true;
}

function parseIntOrNull(value: string | null): number | null | "invalid" {
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(value)) return "invalid";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_FILTER_EPOCH_MS) return "invalid";
  return parsed;
}

interface CursorPayload {
  ts: number;
  id: number;
}

function encodeCursor(payload: CursorPayload): string {
  return encodeJsonCursor({ v: 1, ts: payload.ts, id: payload.id });
}

function parseCursor(value: string | null): CursorPayload | null | Response {
  return parseJsonCursorParam(value, (parsed) => {
    if (parsed === null || typeof parsed !== "object") return null;
    const payload = parsed as { v?: unknown; ts?: unknown; id?: unknown };
    if (payload.v !== 1 || typeof payload.ts !== "number" || typeof payload.id !== "number") return null;
    if (!Number.isFinite(payload.ts) || !Number.isFinite(payload.id)) return null;
    return { ts: payload.ts, id: payload.id };
  });
}

function expandTypeFilters(searchParams: URLSearchParams): { exact: string[]; prefixes: string[] } | Response {
  const exact: string[] = [];
  const prefixes: string[] = [];

  for (const raw of searchParams.getAll("type")) {
    const value = raw.trim();
    if (!value) continue;
    if (!isValidSlug(value)) return errorResponse(400, `Invalid type: ${raw}`);
    if (isPrefixWildcard(value)) prefixes.push(value.slice(0, -2));
    else exact.push(value);
  }

  for (const raw of searchParams.getAll("class")) {
    const value = raw.trim();
    if (!value) continue;
    if (!isValidSlug(value)) return errorResponse(400, `Invalid class: ${raw}`);
    // `class` is a shortcut for `type=<class>.*`.
    prefixes.push(value);
  }

  return { exact, prefixes };
}

function expandSeverityFloor(value: string | null): string[] | Response {
  if (!value) return [];
  if (!SEVERITY_SET.has(value)) {
    return errorResponse(400, `Invalid severityFloor: must be one of ${TAPE_EVENT_SEVERITY_VALUES.join(", ")}`);
  }
  const floorRank = SEVERITY_RANK[value as TapeEventSeverity];
  return TAPE_EVENT_SEVERITY_VALUES.filter((sev) => SEVERITY_RANK[sev] >= floorRank);
}

export const handleEvents = async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;

  const typeFilters = expandTypeFilters(params);
  if (typeFilters instanceof Response) return typeFilters;

  const severitiesAllowed = expandSeverityFloor(params.get("severityFloor"));
  if (severitiesAllowed instanceof Response) return severitiesAllowed;

  const since = parseIntOrNull(params.get("since"));
  if (since === "invalid") return errorResponse(400, "Invalid since: must be epoch ms");
  const until = parseIntOrNull(params.get("until"));
  if (until === "invalid") return errorResponse(400, "Invalid until: must be epoch ms");

  const pagination = parseQueryParams(params, {
    limit: {
      type: "int",
      default: DEFAULT_LIMIT,
      min: MIN_LIMIT,
      max: MAX_LIMIT,
      rangePolicy: "reject",
    },
  });
  if (pagination instanceof Response) return pagination;
  const { limit } = pagination;

  const includeTotal = parseBooleanParam(params.get("includeTotal"), "includeTotal", false);
  if (includeTotal instanceof Response) return includeTotal;

  const cursor = parseCursor(params.get("cursor"));
  if (cursor instanceof Response) return cursor;

  const coinIds: string[] = [];
  for (const rawCoin of params.getAll("coin")) {
    const coin = rawCoin.trim();
    if (!coin) continue;
    const resolved = resolveOrReject(coin);
    if (resolved instanceof Response) return resolved;
    coinIds.push(resolved.canonicalId);
  }

  const pegCurrencyRaw = params.get("pegCurrency")?.trim() ?? "";
  const pegCurrency = pegCurrencyRaw.toUpperCase();
  if (pegCurrency && !PEG_CURRENCY_SET.has(pegCurrency)) {
    return errorResponse(400, `Invalid pegCurrency: must be one of ${PEG_CURRENCY_VALUES.join(", ")}`);
  }

  const chainRaw = params.get("chain")?.trim() ?? "";
  const chain = chainRaw ? resolveChainId(chainRaw) : null;
  if (chainRaw && !chain) {
    return errorResponse(400, "Invalid chain: unknown chain");
  }
  const qRaw = params.get("q");
  const q = qRaw ? qRaw.trim().toLowerCase() : "";
  if (q.length > MAX_Q_LENGTH) {
    return errorResponse(400, `Invalid q: must be ${MAX_Q_LENGTH} characters or fewer`);
  }

  const filters: TapeEventQueryFilters = {
    typeExact: typeFilters.exact,
    typePrefixes: typeFilters.prefixes,
    coinIds,
    pegCurrency: pegCurrency || null,
    chain,
    severitiesAllowed,
    since,
    until,
    q: q.length > 0 ? q : null,
  };

  const { rows, hasMore, total } = await queryTapeEvents(db, {
    filters,
    limit,
    cursor,
    includeTotal,
  });

  const events: TapeEvent[] = rows.map(rowToTapeEvent);

  let nextCursor: string | null = null;
  if (hasMore && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    nextCursor = encodeCursor({ ts: last.ts, id: last.id });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const fallbackTs = events.length > 0 ? Math.floor(events[0]!.ts / 1000) : nowSec;
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "project-tape", fallbackTs);
  const meta = buildFreshnessMeta(freshnessTs, FRESHNESS_MAX_AGE_SEC);

  return jsonFreshResponse(
    {
      events,
      nextCursor,
      total: includeTotal ? total : null,
      totalExact: includeTotal,
      _meta: {
        updatedAt: meta.updatedAt,
        ageSeconds: meta.ageSeconds,
        status: meta.status,
      },
    },
    {
      cacheControl: CACHE_PROFILES.realtime,
      updatedAt: freshnessTs,
      maxAgeSec: FRESHNESS_MAX_AGE_SEC,
    },
  );
};
