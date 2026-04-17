export interface AdminActionLogEntry {
  action: string;
  target?: string | null;
  result: "ok" | "error";
  httpStatus?: number;
  details?: Record<string, unknown>;
  /** Caller may override; default pulled from CF Access header, falling back to "internal". */
  actor?: string;
}

export const DETAILS_MAX_LEN = 4096;

export async function logAdminAction(
  db: D1Database,
  entry: AdminActionLogEntry,
  request?: Request,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const actor = entry.actor
    ?? request?.headers.get("Cf-Access-Authenticated-User-Email")
    ?? "internal";
  const detailsJson = entry.details
    ? JSON.stringify(entry.details).slice(0, DETAILS_MAX_LEN)
    : null;
  try {
    await db
      .prepare(
        "INSERT INTO admin_action_audit (created_at, actor, action, target, result, http_status, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(now, actor, entry.action, entry.target ?? null, entry.result, entry.httpStatus ?? null, detailsJson)
      .run();
  } catch (err) {
    // Audit failures must not break the action itself — log and continue.
    console.warn(`[admin-action-audit] write failed for action=${entry.action}:`, err);
  }
}
