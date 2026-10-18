import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { StatusCronDetailResponse } from "@shared/types/status";
import { adminErrorResponse, adminJsonResponse, makeAdminRoute, type AdminUrlRouteContext } from "../lib/route-wrappers";
import { loadCronHealth } from "../lib/status/cron-health";

/**
 * Per-job cron detail for the operator workbench: the same verdict and run
 * window as the `/api/status` summary, with full run and progress metadata.
 * Reads are scoped to the one job.
 */
export const handleStatusCronDetailRoute = makeAdminRoute<AdminUrlRouteContext>(
  "status-cron-detail",
  async ({ db, url }) => {
    const job = url.searchParams.get("job");
    if (!job) return adminErrorResponse(400, "Missing required 'job' query parameter.");
    if (!Object.prototype.hasOwnProperty.call(CRON_INTERVALS, job)) {
      return adminErrorResponse(404, `Unknown cron job '${job}'.`);
    }
    const now = Math.floor(Date.now() / 1000);
    const cronHealth = await loadCronHealth(db, now, { jobs: [job] });
    const sectionErrors: StatusCronDetailResponse["sectionErrors"] = {};
    if (cronHealth.cronProgressQueryFailed) sectionErrors.cronProgress = {
      code: "cron_progress_query_failed",
      message: "In-flight progress unavailable; no progress row is not proof the job is idle.",
    };
    if (cronHealth.cronLeaseQueryFailed) sectionErrors.cronLeases = {
      code: "cron_lease_query_failed",
      message: "Cron leases unavailable; stale-lease artifacts could not be evaluated.",
    };
    if (cronHealth.scheduledSlotEventMarkerQueryFailed) sectionErrors.scheduledSlotEvents = {
      code: "scheduled_slot_event_query_failed",
      message: "Scheduled-slot event markers unavailable; no latest event is not proof of none.",
    };
    const body: StatusCronDetailResponse = {
      timestamp: now,
      job,
      cron: cronHealth.crons[job],
      sectionErrors,
    };
    return adminJsonResponse(body);
  },
);
