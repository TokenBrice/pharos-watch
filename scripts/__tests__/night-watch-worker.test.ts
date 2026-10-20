import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_JOB_DEFINITIONS, CRON_CONNECTION_BUDGET_ENTRIES } from "../../shared/lib/cron-jobs";
import {
  CONDITIONALLY_ADMITTED_SCHEDULED_TASKS,
  SCHEDULED_SLOT_PLANS,
  SHARED_SCHEDULED_JOB_IDENTITIES,
} from "../../shared/lib/scheduled-runner-registry";
import {
  buildNightWatchCoverage,
  collectD1Snapshot,
  createNightWatchCollectionIdentity,
  loadNightWatchCheckpoint,
  parseArgs,
  persistNightWatchCheckpoint,
  renderNightWatchMarkdown,
  runCli,
} from "../maintenance/night-watch-worker.mjs";
import { collectWorkerCronSnapshot } from "../maintenance/watch-worker-cron.mjs";

vi.mock("../maintenance/watch-worker-cron.mjs", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  collectWorkerCronSnapshot: vi.fn().mockRejectedValue(new Error("Unexpected D1 collection in offline resume test")),
}));

const generatedAt = "2026-06-24T10:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

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

function unobservedPathCoverage(scheduleKey: string, job: string) {
  return buildNightWatchCoverage({
    cronJobs: [{ job, scheduleKey }],
    budgetEntries: [],
    slotPlans: {
      [scheduleKey]: {
        scheduleKey,
        schedule: "*/15 * * * *",
        jobChains: [[job]],
      },
    },
  }, [{ mode: "d1" }], {
    start: generatedAt,
    end: "2026-06-24T10:15:00.000Z",
  });
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
                  runs: [{ status: "ok", startedAt: 1_782_296_900 }],
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
  it("preserves option defaults and maps strict equals-form evidence options", () => {
    const now = new Date(generatedAt);
    expect(parseArgs([], now)).toMatchObject({
      cycles: 1, start: generatedAt, end: "2026-06-24T14:00:00.000Z",
      intervalMinutes: 15, resume: true, remote: true, includeStatus: false,
    });
    expect(parseArgs([
      "--cycles=2", "--interval-minutes=30", "--include-status-history",
      "--no-resume", "--local", "--dry-run", "--sample-limit=10",
    ], now)).toMatchObject({
      cycles: 2, end: "2026-06-24T18:00:00.000Z", intervalMinutes: 30,
      includeStatus: true, includeStatusHistory: true, resume: false, remote: false,
      dryRun: true, sampleLimit: 10,
    });
  });

  it.each([
    ["--unknown"], ["--output"], ["--cycles=1", "--cycles=2"], ["extra"],
    ["--cycles=3"], ["--interval-minutes=2x"], ["--start=invalid"],
    ["--start", generatedAt, "--end", generatedAt],
  ])("rejects invalid night-watch usage %j", (...argv) => {
    expect(() => parseArgs(argv, new Date(generatedAt)))
      .toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it.each(CONDITIONALLY_ADMITTED_SCHEDULED_TASKS)(
    "does not grade unadmitted conditional path $scheduleKey:$job as missing",
    ({ scheduleKey, job }) => {
      const coverage = unobservedPathCoverage(scheduleKey, job);

      expect(coverage.jobPaths).toEqual([expect.objectContaining({
        pathKey: `${scheduleKey}:${job}`,
        expectedDue: 0,
        observedSlots: 0,
        evidenceGrade: "not-due",
        notes: "conditional path; no invocation expected without admission evidence",
      })]);
      expect(coverage.jobs).toEqual([expect.objectContaining({
        job,
        expectedDue: 0,
        evidenceGrade: "not-due",
        notes: "",
      })]);
    },
  );

  it.each([
    { scheduleKey: "quarterHourly", job: "sync-stablecoins" },
    { scheduleKey: "daily0800Utc", job: "snapshot-psi" },
    { scheduleKey: "daily0800Utc", job: "snapshot-public-dataset" },
    { scheduleKey: "fourHourlyYieldSupplemental", job: "sync-yield-supplemental" },
    { scheduleKey: "daily0800Utc", job: "fetch-tbill-rate" },
    { scheduleKey: "daily0805Utc", job: "daily-digest" },
    { scheduleKey: "daily0810Utc", job: "weekly-recap" },
  ])("still grades unobserved unconditional path $scheduleKey:$job as missing", ({ scheduleKey, job }) => {
    const coverage = unobservedPathCoverage(scheduleKey, job);

    expect(coverage.jobPaths).toEqual([expect.objectContaining({
      pathKey: `${scheduleKey}:${job}`,
      expectedDue: 2,
      observedSlots: 0,
      evidenceGrade: "code-only",
      notes: "missing 2 of 2 due execution(s)",
    })]);
    expect(coverage.jobs).toEqual([expect.objectContaining({
      job,
      expectedDue: 2,
      evidenceGrade: "code-only",
      notes: "missing 2 of 2 due execution(s)",
    })]);
  });

  it("does not count stale latest rows as in-window coverage", () => {
    const testEvidence = evidence();
    const snapshot = testEvidence.snapshots[0]! as Omit<(typeof testEvidence.snapshots)[number], "recentRuns"> & {
      recentRuns: Array<{ job: string; status: string; started_at: number; slot_started_at: number }>;
    };
    snapshot.recentRuns = [{
      job: "sync-stablecoins",
      status: "ok",
      started_at: 1_782_210_000,
      slot_started_at: 1_782_210_000,
    }];
    snapshot.probes.status.payload.crons["data-invariant-canary"].runs[0]!.startedAt = 1_782_210_000;

    const coverage = buildNightWatchCoverage(
      testEvidence.scheduleMatrix,
      testEvidence.snapshots,
      testEvidence.options,
    ) as { jobs: Array<{ job: string; observed: boolean; observedSlots: number; evidenceGrade: string }> };

    expect(coverage.jobs.find((job) => job.job === "sync-stablecoins")).toMatchObject({
      observed: false,
      observedSlots: 0,
      evidenceGrade: "code-only",
    });
    expect(coverage.jobs.find((job) => job.job === "data-invariant-canary")).toMatchObject({
      observed: false,
      evidenceGrade: "code-only",
    });
  });

  it.each(["quarterHourly", null, "wrong-schedule"])(
    "attributes coincident supply rows only to their explicit schedule %s",
    (scheduleKey) => {
      const window = { start: "2026-06-24T08:00:00.000Z", end: "2026-06-24T08:01:00.000Z" };
      const slot = Date.parse(window.start) / 1000;
      const row = { job: "snapshot-supply", status: "error", schedule_key: scheduleKey, slot_started_at: slot, started_at: slot };
      const matrix = {
        cronJobs: CRON_JOB_DEFINITIONS,
        budgetEntries: CRON_CONNECTION_BUDGET_ENTRIES,
        slotPlans: SCHEDULED_SLOT_PLANS,
        sharedJobPaths: SHARED_SCHEDULED_JOB_IDENTITIES,
      };
      const snapshots = [{
        mode: "d1", recentRuns: [row],
        probes: { status: { payload: { crons: { "snapshot-supply": { runs: [{ startedAt: slot, status: "error" }] } } } } },
      }];
      const coverage = buildNightWatchCoverage(matrix, snapshots, window);
      expect(coverage.jobPaths.find((path: { pathKey: string }) => path.pathKey === "daily0800Utc:snapshot-supply"))
        .toMatchObject({ expectedDue: 1, observedSlots: 0, evidenceGrade: "code-only", observed: false });
      expect(coverage.jobPaths.find((path: { pathKey: string }) => path.pathKey === "quarterHourly:snapshot-supply"))
        .toMatchObject(scheduleKey === "quarterHourly"
          ? { observedSlots: 1, evidenceGrade: "confirmed", observed: true }
          // At 08:00 this path is due too; missing schedule attribution is code-only, not not-due.
          : { observedSlots: 0, evidenceGrade: "code-only", observed: false });
      expect(coverage.unattributedRuns).toEqual(scheduleKey === "quarterHourly" ? [] : [row]);
      const markdown = renderNightWatchMarkdown({
        ...evidence(), options: { ...evidence().options, ...window }, scheduleMatrix: matrix, snapshots,
      });
      expect(markdown).toContain("| error | 1 |");
      expect(markdown).toContain("| snapshot-supply | daily0800Utc | 1/0 | code-only |");
    },
  );

  it("atomically checkpoints redacted samples and resumes only matching collection identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-night-watch-checkpoint-"));
    tempDirs.push(dir);
    const checkpointPath = join(dir, "samples.jsonl");
    const options = evidence().options;
    const collectionIdentity = createNightWatchCollectionIdentity(options);
    persistNightWatchCheckpoint(checkpointPath, [{
      version: 2, collectionIdentity, targetAt: generatedAt,
      snapshot: { collectedAt: generatedAt, apiKey: "private", recentRuns: [] },
    }]);
    const checkpointText = readFileSync(checkpointPath, "utf8");
    expect(checkpointText).not.toContain("private");
    expect(checkpointText).toContain("[redacted]");
    expect(readdirSync(dir)).toEqual(["samples.jsonl"]);
    expect(loadNightWatchCheckpoint(checkpointPath, options)).toHaveLength(1);
    expect(loadNightWatchCheckpoint(checkpointPath, {
      ...options, apiUrl: `${options.apiUrl}/`, adminApiUrl: `${options.adminApiUrl}/`,
      outputPath: "different-report.md", cfAccessClientSecret: "different-credential",
    })).toHaveLength(1);
    for (const mismatch of [
      { database: "other-db" }, { remote: false }, { apiUrl: "https://other.example" },
      { adminApiUrl: "https://other-admin.example" }, { includeD1: false }, { includeStatus: false },
      { includeStatusHistory: true }, { includeWorkerTail: true }, { intervalMinutes: 30 },
      { start: "2026-06-25T10:00:00.000Z" }, { end: "2026-06-24T18:00:00.000Z" },
      { cycles: 2 }, { sampleLimit: 1 }, { metadataBytes: 1 },
    ]) {
      expect(() => loadNightWatchCheckpoint(checkpointPath, { ...options, ...mismatch })).toThrow("identity mismatch");
    }
    expect(readFileSync(checkpointPath, "utf8")).toBe(checkpointText);
    expect(createNightWatchCollectionIdentity({
      ...options, apiUrl: "https://user:private@api.pharos.watch/path?secret=private",
      cfAccessClientSecret: "private",
    })).toEqual(collectionIdentity);
  });

  it.each([true, false])("retains legacy and mixed-scope checkpoints without collecting (resume=%s)", async (resume) => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-night-watch-legacy-"));
    tempDirs.push(dir);
    const checkpointPath = join(dir, "samples.jsonl");
    const options = evidence().options;
    const record = {
      version: 2, collectionIdentity: createNightWatchCollectionIdentity(options), targetAt: generatedAt,
      snapshot: { mode: "d1", recentRuns: [{ status: "ok" }] },
    };
    for (const records of [
      [{ version: 1, windowStart: options.start, windowEnd: options.end, snapshot: record.snapshot }],
      [{ ...record, collectionIdentity: undefined }],
      [{ ...record, collectionIdentity: { ...record.collectionIdentity, remote: false } }],
      [record, { ...record, collectionIdentity: { ...record.collectionIdentity, remote: false } }],
    ]) {
      const original = records.map((entry) => JSON.stringify(entry)).join("\n");
      writeFileSync(checkpointPath, original);
      await expect(runCli([
        "--start", options.start, "--end", options.end, "--include-status", "--include-d1",
        "--checkpoint-jsonl", checkpointPath, ...(resume ? [] : ["--no-resume"]),
      ], { write: vi.fn() } as unknown as typeof process.stdout)).rejects.toThrow("identity mismatch");
      expect(readFileSync(checkpointPath, "utf8")).toBe(original);
    }
    expect(collectWorkerCronSnapshot).not.toHaveBeenCalled();
  });

  it("resumes completed matching local D1 targets without remote collection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-night-watch-resume-"));
    tempDirs.push(dir);
    const checkpointPath = join(dir, "samples.jsonl");
    const reportPath = join(dir, "report.md");
    const evidencePath = join(dir, "evidence.json");
    const argv = [
      "--start", generatedAt, "--end", "2026-06-24T10:15:00.000Z", "--local", "--include-d1",
      "--checkpoint-jsonl", checkpointPath, "--output", reportPath, "--evidence-json", evidencePath,
    ];
    const options = parseArgs(argv);
    const collectionIdentity = createNightWatchCollectionIdentity(options);
    persistNightWatchCheckpoint(checkpointPath, [options.start, options.end].map((targetAt) => ({
      version: 2, collectionIdentity, targetAt,
      snapshot: { mode: "d1", collectedAt: targetAt, recentRuns: [] },
    })));
    await expect(runCli(argv, { write: vi.fn() } as unknown as typeof process.stdout)).resolves.toBe(0);
    const written = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(written.snapshots).toHaveLength(2);
    expect(written.collectionIdentity).toEqual(collectionIdentity);
    expect(written.options).toMatchObject({ includeD1: true, remote: false });
    expect(readFileSync(reportPath, "utf8")).toContain("D1 local");
    expect(collectWorkerCronSnapshot).not.toHaveBeenCalled();
  });

  it.each([["--start", generatedAt], ["--end", "2026-06-24T11:00:00Z"], ["--include-d1"], ["--local"]])(
    "rejects fixture collection/window overrides %j",
    (...flags) => {
      expect(() => parseArgs(["--fixture", "saved.json", ...flags])).toThrow("preserves collection scope and window");
    },
  );

  it("keeps completed capacity findings visible even when metadata previews are truncated", () => {
    const qualityEvidence = evidence();
    Object.assign(qualityEvidence.snapshots[0]!.recentRuns[0]!, {
      job: "cron-sentinel-daily",
      quality: JSON.stringify({
        sources: { "mint-burn-growth-watchdog": { reason: "row-count-threshold" } },
      }),
      metadata_preview: '{"truncated":',
    });
    const markdown = renderNightWatchMarkdown(qualityEvidence);
    expect(markdown).toContain("cron runs reported quality warnings");
    expect(markdown).toContain("mint-burn-growth-watchdog:row-count-threshold");
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

  it("consumes the single-watch collector directly for D1 samples", async () => {
    const args = parseArgs([
      "--start", generatedAt,
      "--include-d1",
      "--include-status-history",
      "--local",
      "--cf-access-client-secret", "secret",
    ], new Date(generatedAt));
    type SnapshotCollector = NonNullable<Parameters<typeof collectD1Snapshot>[2]>;
    const collectorMock = vi.fn(async (
      options: Parameters<SnapshotCollector>[0],
      _dependencies?: Parameters<SnapshotCollector>[1],
    ): ReturnType<SnapshotCollector> => ({
      generatedAt,
      scope: options.remote ? "remote" : "local",
      probes: { statusHistory: { status: 200 } },
      recentRuns: [], slots: [], leases: [], progress: [],
    }) as unknown as Awaited<ReturnType<SnapshotCollector>>);
    const collector = collectorMock as unknown as SnapshotCollector;

    const snapshot = await collectD1Snapshot(args, 16, collector);
    expect(collectorMock).toHaveBeenCalledOnce();
    expect(collectorMock.mock.calls[0]![0]).toMatchObject({
      sinceMinutes: 16,
      limit: 120,
      remote: false,
      includeStatus: true,
      includeStatusHistory: true,
      cfAccessClientSecret: "secret",
    });
    expect(snapshot).toMatchObject({ mode: "d1", scope: "local" });

    const failed = await collectD1Snapshot(args, 16, async () => {
      throw new Error("authentication failed for secret");
    });
    expect(failed).toMatchObject({ mode: "d1-error", error: "authentication failed for [redacted]" });
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

  it("preserves historical fixture scope, window, counts and findings across delayed rendering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-night-watch-fixture-"));
    tempDirs.push(dir);
    const fixturePath = relative(process.cwd(), join(dir, "fixture.json"));
    const reportPath = relative(process.cwd(), join(dir, "fixture-report.md"));
    const evidencePath = relative(process.cwd(), join(dir, "fixture-evidence.json"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    const fixture = evidence();
    fixture.options.remote = false;
    fixture.snapshots[0]!.recentRuns[0]!.status = "error";
    fixture.snapshots[0]!.recentRuns[0]!.started_at = Date.parse(generatedAt) / 1000 + 60;
    const collectionIdentity = createNightWatchCollectionIdentity(fixture.options);
    writeFileSync(resolve(process.cwd(), fixturePath), JSON.stringify({ ...fixture, collectionIdentity }), "utf8");

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
    expect(written.options).toMatchObject({
      start: fixture.options.start, end: fixture.options.end, includeD1: true, remote: false,
      database: fixture.options.database, includeStatus: true,
    });
    expect(written.collectionIdentity).toEqual(collectionIdentity);
    expect(written.analysis.runEvidence.counts.error).toBe(1);
    expect(written.analysis.findings).toContainEqual(expect.objectContaining({ title: "1 non-ok cron run rows in collected window" }));
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    await runCli(["--fixture", fixturePath, "--output", reportPath, "--evidence-json", evidencePath],
      { write: vi.fn() } as unknown as typeof process.stdout);
    const delayed = JSON.parse(readFileSync(resolve(process.cwd(), evidencePath), "utf8"));
    expect(delayed.options).toMatchObject({ start: fixture.options.start, end: fixture.options.end, includeD1: true, remote: false });
    expect(delayed.collectionIdentity).toEqual(collectionIdentity);
    expect(delayed.analysis.runEvidence).toEqual(written.analysis.runEvidence);
    expect(delayed.analysis.findings).toEqual(written.analysis.findings);
    expect(readFileSync(resolve(process.cwd(), reportPath), "utf8")).toContain(`${fixture.options.start} to ${fixture.options.end}`);
    expect(readFileSync(resolve(process.cwd(), reportPath), "utf8")).toContain("D1 local");
    expect(readFileSync(resolve(process.cwd(), reportPath), "utf8")).toContain("Canaries report 1 errors");
  });
});
