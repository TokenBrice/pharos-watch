import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
} from "../lib/status-reliability";
import type { StatusHistoryResponse } from "../../../src/lib/types";

export const handleStatusHistory = withErrorHandler(
  "status-history",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;

    const now = Math.floor(Date.now() / 1000);
    const limitParam = new URL(request?.url ?? "https://pharos.watch/api/status-history").searchParams.get("limit");
    const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : 50;

    const [{ state, staleness }, probe, streak, transitions] = await Promise.all([
      getStatusStateSnapshot(db, now),
      getLatestStatusProbe(db),
      getDiscrepancyStreak(db),
      listRecentStatusTransitions(db, limit),
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
  }
);
