import { parseQueryParams, jsonResponse } from "../lib/api-utils";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
} from "../lib/status-reliability";
import type { StatusHistoryResponse } from "@shared/types/status";
import { runAdminRoute } from "../lib/route-wrappers";

function parseTimeParam(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    return numeric >= 1_000_000_000_000
      ? Math.floor(numeric / 1000)
      : Math.floor(numeric);
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return null;
  return Math.floor(parsedMs / 1000);
}

export function handleStatusHistory(
  db: D1Database,
  trustedAdmin?: boolean,
  request?: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "status-history",
      request,
      trustedAdmin,
    },
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = new URL(request?.url ?? "https://pharos.watch/api/status-history");
      const from = parseTimeParam(url.searchParams.get("from"));
      const to = parseTimeParam(url.searchParams.get("to"));
      const parsed = parseQueryParams(url.searchParams, {
        limit: { type: "int", default: 50, min: 1, max: 200 },
      });
      if (parsed instanceof Response) return parsed;
      const { limit } = parsed;

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

      return jsonResponse(body, { noStore: true });
    },
  );
}
