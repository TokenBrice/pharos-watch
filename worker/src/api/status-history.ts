import { parseQueryParams, parseTimestampSecondsParam } from "../lib/api-params";
import { jsonResponse } from "../lib/api-response";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
} from "../lib/status-reliability";
import type { StatusHistoryResponse } from "@shared/types/status";
import { makeAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";
import { computeReserveCompositionOverview } from "../lib/live-reserves-store";
import { emptyReserveComposition } from "../lib/status/derived-data";
import { deriveReserveCompositionStatus } from "../lib/status/evaluation-state";
import { logWorkerEvent } from "../lib/structured-log";

export const handleStatusHistoryRoute = makeAdminRoute<AdminRouteContext>(
  "status-history",
  async ({ db, request }) => {
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request.url);
    const from = parseTimestampSecondsParam(url.searchParams.get("from"));
    const to = parseTimestampSecondsParam(url.searchParams.get("to"));
    const parsed = parseQueryParams(url.searchParams, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
    });
    if (parsed instanceof Response) return parsed;
    const { limit } = parsed;
    let transitionQueryFailed = false;

    const [{ state, staleness }, probe, streak, transitionRows, reserveOverviewResult] = await Promise.all([
      getStatusStateSnapshot(db, now),
      getLatestStatusProbe(db),
      getDiscrepancyStreak(db),
      listRecentStatusTransitions(db, limit + 1, { from, to }, () => {
        transitionQueryFailed = true;
      }),
      computeReserveCompositionOverview(db, now)
        .then((overview) => ({ ok: true as const, overview }))
        .catch((error) => {
          logWorkerEvent({
            scope: "admin",
            level: "warn",
            event: "status_history_reserve_composition_unavailable",
            route: "status-history",
            source: "reserve_composition",
            message: "Reserve composition overview unavailable",
            error,
          });
          return { ok: false as const };
        }),
    ]);

    const overall = state?.currentStatus ?? "healthy";
    const discrepancy = buildDiscrepancy(overall, probe, now, streak);
    const hasMore = transitionQueryFailed ? null : transitionRows.length > limit;
    const transitions = transitionRows.slice(0, limit);
    const reserveComposition = reserveOverviewResult.ok
      ? (() => {
          const reserveAssessment = deriveReserveCompositionStatus({
            ...emptyReserveComposition(),
            ...reserveOverviewResult.overview,
          });
          return {
            ...reserveOverviewResult.overview,
            status: reserveAssessment.status,
            freshCoverageRatio: reserveAssessment.freshCoverageRatio,
            authoritativeFreshCoverageRatio: reserveAssessment.authoritativeFreshCoverageRatio,
          };
        })()
      : null;

    const body: StatusHistoryResponse = {
      timestamp: now,
      state,
      staleness,
      probe,
      discrepancy,
      transitions,
      hasMore,
      reserveComposition,
    };

    return jsonResponse(body, { noStore: true });
  },
);
