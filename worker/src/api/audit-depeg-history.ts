import { withErrorHandler } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { getDepegThresholdBps, DEPEG_SECONDARY_THRESHOLD_RATIO, USER_AGENT } from "../lib/constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { computeStabilityIndex } from "../lib/stability-index";
import { batchExecute } from "../lib/db";
import type { DepegRow } from "../lib/depeg-helpers";

const DAY = 86400;

type Verdict = "false_positive" | "confirmed" | "no_data" | "skipped" | "error";

interface AuditedEvent {
  id: number;
  symbol: string;
  startedAt: number;
  peakBps: number;
  cgMaxBps: number | null;
  verdict: Verdict;
}

interface AuditResult {
  totalMatching: number;
  offset: number;
  limit: number;
  dryRun: boolean;
  auditedEvents: AuditedEvent[];
  falsePositivesFound: number;
  deletedEvents: { id: number; symbol: string; startedAt: number; peakBps: number }[];
  daysRecomputed: number;
}

export const handleAuditDepegHistory = withErrorHandler(
  "audit-depeg-history",
  async (db: D1Database, url: URL, adminKey?: string, request?: Request): Promise<Response> => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;

    // Pagination: ?limit=N&offset=M — Analyst plan (500 req/min) supports large batches
    const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    // Direct delete: ?delete=ID1,ID2 skips CG checks and deletes specified events
    const deleteIds = url.searchParams.get("delete");
    // Dry run: preview deletions without touching the DB
    const dryRun = url.searchParams.get("dry-run") === "true";
    // Optional supply filter: ?min-supply=N (default 0 = audit everything with a geckoId)
    const minSupply = parseInt(url.searchParams.get("min-supply") ?? "0", 10);
    // Optional symbol filter: ?symbol=USDC (case-insensitive)
    const symbolFilter = url.searchParams.get("symbol")?.toUpperCase() ?? null;

    const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

    // 1. Query all closed depeg events
    const allEvents = await db
      .prepare(
        "SELECT * FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at"
      )
      .all<DepegRow>();
    const events = allEvents.results ?? [];

    // Fast path: direct delete of specific event IDs (pre-verified externally)
    if (deleteIds) {
      const ids = deleteIds.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      const toDelete = events.filter((e) => ids.includes(e.id));
      if (toDelete.length === 0) {
        return new Response(JSON.stringify({ error: "No matching events found", requestedIds: ids }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }

      if (dryRun) {
        return new Response(JSON.stringify({
          dryRun: true,
          deletedEvents: toDelete.map((e) => ({ id: e.id, symbol: e.symbol, startedAt: e.started_at, peakBps: e.peak_deviation_bps })),
          daysRecomputed: 0,
        }, null, 2), { headers: { "Content-Type": "application/json" } });
      }

      const affectedDays = new Set<number>();
      for (const event of toDelete) {
        await db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(event.id).run();
        const startDay = Math.floor(event.started_at / DAY) * DAY;
        const endDay = Math.floor((event.ended_at ?? event.started_at) / DAY) * DAY;
        for (let d = startDay; d <= endDay; d += DAY) {
          affectedDays.add(d);
        }
        console.log(`[audit] Direct delete: ${event.symbol} id=${event.id} peak=${event.peak_deviation_bps}bps`);
      }

      const daysRecomputed = await recomputeStabilityDays(db, affectedDays);

      return new Response(JSON.stringify({
        dryRun: false,
        deletedEvents: toDelete.map((e) => ({ id: e.id, symbol: e.symbol, startedAt: e.started_at, peakBps: e.peak_deviation_bps })),
        daysRecomputed,
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // Build supply lookup only when min-supply > 0
    let getSupplyAtTime: ((coinId: string, ts: number) => number) | null = null;
    if (minSupply > 0) {
      const supplyRows = await db
        .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
        .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
      const supplyByCoin = new Map<string, { date: number; supply: number }[]>();
      for (const r of supplyRows.results ?? []) {
        const list = supplyByCoin.get(r.stablecoin_id) ?? [];
        list.push({ date: r.snapshot_date, supply: r.circulating_usd });
        supplyByCoin.set(r.stablecoin_id, list);
      }

      getSupplyAtTime = (coinId: string, ts: number): number => {
        const snaps = supplyByCoin.get(coinId);
        if (!snaps || snaps.length === 0) return 0;
        let best = snaps[0];
        for (const s of snaps) {
          if (Math.abs(s.date - ts) < Math.abs(best.date - ts)) best = s;
          if (s.date > ts) break;
        }
        return Math.abs(best.date - ts) <= 30 * DAY ? best.supply : 0;
      };
    }

    // Apply filters: symbol, min-supply, geckoId presence
    const filtered = events.filter((e) => {
      if (symbolFilter && e.symbol.toUpperCase() !== symbolFilter) return false;
      if (minSupply > 0 && getSupplyAtTime) {
        if (getSupplyAtTime(e.stablecoin_id, e.started_at) < minSupply) return false;
      }
      return true;
    });

    const paginatedEvents = filtered.slice(offset, offset + limit);

    const result: AuditResult = {
      totalMatching: filtered.length,
      offset,
      limit,
      dryRun,
      auditedEvents: [],
      falsePositivesFound: 0,
      deletedEvents: [],
      daysRecomputed: 0,
    };

    const affectedDays = new Set<number>();

    for (const event of paginatedEvents) {
      const meta = metaById.get(event.stablecoin_id);
      const geckoId = meta?.geckoId;

      if (!geckoId) {
        result.auditedEvents.push({
          id: event.id,
          symbol: event.symbol,
          startedAt: event.started_at,
          peakBps: event.peak_deviation_bps,
          cgMaxBps: null,
          verdict: "skipped",
        });
        continue;
      }

      const threshold = getDepegThresholdBps(event.peg_type);
      const falsePositiveBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);

      // Fetch CoinGecko historical data for the event window
      // precision=full gives maximum decimal places — critical for stablecoin prices near $1.000
      const from = event.started_at - 3600;
      const to = (event.ended_at ?? event.started_at) + 3600;

      try {
        // Analyst plan: 500 req/min. 200ms delay ≈ 300 req/min with headroom.
        await new Promise((r) => setTimeout(r, 200));

        const cgEndpoint = cgUrl(`/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}&precision=full`);
        const cgFetchHeaders = cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT });
        let cgRes = await fetch(cgEndpoint, { headers: cgFetchHeaders });

        // Retry once on 429 with backoff
        if (cgRes.status === 429) {
          const retryAfter = parseInt(cgRes.headers.get("Retry-After") ?? "10", 10);
          console.warn(`[audit] CG 429 for ${event.symbol}, waiting ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          cgRes = await fetch(cgEndpoint, { headers: cgFetchHeaders });
        }

        if (!cgRes.ok) {
          console.warn(`[audit] CG fetch failed for ${event.symbol} (${geckoId}): ${cgRes.status}`);
          result.auditedEvents.push({
            id: event.id,
            symbol: event.symbol,
            startedAt: event.started_at,
            peakBps: event.peak_deviation_bps,
            cgMaxBps: null,
            verdict: "error",
          });
          continue;
        }

        const cgData = (await cgRes.json()) as { prices?: [number, number][] };
        const prices = cgData.prices ?? [];

        if (prices.length === 0) {
          result.auditedEvents.push({
            id: event.id,
            symbol: event.symbol,
            startedAt: event.started_at,
            peakBps: event.peak_deviation_bps,
            cgMaxBps: null,
            verdict: "no_data",
          });
          continue;
        }

        // Find max deviation in CG data during the event window
        let maxCgBps = 0;
        for (const [, cgPrice] of prices) {
          if (cgPrice <= 0) continue;
          const cgBps = Math.abs(Math.round(((cgPrice / event.peg_reference) - 1) * 10000));
          if (cgBps > maxCgBps) maxCgBps = cgBps;
        }

        if (maxCgBps < falsePositiveBar) {
          // CoinGecko never confirmed this deviation — false positive
          result.falsePositivesFound++;
          result.auditedEvents.push({
            id: event.id,
            symbol: event.symbol,
            startedAt: event.started_at,
            peakBps: event.peak_deviation_bps,
            cgMaxBps: maxCgBps,
            verdict: "false_positive",
          });

          if (!dryRun) {
            await db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(event.id).run();
            result.deletedEvents.push({
              id: event.id,
              symbol: event.symbol,
              startedAt: event.started_at,
              peakBps: event.peak_deviation_bps,
            });

            // Track affected days for stability index recomputation
            const startDay = Math.floor(event.started_at / DAY) * DAY;
            const endDay = Math.floor((event.ended_at ?? event.started_at) / DAY) * DAY;
            for (let d = startDay; d <= endDay; d += DAY) {
              affectedDays.add(d);
            }

            console.log(
              `[audit] Deleted false positive: ${event.symbol} id=${event.id} peak=${event.peak_deviation_bps}bps, CG max=${maxCgBps}bps`
            );
          }
        } else {
          // CoinGecko confirms the deviation — keep the event
          result.auditedEvents.push({
            id: event.id,
            symbol: event.symbol,
            startedAt: event.started_at,
            peakBps: event.peak_deviation_bps,
            cgMaxBps: maxCgBps,
            verdict: "confirmed",
          });
        }
      } catch (err) {
        console.warn(`[audit] Error auditing ${event.symbol}:`, err);
        result.auditedEvents.push({
          id: event.id,
          symbol: event.symbol,
          startedAt: event.started_at,
          peakBps: event.peak_deviation_bps,
          cgMaxBps: null,
          verdict: "error",
        });
      }
    }

    // Recompute stability index for affected days
    if (affectedDays.size > 0) {
      result.daysRecomputed = await recomputeStabilityDays(db, affectedDays);
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }
);

/** Recompute stability index for a set of affected days after event deletions */
async function recomputeStabilityDays(db: D1Database, affectedDays: Set<number>): Promise<number> {
  const sortedDays = [...affectedDays].sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);

  const remainingDepegs = await db
    .prepare("SELECT stablecoin_id, peak_deviation_bps, started_at, ended_at FROM depeg_events ORDER BY started_at")
    .all<{ stablecoin_id: string; peak_deviation_bps: number; started_at: number; ended_at: number | null }>();
  const depegEvents = remainingDepegs.results ?? [];

  const allSupply = await db
    .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
    .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
  const supplyByCoin = new Map<string, { date: number; mcap: number }[]>();
  for (const r of allSupply.results ?? []) {
    const list = supplyByCoin.get(r.stablecoin_id) ?? [];
    list.push({ date: r.snapshot_date, mcap: r.circulating_usd });
    supplyByCoin.set(r.stablecoin_id, list);
  }

  function getMcapForDay(coinId: string, day: number): number {
    const snapshots = supplyByCoin.get(coinId);
    if (!snapshots || snapshots.length === 0) return 0;
    let best = snapshots[0];
    for (const s of snapshots) {
      if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
      if (s.date > day) break;
    }
    return Math.abs(best.date - day) <= 14 * DAY ? best.mcap : 0;
  }

  const stmts: D1PreparedStatement[] = [];

  for (const day of sortedDays) {
    stmts.push(db.prepare("DELETE FROM stability_index WHERE computed_at = ?").bind(day));

    const activeDepegs = depegEvents.filter(
      (e) => e.started_at <= day && (e.ended_at === null ? day <= now : e.ended_at > day)
    );
    const depegs = activeDepegs.map((e) => ({
      bps: e.peak_deviation_bps,
      mcapUsd: getMcapForDay(e.stablecoin_id, day),
    }));

    let totalMcapUsd = 0;
    for (const [, snapshots] of supplyByCoin) {
      let best = snapshots[0];
      for (const s of snapshots) {
        if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
        if (s.date > day) break;
      }
      if (Math.abs(best.date - day) <= 14 * DAY) totalMcapUsd += best.mcap;
    }

    const day7ago = day - 7 * DAY;
    let totalMcap7dAgo = 0;
    for (const [, snapshots] of supplyByCoin) {
      let best = snapshots[0];
      for (const s of snapshots) {
        if (Math.abs(s.date - day7ago) < Math.abs(best.date - day7ago)) best = s;
        if (s.date > day7ago) break;
      }
      if (Math.abs(best.date - day7ago) <= 14 * DAY) totalMcap7dAgo += best.mcap;
    }

    const mcap7dChangePct = totalMcap7dAgo > 0
      ? ((totalMcapUsd - totalMcap7dAgo) / totalMcap7dAgo) * 100
      : 0;

    const indexResult = computeStabilityIndex({
      depegs,
      totalMcapUsd,
      freezeCount24h: 0,
      mcap7dChangePct,
    });

    stmts.push(
      db.prepare(
        "INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)"
      ).bind(
        day,
        indexResult.score,
        indexResult.band,
        JSON.stringify(indexResult.components),
        JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h: 0, mcap7dChangePct }),
      )
    );
  }

  await batchExecute(db, stmts);
  return sortedDays.length;
}
