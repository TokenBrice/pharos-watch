import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminUrlRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { VALID_CRON_JOB_IDS } from "@shared/lib/cron-jobs";
import { logAdminAction } from "../lib/admin-action-audit";

export const handleResetCronLease = makeIdempotentAdminRoute<AdminUrlRouteContext>(
  "route-reset-cron-lease",
  "reset-cron-lease",
  async ({ db, url, request }) => {
    const job = url.searchParams.get("job")?.trim();
    if (!job) return adminErrorResponse(400, "Missing required query param: job");
    if (!VALID_CRON_JOB_IDS.has(job)) return adminErrorResponse(400, `Unknown cron job: ${job}`);

    const result = await db.prepare("DELETE FROM cron_leases WHERE job = ?").bind(job).run();
    const cleared = result.meta?.changes ?? 0;
    await logAdminAction(
      db,
      { action: "reset-cron-lease", target: job, result: "ok", httpStatus: 200, details: { cleared } },
      request,
    );
    return adminJsonResponse({ ok: true, cleared }, { status: 200 });
  },
);
