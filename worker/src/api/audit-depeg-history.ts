import { parseQueryParams, jsonResponse, errorResponse } from "../lib/api-utils";
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
import { DAY_SECONDS } from "@shared/lib/time-constants";

type Verdict = "false_positive" | "confirmed" | "no_data" | "skipped" | "error";
type RepairMode = "synthetic-splits";

const SYNTHETIC_SPLIT_MAX_GAP_SEC = 30 * 60;
const SYNTHETIC_SPLIT_RECOVERY_BAR_BPS = 50;
const SYNTHETIC_SPLIT_RESUME_MIN_BPS = 500;

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

interface SyntheticSplitRepairSummary {
  stablecoinId: string;
  symbol: string;
  direction: string;
  keeperId: number;
  mergedIds: number[];
  eventIds: number[];
  startedAt: number;
  endedAt: number | null;
  peakBps: number;
  recoveryPrice: number | null;
  gapSeconds: number[];
}

interface SyntheticSplitRepairResult {
  repair: RepairMode;
  totalMatching: number;
  offset: number;
  limit: number;
  dryRun: boolean;
  candidateGroups: SyntheticSplitRepairSummary[];
  repairedGroups: SyntheticSplitRepairSummary[];
  repairedEventCount: number;
  daysRecomputed: number;
}

function getAbsoluteDeviationBps(price: number | null | undefined, pegReference: number): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0 || !Number.isFinite(pegReference) || pegReference <= 0) {
    return null;
  }
  return Math.abs(Math.round(((price / pegReference) - 1) * 10_000));
}

function isSyntheticSplitPair(previous: DepegRow, next: DepegRow): boolean {
  if (previous.stablecoin_id !== next.stablecoin_id) return false;
  if (previous.direction !== next.direction) return false;
  if (previous.ended_at == null) return false;

  const gapSec = next.started_at - previous.ended_at;
  if (gapSec < 0 || gapSec > SYNTHETIC_SPLIT_MAX_GAP_SEC) return false;

  const threshold = Math.max(getDepegThresholdBps(next.peg_type), SYNTHETIC_SPLIT_RESUME_MIN_BPS);
  const recoveryBps = getAbsoluteDeviationBps(previous.recovery_price, previous.peg_reference);
  const resumeBps = getAbsoluteDeviationBps(next.start_price, next.peg_reference);
  const previousPeakAbsBps = Math.abs(previous.peak_deviation_bps);

  const resumedSevereDepeg =
    resumeBps != null &&
    resumeBps >= threshold &&
    previousPeakAbsBps >= threshold;
  if (!resumedSevereDepeg) {
    return false;
  }

  const sameSourceSyntheticSplit =
    previous.source === "live" &&
    next.source === "live" &&
    recoveryBps != null &&
    recoveryBps <= SYNTHETIC_SPLIT_RECOVERY_BAR_BPS;
  if (sameSourceSyntheticSplit) {
    return true;
  }

  return previous.source === "backfill" && next.source === "live" && previous.recovery_price == null;
}

function shouldKeepLiveTailForSyntheticSplit(rows: DepegRow[]): boolean {
  if (rows.length < 2) return false;
  const tail = rows[rows.length - 1];
  if (!tail || tail.source !== "live") return false;
  return rows.slice(0, -1).every((row) => row.source === "backfill");
}

function pickSyntheticSplitKeeper(rows: DepegRow[]): DepegRow {
  if (shouldKeepLiveTailForSyntheticSplit(rows)) {
    return rows[rows.length - 1];
  }
  return rows[0];
}

function summarizeSyntheticSplitGroup(rows: DepegRow[]): SyntheticSplitRepairSummary {
  const keeper = pickSyntheticSplitKeeper(rows);
  const first = rows[0];
  const tail = rows[rows.length - 1];
  let worst = keeper;
  for (const row of rows) {
    if (Math.abs(row.peak_deviation_bps) > Math.abs(worst.peak_deviation_bps)) {
      worst = row;
    }
  }
  const gapSeconds: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    gapSeconds.push(Math.max(0, rows[i].started_at - (rows[i - 1].ended_at ?? rows[i].started_at)));
  }
  return {
    stablecoinId: first.stablecoin_id,
    symbol: first.symbol,
    direction: first.direction,
    keeperId: keeper.id,
    mergedIds: rows.filter((row) => row.id !== keeper.id).map((row) => row.id),
    eventIds: rows.map((row) => row.id),
    startedAt: first.started_at,
    endedAt: tail.ended_at,
    peakBps: worst.peak_deviation_bps,
    recoveryPrice: tail.ended_at == null ? null : tail.recovery_price,
    gapSeconds,
  };
}

function collectSyntheticSplitGroups(events: DepegRow[]): DepegRow[][] {
  const byCoin = new Map<string, DepegRow[]>();
  for (const event of events) {
    const list = byCoin.get(event.stablecoin_id) ?? [];
    list.push(event);
    byCoin.set(event.stablecoin_id, list);
  }

  const groups: DepegRow[][] = [];
  for (const rows of byCoin.values()) {
    rows.sort((a, b) => a.started_at - b.started_at);
    let currentGroup: DepegRow[] = [];
    for (const row of rows) {
      if (currentGroup.length === 0) {
        currentGroup = [row];
        continue;
      }
      const previous = currentGroup[currentGroup.length - 1];
      if (isSyntheticSplitPair(previous, row)) {
        currentGroup.push(row);
        continue;
      }
      if (currentGroup.length > 1) {
        groups.push(currentGroup);
      }
      currentGroup = [row];
    }
    if (currentGroup.length > 1) {
      groups.push(currentGroup);
    }
  }

  groups.sort((a, b) => a[0].started_at - b[0].started_at);
  return groups;
}

export async function handleAuditDepegHistory(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
): Promise<Response> {
  return withAdmin(
    request,
    async () => {
      // Pagination + supply filter
      const parsed = parseQueryParams(url.searchParams, {
        limit: { type: "int", default: 200, min: 1, max: 100_000 },
        offset: { type: "int", default: 0, min: 0, max: 100_000 },
        "min-supply": { type: "int", default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, name: "min-supply" },
      });
      if (parsed instanceof Response) return parsed;
      const { limit, offset } = parsed;
      const minSupply = parsed["min-supply"];
      // Direct delete: ?delete=ID1,ID2 skips CG checks and deletes specified events
      const deleteIds = url.searchParams.get("delete");
      const repairModeRaw = url.searchParams.get("repair");
      const repairMode: RepairMode | null =
        repairModeRaw === "synthetic-splits" ? "synthetic-splits" : null;
      if (repairModeRaw && repairMode == null) {
        return errorResponse(400, `Unsupported repair mode: ${repairModeRaw}`);
      }
      if (deleteIds && repairMode) {
        return errorResponse(400, "Use either delete=... or repair=..., not both");
      }
      // Dry run: preview deletions without touching the DB
      const dryRun = url.searchParams.get("dry-run") === "true";
      const method = request?.method ?? "GET";
      if (method === "GET" && !dryRun) {
        return new Response(
          JSON.stringify({ error: "Method not allowed. GET supports dry-run=true only; use POST for mutations." }),
          { status: 405, headers: { "Content-Type": "application/json", Allow: "POST" } },
        );
      }
      // Optional symbol filter: ?symbol=USDC (case-insensitive)
      const symbolFilter = url.searchParams.get("symbol")?.toUpperCase() ?? null;

      // 1. Query closed depeg events
      // Apply pagination only for the default audit path. The delete path
      // targets events by ID (doesn't need the full set), and the repair path
      // has its own separate query at line 290.
      const usePagination = !deleteIds && !repairMode;
      const eventsSql = "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at"
        + (usePagination ? " LIMIT ? OFFSET ?" : "");
      const eventsStmt = usePagination
        ? db.prepare(eventsSql).bind(limit, offset)
        : db.prepare(eventsSql);
      const allEvents = await eventsStmt.all<DepegRow>();
      const events = allEvents.results ?? [];

      // Fast path: direct delete of specific event IDs (pre-verified externally)
      if (deleteIds) {
        const ids = deleteIds
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));
        const toDelete = events.filter((e) => ids.includes(e.id));
        if (toDelete.length === 0) {
          return errorResponse(404, "No matching events found");
        }

        if (dryRun) {
          return jsonResponse({
            dryRun: true,
            deletedEvents: toDelete.map((e) => ({
              id: e.id,
              symbol: e.symbol,
              startedAt: e.started_at,
              peakBps: e.peak_deviation_bps,
            })),
            daysRecomputed: 0,
          });
        }

        const affectedDays = new Set<number>();
        for (const event of toDelete) {
          await db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(event.id).run();
          const startDay = Math.floor(event.started_at / DAY_SECONDS) * DAY_SECONDS;
          const endDay = Math.floor((event.ended_at ?? event.started_at) / DAY_SECONDS) * DAY_SECONDS;
          for (let d = startDay; d <= endDay; d += DAY_SECONDS) {
            affectedDays.add(d);
          }
          console.log(`[audit] Direct delete: ${event.symbol} id=${event.id} peak=${event.peak_deviation_bps}bps`);
        }

        const daysRecomputed = await recomputeStabilityDays(db, affectedDays);

        return jsonResponse({
          dryRun: false,
          deletedEvents: toDelete.map((e) => ({
            id: e.id,
            symbol: e.symbol,
            startedAt: e.started_at,
            peakBps: e.peak_deviation_bps,
          })),
          daysRecomputed,
        });
      }

      if (repairMode === "synthetic-splits") {
        const liveAndClosedOrOpen = await db
          .prepare(
            "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source FROM depeg_events ORDER BY stablecoin_id, started_at",
          )
          .all<DepegRow>();
        const groupedCandidates = collectSyntheticSplitGroups(
          (liveAndClosedOrOpen.results ?? []).filter((event) =>
            symbolFilter ? event.symbol.toUpperCase() === symbolFilter : true,
          ),
        );
        const paginatedGroups = groupedCandidates.slice(offset, offset + limit);
        const result: SyntheticSplitRepairResult = {
          repair: repairMode,
          totalMatching: groupedCandidates.length,
          offset,
          limit,
          dryRun,
          candidateGroups: paginatedGroups.map((group) => summarizeSyntheticSplitGroup(group)),
          repairedGroups: [],
          repairedEventCount: 0,
          daysRecomputed: 0,
        };

        if (dryRun || paginatedGroups.length === 0) {
          return jsonResponse(result);
        }

        const affectedDays = new Set<number>();
        const stmts: D1PreparedStatement[] = [];
        const now = Math.floor(Date.now() / 1000);

        for (const group of paginatedGroups) {
          const summary = summarizeSyntheticSplitGroup(group);
          const keeper = pickSyntheticSplitKeeper(group);
          const first = group[0];
          const tail = group[group.length - 1];
          let worst = keeper;
          for (const row of group) {
            if (Math.abs(row.peak_deviation_bps) > Math.abs(worst.peak_deviation_bps)) {
              worst = row;
            }
          }

          stmts.push(
            db
              .prepare(
                "UPDATE depeg_events SET started_at = ?, start_price = ?, peg_reference = ?, peak_deviation_bps = ?, peak_price = ?, ended_at = ?, recovery_price = ? WHERE id = ?",
              )
              .bind(
                first.started_at,
                first.start_price,
                first.peg_reference,
                worst.peak_deviation_bps,
                worst.peak_price ?? worst.start_price,
                tail.ended_at,
                tail.ended_at == null ? null : tail.recovery_price,
                keeper.id,
              ),
          );
          for (const row of group) {
            if (row.id === keeper.id) continue;
            stmts.push(db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(row.id));
          }

          const startDay = Math.floor(summary.startedAt / DAY_SECONDS) * DAY_SECONDS;
          const endTs = summary.endedAt ?? now;
          const endDay = Math.floor(endTs / DAY_SECONDS) * DAY_SECONDS;
          for (let day = startDay; day <= endDay; day += DAY_SECONDS) {
            affectedDays.add(day);
          }

          result.repairedGroups.push(summary);
          result.repairedEventCount += summary.mergedIds.length;
        }

        await batchExecute(db, stmts);
        if (affectedDays.size > 0) {
          result.daysRecomputed = await recomputeStabilityDays(db, affectedDays);
        }
        return jsonResponse(result);
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
          return Math.abs(best.date - ts) <= 30 * DAY_SECONDS ? best.supply : 0;
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

          const cgEndpoint = cgUrl(
            `/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}&precision=full`,
          );
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
            const cgBps = Math.abs(Math.round((cgPrice / event.peg_reference - 1) * 10000));
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
              const startDay = Math.floor(event.started_at / DAY_SECONDS) * DAY_SECONDS;
              const endDay = Math.floor((event.ended_at ?? event.started_at) / DAY_SECONDS) * DAY_SECONDS;
              for (let d = startDay; d <= endDay; d += DAY_SECONDS) {
                affectedDays.add(d);
              }

              console.log(
                `[audit] Deleted false positive: ${event.symbol} id=${event.id} peak=${event.peak_deviation_bps}bps, CG max=${maxCgBps}bps`,
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

      return jsonResponse(result);
    },
    trustedAdmin,
  );
}

/** Recompute stability index for a set of affected days after event deletions */
async function recomputeStabilityDays(db: D1Database, affectedDays: Set<number>): Promise<number> {
  const sortedDays = [...affectedDays].sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);
  let recomputedCount = 0;

  const remainingDepegs = await db
    .prepare(
      "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at",
    )
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
      db
        .prepare(
          `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(computed_at) DO UPDATE SET
           score = excluded.score,
           band = excluded.band,
           components = excluded.components,
           input_snapshot = excluded.input_snapshot,
           methodology_version = excluded.methodology_version`,
        )
        .bind(
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
        ),
    );
    recomputedCount++;
  }

  await batchExecute(db, stmts);
  return recomputedCount;
}
