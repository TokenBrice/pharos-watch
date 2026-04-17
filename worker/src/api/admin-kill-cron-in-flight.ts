import { makeIdempotentAdminRoute } from "../lib/route-wrappers";
import { errorResponse, jsonResponse } from "../lib/api-utils";
import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";
import { logAdminAction, type AdminActionLogEntry } from "../lib/admin-action-audit";

interface AdminRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

const VALID_JOB_IDS = new Set<string>(CRON_JOB_DEFINITIONS.map((def) => def.job));

export const handleKillCronInFlight = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-kill-cron-in-flight",
  "kill-cron-in-flight",
  async ({ db, url, request }) => {
    const job = url.searchParams.get("job")?.trim();
    const leaseOwner = url.searchParams.get("leaseOwner")?.trim();
    if (!job || !leaseOwner) return errorResponse(400, "Missing required params: job, leaseOwner");
    if (!VALID_JOB_IDS.has(job)) return errorResponse(400, `Unknown cron job: ${job}`);

    // Conditional delete: only matches when lease_owner matches what the
    // operator observed. Prevents racing a legitimate replacement that took
    // over after the operator loaded the status snapshot.
    const leaseResult = await db
      .prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ?")
      .bind(job, leaseOwner)
      .run();
    const leaseCleared = leaseResult.meta?.changes ?? 0;

    const audit: AdminActionLogEntry = leaseCleared === 0
      ? {
        action: "kill-cron-in-flight",
        target: job,
        result: "error",
        httpStatus: 409,
        details: { leaseOwner, reason: "lease-owner-mismatch-or-absent" },
      }
      : {
        action: "kill-cron-in-flight",
        target: job,
        result: "ok",
        httpStatus: 200,
        details: { leaseOwner, leaseCleared, progressCleared: 0 },
      };

    if (leaseCleared === 0) {
      await logAdminAction(db, audit, request);
      return errorResponse(409, "Lease owner no longer matches or lease already released.");
    }

    const progressResult = await db
      .prepare("DELETE FROM cron_run_progress WHERE job = ? AND lease_owner = ?")
      .bind(job, leaseOwner)
      .run();
    const progressCleared = progressResult.meta?.changes ?? 0;
    if (audit.details) audit.details.progressCleared = progressCleared;
    await logAdminAction(db, audit, request);
    return jsonResponse({ ok: true, leaseCleared, progressCleared }, { status: 200, noStore: true });
  },
);
