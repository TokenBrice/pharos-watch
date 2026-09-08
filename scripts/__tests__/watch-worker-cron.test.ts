import { describe, expect, it } from "vitest";
import {
  classifyArtifactFailure,
  collectWorkerCronSnapshot,
  missingOptionalArtifactGap,
  parseWorkerWatchArgs,
  WORKER_WATCH_DEFAULTS,
} from "../maintenance/watch-worker-cron.mjs";
import { optionalTables, snapshotSelector } from "./watch-worker-cron.test-support";

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
    const { select } = snapshotSelector();
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

  it("returns an informational gap without querying an undiscovered optional table", async () => {
    const { select, queried } = snapshotSelector({ omitted: "surface_publication_generations" });
    const report = await collectWorkerCronSnapshot(parseWorkerWatchArgs(["--local"]), {
      select, probeCollector: async () => ({}),
    });
    expect(queried).not.toContain("surface_publication_generations");
    expect(report.publicationGenerations.surface).toEqual([]);
    expect(report.artifactGaps).toEqual([expect.objectContaining({
      artifact: "surfacePublicationGenerations", table: "surface_publication_generations",
      code: "missing_table", severity: "info", optional: true,
    })]);
    expect(report.artifactErrors).toEqual({});
  });

  it("retains discovery errors while collecting established publication ledgers", async () => {
    const { select, queried } = snapshotSelector({ discoveryError: "discovery unavailable" });
    const report = await collectWorkerCronSnapshot(parseWorkerWatchArgs(["--local"]), {
      select, probeCollector: async () => ({}),
    });
    for (const table of optionalTables) expect(queried).not.toContain(table);
    expect(report.publicationGenerations).toEqual({
      dexLiquidity: [{ generation_id: "dex-retained", state: "published" }],
      yieldRankings: [{ generation_id: "yield-retained", state: "published" }],
      surface: [],
    });
    expect([report.jobAttempts, report.repairTasks, report.canaryRuns]).toEqual([[], [], []]);
    expect(report.artifactErrors).toEqual({
      jobAttempts: "discovery unavailable", repairTasks: "discovery unavailable",
      canaryRuns: "discovery unavailable", surfacePublicationGenerations: "discovery unavailable",
    });
    expect(report.artifactGaps).toEqual(
      ["jobAttempts", "repairTasks", "canaryRuns", "surfacePublicationGenerations"].map((artifact) =>
        expect.objectContaining({
          artifact, code: "query_failed", severity: "warning", optional: true, message: "discovery unavailable",
        })),
    );
  });

  it("downgrades optional selection races but retains required-ledger failures", async () => {
    const optionalError = "D1_ERROR: no such table: surface_publication_generations";
    const requiredError = "D1_ERROR: no such table: dex_liquidity_publication_generations";
    const { select, queried } = snapshotSelector({
      failures: {
        surface_publication_generations: optionalError,
        dex_liquidity_publication_generations: requiredError,
      },
    });
    const report = await collectWorkerCronSnapshot(parseWorkerWatchArgs(["--local"]), {
      select, probeCollector: async () => ({}),
    });
    expect(queried).toContain("surface_publication_generations");
    expect(report.publicationGenerations).toEqual({
      dexLiquidity: [], surface: [],
      yieldRankings: [{ generation_id: "yield-retained", state: "published" }],
    });
    expect(report.artifactErrors).toEqual({ dexPublicationGenerations: requiredError });
    expect(report.artifactGaps).toEqual([
      expect.objectContaining({
        artifact: "dexPublicationGenerations", code: "missing_table", severity: "warning", optional: false,
      }),
      expect.objectContaining({
        artifact: "surfacePublicationGenerations", code: "missing_table", severity: "info", optional: true,
      }),
    ]);
  });
});
