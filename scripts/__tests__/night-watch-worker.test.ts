import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  renderNightWatchMarkdown,
  runCli,
} from "../maintenance/night-watch-worker.mjs";

const generatedAt = "2026-06-24T10:00:00.000Z";

function scheduleMatrix() {
  return {
    cronJobs: [
      {
        job: "sync-stablecoins",
        label: "Sync stablecoins",
        scheduleKey: "quarterHourly",
        intervalSec: 900,
        maxConnections: 2,
      },
      {
        job: "data-invariant-canary",
        label: "Data invariant canary",
        scheduleKey: "statusSelfCheckOffset",
        intervalSec: 900,
        maxConnections: 0,
      },
    ],
    budgetEntries: [
      {
        job: "sync-stablecoins",
        scheduleKey: "quarterHourly",
        maxConnections: 2,
      },
      {
        job: "digest-trigger-poll",
        scheduleKey: "digestTriggerPoll",
        maxConnections: 1,
      },
    ],
    slotPlans: {
      quarterHourly: {
        scheduleKey: "quarterHourly",
        schedule: "*/15 * * * *",
        jobChains: [["sync-stablecoins"]],
      },
      statusSelfCheckOffset: {
        scheduleKey: "statusSelfCheckOffset",
        schedule: "9,24,39,54 * * * *",
        jobChains: [["data-invariant-canary"]],
      },
      digestTriggerPoll: {
        scheduleKey: "digestTriggerPoll",
        schedule: "*/5 * * * *",
        jobChains: [["daily-digest"]],
        budgetOnlyJobs: ["digest-trigger-poll"],
      },
    },
  };
}

function evidence() {
  return {
    generatedAt,
    options: parseArgs([
      "--start",
      generatedAt,
      "--end",
      "2026-06-24T14:00:00.000Z",
      "--include-status",
      "--include-d1",
    ], new Date(generatedAt)),
    scheduleMatrix: scheduleMatrix(),
    snapshots: [
      {
        collectedAt: "2026-06-24T10:15:00.000Z",
        mode: "d1",
        probes: {
          health: {
            status: 200,
            ok: true,
            payload: { status: "healthy" },
          },
          status: {
            status: 200,
            ok: true,
            payload: {
              overallStatus: "degraded",
              crons: {
                "data-invariant-canary": {
                  lastRun: { status: "ok", startedAt: 1_782_296_900 },
                },
              },
              canaries: {
                errorCount: 1,
                degradedCount: 0,
                checks: {
                  "dews-latest-signal": { checkId: "dews-latest-signal", status: "error" },
                },
              },
            },
          },
        },
        recentRuns: [
          {
            job: "sync-stablecoins",
            status: "ok",
            started_at: 1_782_296_800,
          },
        ],
        slots: [
          {
            slot_key: "quarterHourly",
            state: "completed",
            updated_at: 1_782_296_850,
          },
        ],
        leases: [],
        progress: [],
      },
    ],
  };
}

type TestEvidence = Omit<ReturnType<typeof evidence>, "snapshots"> & {
  snapshots: Array<Record<string, unknown>>;
};

describe("night-watch-worker", () => {
  it("parses watch windows and access options", () => {
    const args = parseArgs([
      "--cycles",
      "2",
      "--start",
      generatedAt,
      "--include-status-history",
      "--include-d1",
      "--metadata-bytes",
      "1200",
    ], new Date(generatedAt));

    expect(args).toMatchObject({
      cycles: 2,
      start: generatedAt,
      end: "2026-06-24T18:00:00.000Z",
      includeStatus: true,
      includeStatusHistory: true,
      includeD1: true,
      adminApiUrl: "https://ops-api.pharos.watch",
      metadataBytes: 1200,
    });
    expect(parseArgs(["--admin-api-url", "https://ops.example.test"], new Date(generatedAt)).adminApiUrl)
      .toBe("https://ops.example.test");
    expect(() => parseArgs(["--cycles", "3"], new Date(generatedAt))).toThrow("--cycles must be 1 or 2");
  });

  it("renders coverage, canary findings, and access sections", () => {
    const markdown = renderNightWatchMarkdown(evidence());

    expect(markdown).toContain("# Worker Night Watch Report");
    expect(markdown).toContain("sync-stablecoins");
    expect(markdown).toContain("data-invariant-canary");
    expect(markdown).toContain("Canaries report 1 errors");
    expect(markdown).toContain("digest-trigger-poll");
  });

  it("escapes Markdown table pipes without letting existing backslashes change the table shape", () => {
    const tableEvidence = evidence();
    tableEvidence.scheduleMatrix.cronJobs[0]!.job = String.raw`sync\job|tenant`;
    tableEvidence.scheduleMatrix.cronJobs[0]!.scheduleKey = String.raw`quarter|hourly`;

    const markdown = renderNightWatchMarkdown(tableEvidence);

    expect(markdown).toContain(String.raw`sync\\job\|tenant`);
    expect(markdown).toContain(String.raw`quarter\|hourly`);
  });

  it("renders D1 child watcher failures as access gaps", () => {
    const failedEvidence = evidence() as TestEvidence;
    failedEvidence.snapshots.push({
      collectedAt: "2026-06-24T10:30:00.000Z",
      mode: "d1-error",
      error: "wrangler auth failed",
      probes: {},
      recentRuns: [],
      slots: [],
      leases: [],
      progress: [],
    });

    const markdown = renderNightWatchMarkdown(failedEvidence);

    expect(markdown).toContain("D1 snapshot failed (wrangler auth failed)");
  });

  it("renders optional artifact gaps separately from access gaps", () => {
    const artifactEvidence = evidence() as TestEvidence;
    artifactEvidence.snapshots[0]!["artifactGaps"] = [
      {
        artifact: "surfacePublicationGenerations",
        table: "surface_publication_generations",
        code: "missing_table",
        severity: "info",
        optional: true,
        message: "Optional D1 artifact table surface_publication_generations is not present.",
      },
    ];

    const markdown = renderNightWatchMarkdown(artifactEvidence);

    expect(markdown).toContain("## Artifact Gaps");
    expect(markdown).toContain("surfacePublicationGenerations optional artifact gap");
    expect(markdown).not.toContain("surfacePublicationGenerations unavailable");
  });

  it("renders dependency root-cause group keys from status payloads", () => {
    const dependencyEvidence = evidence() as TestEvidence;
    const firstSnapshot = dependencyEvidence.snapshots[0] as {
      probes?: {
        status?: {
          payload?: Record<string, unknown>;
        };
      };
    };
    const status = firstSnapshot.probes?.status;
    if (!status) throw new Error("fixture status probe is missing");
    status.payload = {
      ...(status.payload ?? {}),
      dependencyHealth: {
        rootCauseGroups: [
          {
            rootDependencyId: "dex-liquidity",
            rootStatus: "degraded",
          },
        ],
      },
    };

    const markdown = renderNightWatchMarkdown(dependencyEvidence);

    expect(markdown).toContain("dependency root-cause group");
    expect(markdown).toContain("dex-liquidity: degraded");
  });

  it("writes dry-run report and evidence without collecting production data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-night-watch-"));
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as typeof process.stdout;
    const reportPath = relative(process.cwd(), join(dir, "report.md"));
    const evidencePath = relative(process.cwd(), join(dir, "evidence.json"));

    await expect(runCli([
      "--dry-run",
      "--start",
      generatedAt,
      "--output",
      reportPath,
      "--evidence-json",
      evidencePath,
    ], stdout)).resolves.toBe(0);

    expect(readFileSync(resolve(process.cwd(), reportPath), "utf8")).toContain("# Worker Night Watch Report");
    expect(JSON.parse(readFileSync(resolve(process.cwd(), evidencePath), "utf8")).snapshots).toEqual([]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Night-watch report written"));
  });

  it("renders from a fixture while honoring output paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-night-watch-fixture-"));
    const fixturePath = relative(process.cwd(), join(dir, "fixture.json"));
    const reportPath = relative(process.cwd(), join(dir, "fixture-report.md"));
    const evidencePath = relative(process.cwd(), join(dir, "fixture-evidence.json"));
    writeFileSync(resolve(process.cwd(), fixturePath), JSON.stringify(evidence()), "utf8");

    await expect(runCli([
      "--fixture",
      fixturePath,
      "--output",
      reportPath,
      "--evidence-json",
      evidencePath,
      "--cf-access-client-id",
      "client",
      "--cf-access-client-secret",
      "secret",
    ], { write: vi.fn(() => true) } as unknown as typeof process.stdout)).resolves.toBe(0);

    const written = JSON.parse(readFileSync(resolve(process.cwd(), evidencePath), "utf8"));
    expect(written.options.evidenceJsonPath).toBe(evidencePath);
    expect(written.options.cfAccessClientId).toBe("[redacted]");
    expect(written.options.cfAccessClientSecret).toBe("[redacted]");
    expect(readFileSync(resolve(process.cwd(), reportPath), "utf8")).toContain("Canaries report 1 errors");
  });
});
