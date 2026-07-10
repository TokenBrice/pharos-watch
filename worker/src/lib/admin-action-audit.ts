export interface AdminActionLogEntry {
  action: string;
  target?: string | null;
  result: "ok" | "error";
  httpStatus?: number;
  details?: Record<string, unknown>;
  /** Secret-free opaque intent identity used to suppress duplicate canonical audit rows. */
  intentKey?: string;
  /** Originals replace replay placeholders; replays only fill a missing row. */
  intentWriteMode?: "authoritative" | "insert-if-missing";
  /** Caller may override; default pulled from CF Access header, falling back to "internal". */
  actor?: string;
}

export const DETAILS_MAX_LEN = 4096;

function reportAuditWriteFailure(action: string, error: unknown): false {
  console.warn(`[admin-action-audit] write failed for action=${action}:`, error);
  return false;
}

function serializeDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const detailsJson = JSON.stringify(details);
  if (detailsJson.length <= DETAILS_MAX_LEN) return detailsJson;
  return JSON.stringify({
    _truncated: true,
    maxSize: DETAILS_MAX_LEN,
    originalSize: detailsJson.length,
  });
}

export async function logAdminAction(db: D1Database, entry: AdminActionLogEntry, request?: Request): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const actor = entry.actor ?? request?.headers.get("Cf-Access-Authenticated-User-Email") ?? "internal";
  const detailsJson = serializeDetails(entry.details);
  try {
    if (entry.intentKey) {
      const values = [
        now,
        actor,
        entry.action,
        entry.target ?? null,
        entry.result,
        entry.httpStatus ?? null,
        detailsJson,
        entry.intentKey,
      ];
      const sql =
        entry.intentWriteMode === "authoritative"
          ? `INSERT INTO admin_action_audit
               (created_at, actor, action, target, result, http_status, details_json, intent_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(action, intent_key) WHERE intent_key IS NOT NULL DO UPDATE SET
               created_at = excluded.created_at,
               actor = excluded.actor,
               target = excluded.target,
               result = excluded.result,
               http_status = excluded.http_status,
               details_json = excluded.details_json`
          : `INSERT OR IGNORE INTO admin_action_audit
               (created_at, actor, action, target, result, http_status, details_json, intent_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      const result = await db
        .prepare(sql)
        .bind(...values)
        .run();
      return result.success ? true : reportAuditWriteFailure(entry.action, "D1 returned success=false");
    }
    const result = await db
      .prepare(
        "INSERT INTO admin_action_audit (created_at, actor, action, target, result, http_status, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(now, actor, entry.action, entry.target ?? null, entry.result, entry.httpStatus ?? null, detailsJson)
      .run();
    return result.success ? true : reportAuditWriteFailure(entry.action, "D1 returned success=false");
  } catch (err) {
    return reportAuditWriteFailure(entry.action, err);
  }
}
