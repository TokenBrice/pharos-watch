import { describe, expect, it } from "vitest";
import {
  classifyArtifactFailure,
  collectWorkerCronSnapshot,
  missingOptionalArtifactGap,
  parseWorkerWatchArgs,
  WORKER_WATCH_DEFAULTS,
} from "../maintenance/watch-worker-cron.mjs";

describe("watch-worker-cron artifact gap classification", () => {
  it("classifies missing optional rollout tables as info-level artifact gaps", () => {
    const descriptor = {
      artifact: "surfacePublicationGenerations",
      table: "surface_publication_generations",
      optionalMissing: true,
    };

    expect(missingOptionalArtifactGap(descriptor)).toMatchObject({
      artifact: "surfacePublicationGenerations",
      table: "surface_publication_generations",
      code: "missing_table",
      severity: "info",
      optional: true,
    });
    expect(classifyArtifactFailure(
      descriptor,
      "D1_ERROR: no such table: surface_publication_generations",
    )).toMatchObject({
      code: "missing_table",
      severity: "info",
      optional: true,
    });
  });

  it("keeps established publication ledger failures warning-level", () => {
    expect(classifyArtifactFailure(
      {
        artifact: "dexPublicationGenerations",
        table: "dex_liquidity_publication_generations",
        optionalMissing: false,
      },
      "D1_ERROR: no such column: current_row_count",
    )).toMatchObject({
      artifact: "dexPublicationGenerations",
      code: "query_failed",
      severity: "warning",
      optional: false,
    });
  });

  it("collects a typed local/status-history snapshot without exposing credentials", async () => {
    const args = parseWorkerWatchArgs([
      "--local",
      "--include-status-history",
      "--cf-access-client-id",
      "client",
      "--cf-access-client-secret",
      "secret",
    ]);
    const select = (_args: unknown, sql: string) => {
      if (sql.includes("sqlite_master")) return [
        { name: "worker_job_attempts" }, { name: "worker_repair_tasks" },
        { name: "worker_canary_runs" }, { name: "surface_publication_generations" },
      ];
      if (sql.includes("FROM cron_runs")) return [{ job: "sync-stablecoins", status: "ok" }];
      return [];
    };
    let optionSecretSeen = false;
    const report = await collectWorkerCronSnapshot(args, {
      select,
      probeCollector: async (options: typeof args) => {
        optionSecretSeen = Boolean(options.cfAccessClientSecret);
        return {
          statusHistory: { url: "http://127.0.0.1/api/status/history", status: 200, ok: true, latencyMs: 1 },
        };
      },
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(optionSecretSeen).toBe(true);

    expect(report).toMatchObject({
      generatedAt: "2026-08-28T00:00:00.000Z",
      scope: "local",
      database: WORKER_WATCH_DEFAULTS.database,
      runStatusCounts: { ok: 1 },
      probes: { statusHistory: { status: 200, ok: true } },
    });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("client");
  });
});
