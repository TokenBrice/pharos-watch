import { makeAdminRoute } from "../lib/route-wrappers";
import { jsonResponse } from "../lib/api-utils";
import { getProbePaths } from "@shared/lib/api-endpoints";

interface AdminRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;
const ROW_LIMIT = 500;

interface ProbeRunRow {
  created_at: number;
  status: "healthy" | "degraded" | "stale";
  details_json: string | null;
}

interface FailedProbe {
  path?: string;
  status?: number;
  error?: string | null;
  latencyMs?: number;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const handleStatusProbeHistory = makeAdminRoute<AdminRouteContext>(
  "route-status-probe-history",
  async ({ db, url }) => {
    const path = url.searchParams.get("path");
    const allowedPaths = new Set<string>([...getProbePaths("public"), ...getProbePaths("admin")]);
    if (!path || !allowedPaths.has(path)) {
      return jsonResponse({ error: "Missing or unknown path" }, { status: 400, noStore: true });
    }
    const daysRaw = Number(url.searchParams.get("days") ?? DEFAULT_DAYS);
    const days = Number.isFinite(daysRaw)
      ? Math.max(1, Math.min(MAX_DAYS, Math.floor(daysRaw)))
      : DEFAULT_DAYS;
    const since = Math.floor(Date.now() / 1000) - days * 86_400;

    const rows = await db
      .prepare(
        "SELECT created_at, status, details_json FROM status_probe_runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind(since, ROW_LIMIT)
      .all<ProbeRunRow>();

    const runs = (rows.results ?? []).map((row) => {
      const details = row.details_json ? safeJsonParse(row.details_json) : null;
      const failedList: FailedProbe[] = details && typeof details === "object" && "failed" in details
        ? Array.isArray((details as { failed?: unknown }).failed)
          ? ((details as { failed: FailedProbe[] }).failed)
          : []
        : [];
      const matching = failedList.find((f) => f.path === path);
      return {
        at: row.created_at,
        overallProbeStatus: row.status,
        failed: matching != null,
        httpStatus: matching?.status ?? null,
        error: matching?.error ?? null,
        latencyMs: matching?.latencyMs ?? null,
      };
    });

    const summary = {
      windowDays: days,
      sampleCount: runs.length,
      failCount: runs.filter((r) => r.failed).length,
    };

    return jsonResponse({ path, summary, runs }, { noStore: true });
  },
);
