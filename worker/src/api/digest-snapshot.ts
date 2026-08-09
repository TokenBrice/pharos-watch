import { safeJsonParse, errorResponse, jsonResponse } from "../lib/api-utils";
import type { DigestInputData } from "@shared/types/digest";
import { isRecord } from "@shared/lib/type-guards";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_INTERNAL_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "../cron/daily-digest/shared";
import { CACHE_PROFILES } from "../lib/constants";

interface DigestRow {
  generated_at: number;
  input_data: string;
}

interface DepegRow {
  stablecoin_id: string;
  symbol: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
}

interface BlacklistRow {
  stablecoin: string;
  chain_name: string;
  event_type: string;
  address: string;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_status: string;
  timestamp: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Lightweight runtime shape guard so a malformed/old-schema daily_digest row is
// dropped (→ null) instead of being asserted into the response with a bare `as`
// cast. Mirrors the isRecord/isDailyDigestLike pattern in digest-risk-summary.ts;
// checks the always-present required numeric anchor field rather than the full
// shape (the response/consumer tolerate optional fields being absent).
function isDigestInputDataLike(value: unknown): value is DigestInputData {
  return isRecord(value) && typeof value.totalMcapUsd === "number";
}

export const handleDigestSnapshot = async (
  db: D1Database,
  url: URL,
): Promise<Response> => {
  const date = url.searchParams.get("date");
  const isWeekly = date?.endsWith("-weekly") ?? false;
  const dateForParsing = date?.replace(/-weekly$/, "");
  const match = dateForParsing?.match(DATE_RE);
  if (!match) {
    return errorResponse(400, "Missing or invalid ?date=YYYY-MM-DD parameter");
  }
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3])
  ) {
    return errorResponse(400, "Missing or invalid ?date=YYYY-MM-DD parameter");
  }

  // Compute UTC day boundaries (epoch seconds)
  const dayStart = Math.floor(parsed.getTime() / 1000);
  const dayEnd = dayStart + 86_400;

  const targetFilter = isWeekly
    ? "json_extract(digest_meta, '$.type') = 'weekly'"
    : NON_WEEKLY_DIGEST_SQL_FILTER;

  const targetRow = await db
    .prepare(
      `SELECT generated_at, input_data FROM daily_digest
       WHERE generated_at >= ? AND generated_at < ? AND (${targetFilter}) AND (${NON_INTERNAL_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ORDER BY generated_at DESC LIMIT 1`,
    )
    .bind(dayStart, dayEnd)
    .first<DigestRow>();

  if (!targetRow) {
    return errorResponse(404, "No digest found for this date");
  }

  const prevRow = isWeekly
    ? null
    : await db
      .prepare(
        `SELECT generated_at, input_data FROM daily_digest
         WHERE generated_at < ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_INTERNAL_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
         ORDER BY generated_at DESC LIMIT 1`,
      )
      .bind(dayStart)
      .first<DigestRow>();

  // Weekly recaps store WeeklyInputData (with a dailyDigests[] array) instead of
  // DigestInputData.  Detect that shape and extract the last daily's inputData as
  // the end-of-week snapshot, with the first daily as prevInputData for deltas.
  const rawInputData = safeJsonParse<Record<string, unknown> | null>(
    targetRow.input_data,
    null,
    `digest-snapshot:${targetRow.generated_at}:input_data`,
  );

  let inputData: DigestInputData | null = null;
  let prevInputData: DigestInputData | null = null;

  const pickInputData = (entry: unknown): DigestInputData | null => {
    const candidate = isRecord(entry) ? entry.inputData : undefined;
    return isDigestInputDataLike(candidate) ? candidate : null;
  };

  if (rawInputData && Array.isArray(rawInputData.dailyDigests)) {
    const dailyDigests = rawInputData.dailyDigests;
    if (dailyDigests.length > 0) {
      inputData = pickInputData(dailyDigests[dailyDigests.length - 1]);
      prevInputData = dailyDigests.length > 1
        ? pickInputData(dailyDigests[0])
        : null;
    }
  } else {
    inputData = isDigestInputDataLike(rawInputData) ? rawInputData : null;
    const rawPrev = prevRow
      ? safeJsonParse<unknown>(
          prevRow.input_data,
          null,
          `digest-snapshot:${prevRow.generated_at}:prev_input_data`,
        )
      : null;
    prevInputData = isDigestInputDataLike(rawPrev) ? rawPrev : null;
  }

  // Depeg episodes active on that date
  const depegResult = await db
    .prepare(
      `SELECT stablecoin_id, symbol, direction, peak_deviation_bps, started_at, ended_at
       FROM depeg_events
       WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY ABS(peak_deviation_bps) DESC
       LIMIT 20`,
    )
    .bind(dayEnd, dayStart)
    .all<DepegRow>();

  const depegEvents = (depegResult.results ?? []).map((r) => ({
    stablecoinId: r.stablecoin_id,
    symbol: r.symbol,
    direction: r.direction,
    peakDeviationBps: r.peak_deviation_bps,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));

  // Blacklist events on that date
  const blacklistResult = await db
    .prepare(
      `SELECT stablecoin, chain_name, event_type, address, amount_native, amount_usd_at_event, amount_status, timestamp
       FROM blacklist_events
       WHERE timestamp >= ? AND timestamp < ?
         AND suppression_reason IS NULL
       ORDER BY timestamp DESC
       LIMIT 50`,
    )
    .bind(dayStart, dayEnd)
    .all<BlacklistRow>();

  const blacklistEvents = (blacklistResult.results ?? []).map((r) => ({
    stablecoin: r.stablecoin,
    chainName: r.chain_name,
    eventType: r.event_type,
    address: r.address,
    amountNative: r.amount_native,
    amountUsdAtEvent: r.amount_usd_at_event,
    amountStatus: r.amount_status,
    timestamp: r.timestamp,
  }));

  return jsonResponse({
    date,
    inputData,
    prevInputData,
    depegEvents,
    blacklistEvents,
  }, { "Cache-Control": CACHE_PROFILES.archive });
};
