import { makeAdminRoute, type AdminUrlRouteContext } from "../lib/route-wrappers";
import { jsonResponse, parseClampedIntegerParam, safeJsonParse } from "../lib/api-utils";
import { getProbePaths } from "@shared/lib/api-endpoints";

const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;
// Probes fire every 15 min → 96/day → 2880 rows in a full 30d window.
// 3000 absorbs drift without aggregating. Admin-only, no cache-public pressure.
const ROW_LIMIT = 3000;

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


export const handleStatusProbeHistory = makeAdminRoute<AdminUrlRouteContext>(
  "route-status-probe-history",
  async ({ db, url }) => {
    const path = url.searchParams.get("path");
    const allowedPaths = new Set<string>([...getProbePaths("public"), ...getProbePaths("admin")]);
    if (!path || !allowedPaths.has(path)) {
      return jsonResponse({ error: "Missing or unknown path" }, { status: 400 });
    }
    const days = parseClampedIntegerParam(url.searchParams.get("days"), DEFAULT_DAYS, 1, MAX_DAYS);
    const since = Math.floor(Date.now() / 1000) - days * 86_400;

    const rows = await db
      .prepare(
        "SELECT created_at, status, details_json FROM status_probe_runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind(since, ROW_LIMIT)
      .all<ProbeRunRow>();

    const runs = (rows.results ?? []).map((row) => {
      const details = safeJsonParse<unknown>(
        row.details_json,
        null,
        `status-probe-history:${row.created_at}:details_json`,
      );
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

    return jsonResponse({ path, summary, runs });
  },
);
