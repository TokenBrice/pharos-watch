import { makeIdempotentAdminRoute } from "../lib/route-wrappers";
import { jsonResponse } from "../lib/api-utils";
import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";
import { logAdminAction } from "../lib/admin-action-audit";

interface AdminRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

const VALID_JOB_IDS = new Set<string>(CRON_JOB_DEFINITIONS.map((def) => def.job));

export const handleResetCronLease = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-reset-cron-lease",
  "reset-cron-lease",
  async ({ db, url, request }) => {
    const job = url.searchParams.get("job")?.trim();
    if (!job) {
      return jsonResponse(
        { error: "Missing required query param: job" },
        { status: 400, noStore: true },
      );
    }
    if (!VALID_JOB_IDS.has(job)) {
      return jsonResponse(
        { error: `Unknown cron job: ${job}` },
        { status: 400, noStore: true },
      );
    }
    const result = await db.prepare("DELETE FROM cron_leases WHERE job = ?").bind(job).run();
    const cleared = result.meta?.changes ?? 0;
    await logAdminAction(
      db,
      { action: "reset-cron-lease", target: job, result: "ok", httpStatus: 200, details: { cleared } },
      request,
    );
    return jsonResponse({ ok: true, cleared }, { status: 200, noStore: true });
  },
);
