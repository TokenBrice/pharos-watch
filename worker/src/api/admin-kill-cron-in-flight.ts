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

export const handleKillCronInFlight = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-kill-cron-in-flight",
  "kill-cron-in-flight",
  async ({ db, url, request }) => {
    const job = url.searchParams.get("job")?.trim();
    const leaseOwner = url.searchParams.get("leaseOwner")?.trim();
    if (!job || !leaseOwner) {
      return jsonResponse(
        { error: "Missing required params: job, leaseOwner" },
        { status: 400, noStore: true },
      );
    }
    if (!VALID_JOB_IDS.has(job)) {
      return jsonResponse(
        { error: `Unknown cron job: ${job}` },
        { status: 400, noStore: true },
      );
    }
    // Conditional delete — only if the stored lease_owner matches. Prevents
    // racing a legitimate replacement that took over since the operator
    // loaded the status snapshot.
    const leaseResult = await db
      .prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ?")
      .bind(job, leaseOwner)
      .run();
    const leaseCleared = leaseResult.meta?.changes ?? 0;
    if (leaseCleared === 0) {
      await logAdminAction(
        db,
        {
          action: "kill-cron-in-flight",
          target: job,
          result: "error",
          httpStatus: 409,
          details: { leaseOwner, reason: "lease-owner-mismatch-or-absent" },
        },
        request,
      );
      return jsonResponse(
        { error: "Lease owner no longer matches or lease already released." },
        { status: 409, noStore: true },
      );
    }
    // Also clear the in-flight progress row (same lease_owner guard).
    const progressResult = await db
      .prepare("DELETE FROM cron_run_progress WHERE job = ? AND lease_owner = ?")
      .bind(job, leaseOwner)
      .run();
    const progressCleared = progressResult.meta?.changes ?? 0;
    await logAdminAction(
      db,
      {
        action: "kill-cron-in-flight",
        target: job,
        result: "ok",
        httpStatus: 200,
        details: { leaseOwner, leaseCleared, progressCleared },
      },
      request,
    );
    return jsonResponse(
      { ok: true, leaseCleared, progressCleared },
      { status: 200, noStore: true },
    );
  },
);
