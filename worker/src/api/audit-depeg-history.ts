import { withErrorHandler, parseIntParam } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { getDepegThresholdBps, DEPEG_SECONDARY_THRESHOLD_RATIO, USER_AGENT } from "../lib/constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { computeStabilityIndex } from "../lib/stability-index";
import { batchExecute } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import type { DepegRow } from "../lib/depeg-helpers";
import { getPsiMethodologyVersionAt } from "@shared/lib/stability-index-version";
import {
  buildStabilityInputForDay,
  buildSupplySnapshotMap,
  type PsiDepegEventRow,
  type PsiSupplyRow,
} from "../lib/psi-recompute";

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
  async (db: D1Database, url: URL, trustedAdmin?: boolean, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {

      // Pagination: ?limit=N&offset=M — Analyst plan (500 req/min) supports large batches
      const limit = parseIntParam(url.searchParams.get("limit"), 200, 1, 100_000, "limit");
      if (limit instanceof Response) {
        return limit;
      }
      const offset = parseIntParam(url.searchParams.get("offset"), 0, 0, 100_000, "offset");
      if (offset instanceof Response) {
        return offset;
      }
      // Direct delete: ?delete=ID1,ID2 skips CG checks and deletes specified events
      const deleteIds = url.searchParams.get("delete");
      // Dry run: preview deletions without touching the DB
      const dryRun = url.searchParams.get("dry-run") === "true";
      const method = request?.method ?? "GET";
      if (method === "GET" && !dryRun) {
        return new Response(
          JSON.stringify({ error: "Method not allowed. GET supports dry-run=true only; use POST for mutations." }),
          { status: 405, headers: { "Content-Type": "application/json", "Allow": "POST" } },
        );
      }
      // Optional supply filter: ?min-supply=N (default 0 = audit everything with a geckoId)
      const minSupply = parseIntParam(
        url.searchParams.get("min-supply"),
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        "min-supply",
      );
      if (minSupply instanceof Response) {
        return minSupply;
      }
      // Optional symbol filter: ?symbol=USDC (case-insensitive)
      const symbolFilter = url.searchParams.get("symbol")?.toUpperCase() ?? null;

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
      const meta = TRACKED_META_BY_ID.get(event.stablecoin_id);
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
        const cgRes = await fetchWithRetry(cgEndpoint, { headers: cgFetchHeaders }, 1);

        if (!cgRes?.ok) {
          console.warn(`[audit] CG fetch failed for ${event.symbol} (${geckoId}): ${cgRes?.status ?? "no response"}`);
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
    }, trustedAdmin);
  }
);

/** Recompute stability index for a set of affected days after event deletions */
async function recomputeStabilityDays(db: D1Database, affectedDays: Set<number>): Promise<number> {
  const sortedDays = [...affectedDays].sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);
  let recomputedCount = 0;

  const remainingDepegs = await db
    .prepare("SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at")
    .all<PsiDepegEventRow>();
  const depegEvents = remainingDepegs.results ?? [];

  const allSupply = await db
    .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
    .all<PsiSupplyRow>();
  const supplyByCoin = buildSupplySnapshotMap(allSupply.results ?? []);

  const stmts: D1PreparedStatement[] = [];

  for (const day of sortedDays) {
    const input = buildStabilityInputForDay(day, now, depegEvents, supplyByCoin);

    const indexResult = computeStabilityIndex({
      depegs: input.depegs,
      totalMcapUsd: input.totalMcapUsd,
      mcap7dChangePct: input.mcap7dChangePct,
    });
    if (!indexResult) {
      continue;
    }
    const methodologyVersion = getPsiMethodologyVersionAt(day);

    stmts.push(
      db.prepare(
        `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(computed_at) DO UPDATE SET
           score = excluded.score,
           band = excluded.band,
           components = excluded.components,
           input_snapshot = excluded.input_snapshot,
           methodology_version = excluded.methodology_version`
      ).bind(
        day,
        indexResult.score,
        indexResult.band,
        JSON.stringify(indexResult.components),
        JSON.stringify({
          depegCount: input.depegCount,
          totalMcapUsd: input.totalMcapUsd,
          mcap7dChangePct: input.mcap7dChangePct,
          methodologyVersion,
        }),
        methodologyVersion,
      )
    );
    recomputedCount++;
  }

  await batchExecute(db, stmts);
  return recomputedCount;
}
