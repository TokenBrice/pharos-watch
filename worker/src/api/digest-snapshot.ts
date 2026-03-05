import { withErrorHandler, safeParse, errorResponse, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import type { DigestInputData } from "../../../src/lib/types";

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
  amount: number | null;
  timestamp: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const handleDigestSnapshot = withErrorHandler("digest-snapshot", async (
  db: D1Database,
  url: URL,
): Promise<Response> => {
  const date = url.searchParams.get("date");
  if (!date || !DATE_RE.test(date)) {
    return errorResponse(400, "Missing or invalid ?date=YYYY-MM-DD parameter");
  }

  // Compute UTC day boundaries (epoch seconds)
  const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const dayEnd = dayStart + 86_400;

  // Find the digest row for this date + the previous one for deltas.
  // Rows where generated_at < dayEnd, ordered DESC — the first with generated_at >= dayStart
  // is the target; the next is the previous digest.
  const digestResult = await db
    .prepare(
      `SELECT generated_at, input_data FROM daily_digest
       WHERE generated_at < ? ORDER BY generated_at DESC LIMIT 2`,
    )
    .bind(dayEnd)
    .all<DigestRow>();

  const digestRows = digestResult.results ?? [];

  // Identify target (generated on that date) and previous
  let targetRow: DigestRow | null = null;
  let prevRow: DigestRow | null = null;

  if (digestRows.length > 0 && digestRows[0].generated_at >= dayStart) {
    targetRow = digestRows[0];
    prevRow = digestRows.length > 1 ? digestRows[1] : null;
  }

  if (!targetRow) {
    return errorResponse(404, "No digest found for this date");
  }

  const inputData = safeParse<DigestInputData | null>(targetRow.input_data, null);
  const prevInputData = prevRow
    ? safeParse<DigestInputData | null>(prevRow.input_data, null)
    : null;

  // Depeg episodes active on that date
  const depegResult = await db
    .prepare(
      `SELECT stablecoin_id, symbol, direction, peak_deviation_bps, started_at, ended_at
       FROM depeg_events
       WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY peak_deviation_bps DESC
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
      `SELECT stablecoin, chain_name, event_type, address, amount, timestamp
       FROM blacklist_events
       WHERE timestamp >= ? AND timestamp < ?
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
    amount: r.amount,
    timestamp: r.timestamp,
  }));

  return jsonResponse({
    date,
    inputData,
    prevInputData,
    depegEvents,
    blacklistEvents,
  }, { "Cache-Control": CACHE_PROFILES.slow });
});
