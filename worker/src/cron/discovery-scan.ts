import { CIRCUIT_SOURCE, USER_AGENT } from "../lib/constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchWithRetry } from "../lib/fetch-retry";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DISCOVERY_MIN_MCAP } from "@shared/lib/status-thresholds";
import type { CronResult } from "../lib/cron-logger";
const DISMISSED_CLEANUP_DAYS = 90;

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

export async function upsertDiscoveryCandidates(
  db: D1Database,
  candidates: { geckoId?: string; llamaId?: number; name: string; symbol: string; marketCap: number; source: string }[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  let upserted = 0;

  for (const c of candidates) {
    try {
      if (c.geckoId) {
        await db.prepare(`
          INSERT INTO discovery_candidates (gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (gecko_id) DO UPDATE SET
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
            END
        `).bind(
          c.geckoId, c.llamaId ?? null, c.name, c.symbol, c.marketCap, c.source, nowSec, nowSec,
        ).run();
      } else if (c.llamaId) {
        await db.prepare(`
          INSERT INTO discovery_candidates (gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen)
          VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (llama_id) DO UPDATE SET
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
            END
        `).bind(
          c.llamaId, c.name, c.symbol, c.marketCap, c.source, nowSec, nowSec,
        ).run();
      }
      upserted++;
    } catch (err) {
      console.warn(`[discovery] Upsert failed for ${c.symbol}:`, err);
    }
  }
  return upserted;
}

async function cleanupOldDismissed(db: D1Database): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - DISMISSED_CLEANUP_DAYS * 86400;
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
  if (new Date().getUTCDay() !== 1) {
    return { itemCount: 0, metadata: JSON.stringify({ reason: "skipped_not_monday" }) };
  }

  const trackedGeckoIds = new Set(
    ACTIVE_STABLECOINS.map((s) => s.geckoId).filter(Boolean) as string[],
  );

  let cgCandidates: { geckoId: string; name: string; symbol: string; marketCap: number }[] = [];
  let cgFetched = false;

  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_DISCOVERY);
  if (cgAllowed) {
    try {
      const res = await fetchWithRetry(
        cgUrl("/coins/markets?category=stablecoins&vs_currency=usd&per_page=250&order=market_cap_desc", coingeckoApiKey ?? null),
        {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
          signal,
        },
      );
      if (res?.ok) {
        const coins = (await res.json()) as CgMarketCoin[];
        cgCandidates = filterDiscoveryCandidates(coins, trackedGeckoIds, DISCOVERY_MIN_MCAP);
        cgFetched = true;
        await recordOutcome(db, CIRCUIT_SOURCE.CG_DISCOVERY, true);
      } else {
        console.warn(`[discovery] CG category fetch returned ${res?.status ?? "no response"}`);
        await recordOutcome(db, CIRCUIT_SOURCE.CG_DISCOVERY, false);
      }
    } catch (err) {
      console.warn("[discovery] CG category fetch failed:", err);
      await recordOutcome(db, CIRCUIT_SOURCE.CG_DISCOVERY, false);
    }
  }

  const upsertItems = cgCandidates.map((c) => ({
    ...c,
    source: "coingecko",
  }));

  const upserted = await upsertDiscoveryCandidates(db, upsertItems);
  const cleaned = await cleanupOldDismissed(db);

  console.log(
    `[discovery] CG: ${cgFetched ? cgCandidates.length : "skipped"} candidates, ` +
    `upserted: ${upserted}, cleaned: ${cleaned}`,
  );

  return {
    itemCount: upserted,
    status: cgFetched || !cgAllowed ? "ok" : "degraded",
    metadata: JSON.stringify({ cgCandidates: cgCandidates.length, upserted, cleaned, cgFetched }),
  };
}
