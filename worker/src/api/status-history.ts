import { parseQueryParams, jsonResponse, parseTimestampSecondsParam } from "../lib/api-utils";
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

    const [{ state, staleness }, probe, streak, transitions, reserveOverviewResult] = await Promise.all([
      getStatusStateSnapshot(db, now),
      getLatestStatusProbe(db),
      getDiscrepancyStreak(db),
      listRecentStatusTransitions(db, limit, { from, to }),
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
      reserveComposition,
    };

    return jsonResponse(body, { noStore: true });
  },
);
