import { withErrorHandler } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";
import { computeStabilityIndex } from "../lib/stability-index";
import { batchExecute } from "../lib/db";

export const handleBackfillStabilityIndex = withErrorHandler(
  "backfill-stability-index",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;

    const now = Math.floor(Date.now() / 1000);
    const DAY = 86400;

    // Determine backfill window: find earliest depeg event
    const earliest = await db
      .prepare("SELECT MIN(started_at) as earliest FROM depeg_events")
      .first<{ earliest: number | null }>();

    if (!earliest?.earliest) {
      return new Response(JSON.stringify({ error: "No depeg events found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Start from earliest depeg event, iterate day by day
    const startDay = Math.floor(earliest.earliest / DAY) * DAY;
    const endDay = Math.floor(now / DAY) * DAY;

    // Load all depeg events into memory for fast lookup
    const allDepegs = await db
      .prepare("SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at")
      .all<{ stablecoin_id: string; peak_deviation_bps: number; peg_reference: number; started_at: number; ended_at: number | null }>();
    const depegEvents = allDepegs.results ?? [];

    // Load all supply snapshots for mcap lookup
    const allSupply = await db
      .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
      .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
    const supplyRows = allSupply.results ?? [];

    // Build supply lookup: for each coin, sorted snapshots
    const supplyByCoin = new Map<string, { date: number; mcap: number }[]>();
    for (const r of supplyRows) {
      const list = supplyByCoin.get(r.stablecoin_id) ?? [];
      list.push({ date: r.snapshot_date, mcap: r.circulating_usd });
      supplyByCoin.set(r.stablecoin_id, list);
    }

    // Helper: find nearest supply snapshot for a coin on a given day
    function getMcapForDay(coinId: string, day: number): number {
      const snapshots = supplyByCoin.get(coinId);
      if (!snapshots || snapshots.length === 0) return 0;
      let best = snapshots[0];
      for (const s of snapshots) {
        if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
        if (s.date > day) break;
      }
      // Only use if within 14 days
      return Math.abs(best.date - day) <= 14 * DAY ? best.mcap : 0;
    }

    // Iterate day by day — build all statements first, then atomically replace
    const stmts: D1PreparedStatement[] = [];
    let count = 0;

    for (let day = startDay; day <= endDay; day += DAY) {
      // Find active depegs on this day
      const activeDepegs = depegEvents.filter(
        (e) => e.started_at <= day && (e.ended_at === null ? day <= now : e.ended_at > day)
      );

      // Deduplicate by stablecoin_id: worst bps, earliest start
      const grouped = new Map<string, typeof activeDepegs[number][]>();
      for (const e of activeDepegs) {
        const list = grouped.get(e.stablecoin_id) ?? [];
        list.push(e);
        grouped.set(e.stablecoin_id, list);
      }

      const depegs: { bps: number; mcapUsd: number; depegAgeDays: number }[] = [];

      for (const [coinId, events] of grouped) {
        let worstBps = 0;
        let earliestStart = Infinity;
        for (const e of events) {
          if (e.peg_reference <= 0) continue;
          if (Math.abs(e.peak_deviation_bps) > Math.abs(worstBps)) worstBps = e.peak_deviation_bps;
          if (e.started_at < earliestStart) earliestStart = e.started_at;
        }
        if (earliestStart === Infinity) continue;
        const mcap = getMcapForDay(coinId, day);
        const ageDays = Math.max(0, (day - earliestStart) / DAY);
        depegs.push({ bps: worstBps, mcapUsd: mcap, depegAgeDays: ageDays });
      }

      // Total mcap: sum all tracked coins' supply for this day
      let totalMcapUsd = 0;
      for (const [, snapshots] of supplyByCoin) {
        let best = snapshots[0];
        for (const s of snapshots) {
          if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
          if (s.date > day) break;
        }
        if (Math.abs(best.date - day) <= 14 * DAY) {
          totalMcapUsd += best.mcap;
        }
      }

      // 7-day trend
      const day7ago = day - 7 * DAY;
      let totalMcap7dAgo = 0;
      for (const [, snapshots] of supplyByCoin) {
        let best = snapshots[0];
        for (const s of snapshots) {
          if (Math.abs(s.date - day7ago) < Math.abs(best.date - day7ago)) best = s;
          if (s.date > day7ago) break;
        }
        if (Math.abs(best.date - day7ago) <= 14 * DAY) {
          totalMcap7dAgo += best.mcap;
        }
      }
      const mcap7dChangePct = totalMcap7dAgo > 0
        ? ((totalMcapUsd - totalMcap7dAgo) / totalMcap7dAgo) * 100
        : 0;

      // Freezes: zero for backfill (no deep historical data)
      const freezeCount24h = 0;

      const result = computeStabilityIndex({ depegs, totalMcapUsd, freezeCount24h, mcap7dChangePct });

      stmts.push(
        db.prepare(
          "INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)"
        ).bind(
          day,
          result.score,
          result.band,
          JSON.stringify(result.components),
          JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h, mcap7dChangePct }),
        )
      );
      count++;
    }

    // Atomic replace: DELETE + INSERT in a single batch to minimize the window
    // where the table is empty (concurrent cron reads could see stale data)
    const deleteStmt = db.prepare("DELETE FROM stability_index");
    await batchExecute(db, [deleteStmt, ...stmts]);

    return new Response(JSON.stringify({ ok: true, daysBackfilled: count }), {
      headers: { "Content-Type": "application/json" },
    });
  }
);
