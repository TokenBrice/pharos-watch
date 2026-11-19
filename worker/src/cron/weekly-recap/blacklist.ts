import { formatIsoDate } from "@shared/lib/format";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { DigestEventPeriodSchema, type DigestEventPeriod, type DigestInputData } from "@shared/types/digest";
import { z } from "zod";
import { BLACKLIST_DERIVED_GENERATION_KEY, BLACKLIST_EVENT_COVERAGE_KEY } from "../../lib/blacklist-cache-keys";
import { BLACKLIST_PUBLIC_EVENT_SQL } from "../../lib/blacklist/shared";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { throwIfAborted } from "../../lib/abort";
import { tryParseJson } from "../../lib/json-parse";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";

export const WEEKLY_BLACKLIST_QUERY_UNAVAILABLE = "weekly-blacklist-activity-query";
export { BLACKLIST_EVENT_COVERAGE_KEY };
export const WEEKLY_BLACKLIST_UNPRICED = "weekly-blacklist-unpriced-events";

// The producer certifies the common contiguous interval across the entire active roster.
const BlacklistCoverageReceiptSchema = z.object({
  version: z.literal(1),
  generation: z.string().trim().min(1).max(128),
  invalidationGeneration: z.string().nullable().optional(),
  rosterFingerprint: z.string(),
  eventPeriod: DigestEventPeriodSchema,
});

type BlacklistCoverageReceipt = z.output<typeof BlacklistCoverageReceiptSchema>;
type BlacklistCoverageRead =
  | { receipt: BlacklistCoverageReceipt; reason: null }
  | { receipt: null; reason: "weekly-blacklist-coverage-missing" | "weekly-blacklist-coverage-invalid" | "weekly-blacklist-coverage-query" };

type WeeklyBlacklistCoverage = BlacklistCoverageRead |
  { receipt: BlacklistCoverageReceipt; reason: "weekly-blacklist-period-not-covered" };

export function getBlacklistCoverageRosterFingerprint(): string {
  const roster = includeActiveTrackedIds(CONTRACT_CONFIGS, (config) => config.stablecoinId)
    .map(({ chain, ...config }) => ({ ...config, chainId: chain.chainId, chainType: chain.type, evmChainId: chain.evmChainId ?? null }))
    .sort((a, b) => a.configKey.localeCompare(b.configKey, "en"));
  return sha256Hex(stableJsonStringifyV1({ domain: BLACKLIST_EVENT_COVERAGE_KEY, roster }));
}

function decodeBlacklistEventCoverage(cached: { value: string; updated_at: number; generation: string | null } | undefined): BlacklistCoverageRead {
  if (!cached) return { receipt: null, reason: "weekly-blacklist-coverage-missing" };
  const { data: receipt } = BlacklistCoverageReceiptSchema.safeParse(tryParseJson(cached.value));
  if (!receipt || !Number.isSafeInteger(cached.updated_at) || cached.updated_at > Math.floor(Date.now() / 1_000) ||
    receipt.eventPeriod.end > cached.updated_at ||
    (receipt.invalidationGeneration ?? null) !== (cached.generation ?? null) ||
    receipt.rosterFingerprint !== getBlacklistCoverageRosterFingerprint()) {
    return { receipt: null, reason: "weekly-blacklist-coverage-invalid" };
  }
  return { receipt, reason: null };
}

export type WeeklyBlacklistActivity = Omit<NonNullable<DigestInputData["blacklistActivity"]>, "topEvents"> & {
  coverage: WeeklyBlacklistCoverage;
  unpricedEventCount: number;
  topEvents: (NonNullable<DigestInputData["blacklistActivity"]>["topEvents"][number] & { date: string })[];
};

export type WeeklyBlacklistObservation = Pick<WeeklyBlacklistActivity, "eventCount" | "unpricedEventCount" | "coverage"> & {
  knownAmountUsd: number | null;
};

export function summarizeWeeklyBlacklistActivity(activity: WeeklyBlacklistActivity | null | undefined): WeeklyBlacklistObservation | null {
  if (!activity) return null;
  const { eventCount, unpricedEventCount, coverage, totalAmountUsd } = activity;
  return {
    eventCount,
    unpricedEventCount,
    coverage,
    knownAmountUsd: eventCount > 0 && unpricedEventCount === eventCount ? null : totalAmountUsd,
  };
}

interface BlacklistActivityRow {
  symbol: string;
  chain_name: string;
  event_type: "blacklist" | "destroy";
  amount_usd_at_event: number | null;
  timestamp: number;
  event_count: number;
  known_usd: number;
  unpriced_count: number;
}

function prepareBlacklistActivity(db: D1Database, period: DigestEventPeriod) {
  return db.prepare(
      `SELECT stablecoin AS symbol, chain_name, event_type, amount_usd_at_event, timestamp,
              COUNT(*) OVER () AS event_count,
              TOTAL(amount_usd_at_event) OVER () AS known_usd,
              COUNT(*) OVER () - COUNT(amount_usd_at_event) OVER () AS unpriced_count
       FROM blacklist_events
       WHERE timestamp >= ? AND timestamp < ? AND ${BLACKLIST_PUBLIC_EVENT_SQL}
         AND event_type IN ('blacklist', 'destroy')
       ORDER BY amount_usd_at_event DESC, timestamp DESC, id DESC
       LIMIT 7`,
  ).bind(period.start, period.end);
}

function decodeBlacklistActivity(
  result: D1Result<BlacklistActivityRow>,
  period: DigestEventPeriod,
  evidence: BlacklistCoverageRead,
): WeeklyBlacklistActivity | null {
  const { receipt } = evidence;
  const coverage = receipt && (receipt.eventPeriod.start > period.start || receipt.eventPeriod.end < period.end)
    ? { receipt, reason: "weekly-blacklist-period-not-covered" as const }
    : evidence;
  if (!result.success || !Array.isArray(result.results)) return null;
  const rows = result.results;
  const first = rows[0];
  return {
    coverage,
    eventCount: first?.event_count ?? 0,
    totalAmountUsd: first?.known_usd ?? 0,
    unpricedEventCount: first?.unpriced_count ?? 0,
    editorialEligible: first != null && (
      first.event_count >= 2 || first.unpriced_count > 0 || (first.amount_usd_at_event ?? 0) > 10_000_000
    ),
    topEvents: rows.map((row) => ({
      symbol: row.symbol,
      chain: row.chain_name,
      type: row.event_type,
      amountUsd: row.amount_usd_at_event,
      date: formatIsoDate(row.timestamp),
    })),
  };
}

async function collectBlacklistActivitySnapshot(
  db: D1Database,
  periods: readonly DigestEventPeriod[],
  signal?: AbortSignal,
): Promise<(WeeklyBlacklistActivity | null)[]> {
  throwIfAborted(signal);
  try {
    // D1 batches share a transaction, so a repair cannot split the receipt from the ledger.
    const [proof, ...ledger] = await db.batch([
      db.prepare(`SELECT /* pharos:weekly-blacklist-coverage */ value, updated_at, (SELECT value FROM cache WHERE key = ?) AS generation
        FROM cache WHERE key = ?`).bind(BLACKLIST_DERIVED_GENERATION_KEY, BLACKLIST_EVENT_COVERAGE_KEY),
      ...periods.map((period) => prepareBlacklistActivity(db, period)),
    ]);
    throwIfAborted(signal);
    const coverage = proof.success
      ? decodeBlacklistEventCoverage(proof.results[0] as { value: string; updated_at: number; generation: string | null } | undefined)
      : { receipt: null, reason: "weekly-blacklist-coverage-query" } as const;
    return periods.map((period, i) => decodeBlacklistActivity(ledger[i] as D1Result<BlacklistActivityRow>, period, coverage));
  } catch (error) {
    throwIfAborted(signal);
    logWorkerEventArgs("handler", "error", "[weekly-recap] Failed to query blacklist events:", error);
    return periods.map(() => null);
  }
}

export async function collectWeeklyBlacklistActivity(db: D1Database, period: DigestEventPeriod) {
  const [activity] = await collectBlacklistActivitySnapshot(db, [period]);
  return activity;
}

export async function collectWeeklyBlacklistPeriods(
  db: D1Database,
  periods: { current: DigestEventPeriod; prior: DigestEventPeriod },
  signal?: AbortSignal,
) {
  const [current, prior] = await collectBlacklistActivitySnapshot(db, [periods.current, periods.prior], signal);
  return { current, prior };
}
