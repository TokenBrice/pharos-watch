import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
} from "../lib/status-reliability";
import type { StatusHistoryResponse } from "@shared/types";

function parseTimeParam(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    // Support either seconds or milliseconds.
    return numeric >= 1_000_000_000_000
      ? Math.floor(numeric / 1000)
      : Math.floor(numeric);
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return null;
  return Math.floor(parsedMs / 1000);
}

export const handleStatusHistory = withErrorHandler(
  "status-history",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    return withAdmin(request, adminKey, async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = new URL(request?.url ?? "https://pharos.watch/api/status-history");
      const limitParam = url.searchParams.get("limit");
      const from = parseTimeParam(url.searchParams.get("from"));
      const to = parseTimeParam(url.searchParams.get("to"));
      const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : 50;

      const [{ state, staleness }, probe, streak, transitions] = await Promise.all([
        getStatusStateSnapshot(db, now),
        getLatestStatusProbe(db),
        getDiscrepancyStreak(db),
        listRecentStatusTransitions(db, limit, { from, to }),
      ]);

      const overall = state?.currentStatus ?? "healthy";
      const discrepancy = buildDiscrepancy(overall, probe, now, streak);

      const body: StatusHistoryResponse = {
        timestamp: now,
        state,
        staleness,
        probe,
        discrepancy,
        transitions,
      };

      return jsonResponse(body, { "Cache-Control": "no-store" });
    });
  }
);
