import { CIRCUIT_SOURCE, D1_BATCH_SIZE, USER_AGENT } from "../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchJsonWithRetry } from "../lib/fetch-retry";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DISCOVERY_MIN_MCAP } from "@shared/lib/status-thresholds";
import type { CronResult } from "../lib/cron-logger";
import { createNeutralSkippedCronResult } from "../lib/cron-result";
import { isRecord } from "@shared/lib/type-guards";
import { logWorkerEvent } from "../lib/structured-log";
const DISMISSED_CLEANUP_DAYS = 90;
const DISCOVERY_ID_MAX_LENGTH = 200;
const DISCOVERY_NAME_MAX_LENGTH = 200;
const DISCOVERY_SYMBOL_MAX_LENGTH = 50;
const DISCOVERY_SOURCE_MAX_LENGTH = 32;

export interface DiscoveryCandidateRow {
  id: number;
  gecko_id: string | null;
  llama_id: number | null;
  name: string;
  symbol: string;
  market_cap: number | null;
  source: string;
  first_seen: number;
  last_seen: number;
  dismissed: number;
  dismissed_at: number | null;
  dismissed_mcap: number | null;
}

interface CgMarketCoin {
  id: string;
  name: string;
  symbol: string;
  market_cap: number | null;
}

export interface DiscoveryCandidateInput {
  geckoId?: string;
  llamaId?: number;
  name: string;
  symbol: string;
  marketCap: number;
  source: string;
}

interface DiscoveryUpsertResult {
  changes: number;
  attempted: number;
  persisted: number;
  failed: number;
  invalid: number;
}

function boundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function parseCgMarketCoins(value: unknown): { coins: CgMarketCoin[]; invalid: number } | null {
  if (!Array.isArray(value)) return null;
  const coins: CgMarketCoin[] = [];
  let invalid = 0;
  for (const row of value) {
    if (
      !isRecord(row)
      || !boundedNonEmptyString(row.id, DISCOVERY_ID_MAX_LENGTH)
      || !boundedNonEmptyString(row.name, DISCOVERY_NAME_MAX_LENGTH)
      || !boundedNonEmptyString(row.symbol, DISCOVERY_SYMBOL_MAX_LENGTH)
      || (row.market_cap !== null && (
        typeof row.market_cap !== "number"
        || !Number.isFinite(row.market_cap)
        || row.market_cap < 0
      ))
    ) {
      invalid += 1;
      continue;
    }
    coins.push({
      id: row.id.trim(),
      name: row.name.trim(),
      symbol: row.symbol.trim(),
      market_cap: row.market_cap,
    });
  }
  return { coins, invalid };
}

function isValidDiscoveryCandidate(candidate: DiscoveryCandidateInput): boolean {
  const hasGeckoId = candidate.geckoId == null
    || boundedNonEmptyString(candidate.geckoId, DISCOVERY_ID_MAX_LENGTH);
  const hasLlamaId = candidate.llamaId == null
    || (Number.isSafeInteger(candidate.llamaId) && candidate.llamaId > 0);
  return (
    hasGeckoId
    && hasLlamaId
    && (candidate.geckoId != null || candidate.llamaId != null)
    && boundedNonEmptyString(candidate.name, DISCOVERY_NAME_MAX_LENGTH)
    && boundedNonEmptyString(candidate.symbol, DISCOVERY_SYMBOL_MAX_LENGTH)
    && Number.isFinite(candidate.marketCap)
    && candidate.marketCap >= 0
    && boundedNonEmptyString(candidate.source, DISCOVERY_SOURCE_MAX_LENGTH)
  );
}

export function filterDiscoveryCandidates(
  coins: CgMarketCoin[],
  trackedGeckoIds: Set<string>,
  minMcap: number,
): { geckoId: string; name: string; symbol: string; marketCap: number }[] {
  return coins
    .filter((c) =>
      c.id &&
      !trackedGeckoIds.has(c.id) &&
      c.market_cap != null &&
      c.market_cap >= minMcap,
    )
    .map((c) => ({
      geckoId: c.id,
      name: c.name,
      symbol: c.symbol.toUpperCase(),
      marketCap: c.market_cap!,
    }));
}

const DISCOVERY_UPSERT_CONFLICT_CLAUSE = `
  last_seen = excluded.last_seen,
  market_cap = excluded.market_cap,
  name = excluded.name,
  source = CASE
    WHEN discovery_candidates.source != excluded.source AND discovery_candidates.source != 'both'
    THEN 'both'
    ELSE COALESCE(excluded.source, discovery_candidates.source)
  END,
  dismissed = CASE
    WHEN discovery_candidates.dismissed = 1
      AND excluded.market_cap > discovery_candidates.dismissed_mcap * 10
    THEN 0
    ELSE discovery_candidates.dismissed
  END,
  dismissed_at = CASE
    WHEN discovery_candidates.dismissed = 1
      AND excluded.market_cap > discovery_candidates.dismissed_mcap * 10
    THEN NULL
    ELSE discovery_candidates.dismissed_at
  END`;

async function upsertDiscoveryCandidatesDetailed(
  db: D1Database,
  candidates: DiscoveryCandidateInput[],
): Promise<DiscoveryUpsertResult> {
  if (candidates.length === 0) {
    return { changes: 0, attempted: 0, persisted: 0, failed: 0, invalid: 0 };
  }
  const nowSec = Math.floor(Date.now() / 1000);

  const stmts: Array<{ statement: D1PreparedStatement; candidateKey: string }> = [];
  let invalid = 0;
  for (const c of candidates) {
    if (!isValidDiscoveryCandidate(c)) {
      invalid += 1;
      console.warn("[discovery] Skipping invalid discovery candidate before upsert", {
        geckoId: c.geckoId ?? null,
        llamaId: c.llamaId ?? null,
      });
      continue;
    }
    if (c.geckoId) {
      stmts.push(
        {
          candidateKey: `coingecko:${c.geckoId}`,
          statement: db.prepare(`
          INSERT INTO discovery_candidates (gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (gecko_id) DO UPDATE SET${DISCOVERY_UPSERT_CONFLICT_CLAUSE}
        `).bind(
            c.geckoId, c.llamaId ?? null, c.name, c.symbol, c.marketCap, c.source, nowSec, nowSec,
          ),
        },
      );
    } else if (c.llamaId) {
      stmts.push(
        {
          candidateKey: `defillama:${c.llamaId}`,
          statement: db.prepare(`
          INSERT INTO discovery_candidates (gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen)
          VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (llama_id) DO UPDATE SET${DISCOVERY_UPSERT_CONFLICT_CLAUSE}
        `).bind(
            c.llamaId, c.name, c.symbol, c.marketCap, c.source, nowSec, nowSec,
          ),
        },
      );
    }
  }

  let changes = 0;
  let persisted = 0;
  let failed = 0;
  for (let i = 0; i < stmts.length; i += D1_BATCH_SIZE) {
    const chunk = stmts.slice(i, i + D1_BATCH_SIZE);
    try {
      const result = await db.batch(chunk.map((entry) => entry.statement));
      for (const row of result) {
        changes += Number(row?.meta?.changes ?? 0);
      }
      persisted += chunk.length;
    } catch (err) {
      console.warn("[discovery] Upsert batch failed; retrying candidates individually:", err);
      for (const entry of chunk) {
        try {
          const result = await entry.statement.run();
          changes += Number(result?.meta?.changes ?? 0);
          persisted += 1;
        } catch (candidateErr) {
          failed += 1;
          console.warn("[discovery] Skipping discovery candidate after upsert failure:", candidateErr);
          logWorkerEvent({
            scope: "lib",
            level: "error",
            event: "discovery_candidate_persistence_failed",
            job: "discovery-scan",
            source: "discovery_candidates",
            message: "Discovery candidate could not be persisted after batch fallback",
            error: candidateErr,
            metadata: { candidateKey: entry.candidateKey },
          });
        }
      }
    }
  }
  return { changes, attempted: stmts.length, persisted, failed, invalid };
}

export async function upsertDiscoveryCandidates(
  db: D1Database,
  candidates: DiscoveryCandidateInput[],
): Promise<number> {
  return (await upsertDiscoveryCandidatesDetailed(db, candidates)).changes;
}

async function cleanupOldDismissed(db: D1Database): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - DISMISSED_CLEANUP_DAYS * DAY_SECONDS;
  const result = await db.prepare(
    "DELETE FROM discovery_candidates WHERE dismissed = 1 AND dismissed_at < ?",
  ).bind(cutoff).run();
  return result.meta.changes ?? 0;
}

export async function runDiscoveryScan(
  db: D1Database,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<CronResult> {
  const utcDay = new Date().getUTCDay();
  if (utcDay !== 1) {
    return createNeutralSkippedCronResult("not-monday", {
      skipped: "not-monday",
      utcDay,
    });
  }

  const trackedGeckoIds = new Set(
    ACTIVE_STABLECOINS.map((s) => s.geckoId).filter(Boolean) as string[],
  );

  let cgCandidates: { geckoId: string; name: string; symbol: string; marketCap: number }[] = [];
  let cgFetched = false;
  let cgInvalidRows = 0;
  let fetchFailureReason: "fetch-failed" | "invalid-payload" | null = null;

  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_DISCOVERY);
  if (cgAllowed) {
    try {
      const result = await fetchJsonWithRetry<unknown>(
        cgUrl("/coins/markets?category=stablecoins&vs_currency=usd&per_page=250&order=market_cap_desc", coingeckoApiKey ?? null),
        {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
          signal,
        },
      );
      if (result?.response.ok) {
        const parsed = parseCgMarketCoins(result.body);
        if (parsed) {
          cgCandidates = filterDiscoveryCandidates(parsed.coins, trackedGeckoIds, DISCOVERY_MIN_MCAP);
          cgInvalidRows = parsed.invalid;
          cgFetched = true;
          await recordOutcome(db, CIRCUIT_SOURCE.CG_DISCOVERY, true);
        } else {
          fetchFailureReason = "invalid-payload";
          console.warn("[discovery] CG category fetch returned a non-array payload");
          await recordOutcome(db, CIRCUIT_SOURCE.CG_DISCOVERY, false);
        }
      } else {
        fetchFailureReason = "fetch-failed";
        console.warn(`[discovery] CG category fetch returned ${result?.response.status ?? "no response"}`);
        await recordOutcome(db, CIRCUIT_SOURCE.CG_DISCOVERY, false);
      }
    } catch (err) {
      fetchFailureReason ??= "fetch-failed";
      console.warn("[discovery] CG category fetch failed:", err);
      await recordOutcome(db, CIRCUIT_SOURCE.CG_DISCOVERY, false);
    }
  }

  const upsertItems = cgCandidates.map((c) => ({
    ...c,
    source: "coingecko",
  }));

  const persistence = await upsertDiscoveryCandidatesDetailed(db, upsertItems);
  const upserted = persistence.changes;
  const cleaned = await cleanupOldDismissed(db);

  const circuitOpenNoAttempt = !cgAllowed && !cgFetched;
  const persistenceDegraded = persistence.failed > 0 || persistence.invalid > 0;
  const sourceDegraded = cgInvalidRows > 0;
  const reason = circuitOpenNoAttempt
    ? "circuit-open-no-attempt"
    : !cgFetched
      ? fetchFailureReason ?? "fetch-failed"
      : persistenceDegraded
        ? "partial-persistence"
        : sourceDegraded
          ? "malformed-source-rows"
          : null;
  if (sourceDegraded) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "discovery_source_rows_rejected",
      job: "discovery-scan",
      provider: "coingecko",
      source: "coins-markets",
      message: "Malformed discovery source rows were rejected before persistence",
      metadata: { rejectedRows: cgInvalidRows },
    });
  }
  return {
    itemCount: upserted,
    ...(!cgFetched || persistenceDegraded || sourceDegraded ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      reason,
      cgCandidates: cgCandidates.length,
      cgInvalidRows,
      upserted,
      persistenceAttempted: persistence.attempted,
      persistencePersisted: persistence.persisted,
      persistenceFailed: persistence.failed,
      persistenceInvalid: persistence.invalid,
      cleaned,
      cgFetched,
      cgAllowed,
    }),
  };
}
