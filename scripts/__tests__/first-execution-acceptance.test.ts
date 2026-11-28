import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePostDeployFirstExecutions as monitor, renderPostDeployFirstExecutionSummary as render, runPostDeployFirstExecutionCheck as runMonitor } from "../ci/check-post-deploy-first-execution";
import { evaluateFirstExecutionAcceptance as evaluate, runFirstExecutionAcceptanceCli as runCli } from "../lib/first-execution-acceptance.mts";

const notBefore = 1_800_000_000;
const startedAt = notBefore + 10;
const job = "sync-stablecoins";
const workerVersion = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const metadata = { workerVersion, syncStartSec: startedAt, cacheWriteMode: "published" };
const run = { startedAt, durationMs: 1_000, status: "ok", metadata };
const withRun = (attempt: unknown) => ({
  job, workerVersion, notBefore,
  status: { timestamp: notBefore + 100, job, cron: { runs: [attempt] } },
});
const input = withRun(run);
const publication = (updatedAt = startedAt) => ({ _meta: { updatedAt } });

describe("collected execution acceptance", () => {
  it("checks execution and publication", () => {
    expect(evaluate(input)).toEqual({ outcome: "passed", reason: "execution-confirmed" });
    expect(evaluate({ ...input, publishedStablecoins: publication() }))
      .toEqual({ outcome: "passed", reason: "execution-and-publication-confirmed" });
    expect(evaluate({ ...input, job: "other-job" }))
      .toEqual({ outcome: "pending", reason: "run-missing" });
  });

  it("keeps invalid evidence pending", () => {
    const patches = [
      { metadata: null }, { metadata: { workerVersion: "old" } }, { startedAt: notBefore - 1 }, { startedAt: NaN },
      ...[null, -1, Infinity, 999_999].map((durationMs) => ({ durationMs })),
      ...["running", "skipped", "deferred", null].map((status) => ({ status })),
    ];
    for (const attempt of [null, ...patches.map((patch) => ({ ...run, ...patch }))])
      expect(evaluate(withRun(attempt)).outcome).toBe("pending");
    expect(evaluate({ ...input, status: null }).outcome).toBe("pending");
    for (const publishedStablecoins of [undefined, null, {}, publication(startedAt - 1), publication(startedAt + 1)]) {
      expect(evaluate({ ...input, publishedStablecoins, requirePublication: true }).outcome).toBe("pending");
    }
    expect(evaluate({ ...withRun({ ...run, metadata: { workerVersion } }), publishedStablecoins: publication() }).outcome).toBe("pending");
  });

  it.each(["error", "failed", "degraded"])("fails a completed %s run", (status) => {
    expect(evaluate(withRun({ ...run, status })).outcome).toBe("failed");
  });

  it("requires a confirmed cache write", () => {
    for (const patch of [{ cacheWriteMode: undefined }, { cacheWriteMode: "no-write" },
      { cacheWriteMode: "skipped-newer" }, { cacheWriteSucceeded: false }]) {
      const saved = withRun({ ...run, metadata: { ...metadata, ...patch } });
      expect(evaluate({ ...saved, publishedStablecoins: publication() }).reason).toBe("publication-write-unconfirmed");
    }
    for (const fields of [{ cacheWriteSucceeded: true }, { persistenceCompaction: { overBudget: true } }]) {
      expect(evaluate({ ...withRun({ ...run, metadata: { ...metadata, ...fields } }),
        publishedStablecoins: publication() }).outcome).toBe("passed");
    }
  });

  it("rejects malformed acceptance targets", () => {
    for (const notBefore of [0, NaN, Infinity, 1.5]) expect(() => evaluate({ ...input, notBefore })).toThrow();
    expect(() => evaluate({ ...input, workerVersion: "" })).toThrow();
  });

  it("returns CLI exit codes", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/lib/first-execution-acceptance.mts", "--unexpected"]);
    expect(result.status).toBe(2);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.toString()).toBe("Acceptance input is invalid or unreadable. Use --help for required arguments.\n");
    const dir = mkdtempSync(join(tmpdir(), "pharos-acceptance-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const path = join(dir, "status.json");
      const args = ["--status", path, "--job", job, "--worker-version", workerVersion, "--not-before", String(notBefore)];
      writeFileSync(path, JSON.stringify(input.status));
      expect(runCli(args)).toBe(0);
      expect(runCli([...args, "--require-publication"])).toBe(2);
      writeFileSync(path, JSON.stringify(withRun({ ...run, status: "error" }).status));
      expect(runCli(args)).toBe(1);
      expect(() => runCli([...args, "--job", job])).toThrow();
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("post-deploy first-execution monitor", () => {
  const heavy = workerVersion.replace("aaaa", "ffff");
  const deploy = (id: string, at = notBefore) => ({ id, created_on: new Date(at * 1_000).toISOString(),
    annotations: { "workers/message": "GitHub Actions deploy " + "a".repeat(40) },
    versions: [{ version_id: id, percentage: 100 }] });
  const coins = { job, started_at: startedAt, duration_ms: 1_000, status: "ok", metadata, worker_version: workerVersion };
  const dex = { ...coins, job: "sync-dex-liquidity", metadata: null, worker_version: heavy };
  const v9 = { ...dex, job: "compute-safety-score-v9" };
  const byJob = (...rows: Array<{ job: string; [key: string]: unknown }>) => Object.groupBy(rows, (row) => row.job);
  const deployments = { "stablecoin-api": [deploy(workerVersion)], "stablecoin-heavy": [deploy(heavy)] };
  const nowSec = notBefore + 120;
  const cronRuns = byJob(coins, dex, v9);
  const check = (patch: Partial<Parameters<typeof monitor>[0]> = {}) =>
    monitor({ nowSec, lookbackSec: 21_600, deployments, cronRuns, publishedStablecoins: publication(), ...patch });

  it.each([[4_499, "pending"], [4_500, "failed"], [21_601, "skip"]] as const)("grades missing runs at age %s", (age, status) => {
    expect(check({ nowSec: notBefore + age, cronRuns: byJob(coins, v9, { ...dex, worker_version: workerVersion }) }).status).toBe(status);
  });

  it("uses the first eligible execution and the visible generation", () => {
    const skips = [
      { ...coins, status: "skipped_locked" },
      { ...dex, status: "skipped_neutral", metadata: { reason: "liquidity-cadence-reuse" } },
      { ...dex, status: "skipped_neutral", metadata: { reason: "curve-identity-unavailable" } },
      ...["v9-evaluator-changed-recapture-pending", "v9-publication-hourly-already-accepted"].map((reason) =>
        ({ ...v9, status: "skipped_neutral", metadata: { reason } })),
    ].map((row) => ({ ...row, started_at: notBefore + 1 }));
    const next = startedAt + 5;
    const publishedStablecoins = publication(next);
    expect(check({ publishedStablecoins }).status).toBe("pending");
    expect(check({ publishedStablecoins, cronRuns: byJob(...skips, coins, dex, v9,
      { ...coins, started_at: next, metadata: { ...metadata, syncStartSec: next } }) }).status).toBe("passed");
    expect(check({ cronRuns: byJob(coins, dex, v9, { ...skips[1], status: "skipped" }) }).status).toBe("failed");
  });

  it.each([
    ["active", null, "pending"], ["completed", "generation", "passed"], ["completed", null, "failed"],
    ["failed", null, "failed"], ["superseded", null, "failed"],
  ])("requires V9 seed terminal publication for %s / %s", (state, generation, status) => {
    const seed = { ...v9, productive: 0, metadata: { mode: "queue-seed", runId: "seed" }, v9_state: state,
      v9_generation: generation, v9_finished_at: state === "active" ? null : startedAt + 5, v9_worker_version: heavy };
    expect(check({ cronRuns: byJob(coins, dex, seed) }).status).toBe(status);
    expect(check({ cronRuns: byJob(coins, dex, { ...seed, v9_worker_version: workerVersion }) }).status).toBe("pending");
    if (state === "active") {
      expect(check({ nowSec: notBefore + 4_500, cronRuns: byJob(coins, dex, { ...seed, started_at: notBefore + 3_500 }) }).status).toBe("pending");
      expect(check({ nowSec: startedAt + 3_600, cronRuns: byJob(coins, dex, seed) }).status).toBe("failed");
    }
    if (state === "superseded") {
      const rep = heavy.replace("bbbb", "0000");
      const history = { ...deployments, "stablecoin-heavy": [deploy(rep, notBefore + 4_600), deploy(heavy)] };
      const lateSeed = { ...seed, started_at: notBefore + 3_500, v9_finished_at: notBefore + 4_602 };
      const repDex = { ...dex, worker_version: rep, started_at: notBefore + 4_601 };
      expect(check({ nowSec: notBefore + 4_610, deployments: history, cronRuns: byJob(coins, dex, lateSeed, repDex) }).status).toBe("pending");
      const repV9 = { ...v9, worker_version: rep, started_at: notBefore + 4_605 };
      expect(check({ nowSec: notBefore + 4_610, deployments: history, cronRuns: byJob(coins, dex, lateSeed, repDex, repV9) }).status).toBe("passed");
    }
  });

  it("retains failures before and after a success and redacts metadata", () => {
    const error = { ...dex, started_at: startedAt - 1, status: "error", metadata: '{"detail":"private-row"}' };
    const runWith = (row: object) => check({ cronRuns: byJob(coins, dex, v9, { ...error, ...row }) });
    expect(runWith({ worker_version: null }).jobs).toContainEqual(expect.objectContaining({
      outcome: "failed", reason: "unattributed-post-activation-failure",
    }));
    expect(runWith({ worker_version: workerVersion }).status).toBe("passed");
    const body = render(runWith({ started_at: startedAt + 1, status: "degraded" }), nowSec);
    expect(body).toContain("**failed**");
    expect(body).toContain("Due: 2027-01-16");
    expect(body).not.toContain("private-row");
  });

  it("retains a superseded version's failure until all replacement jobs pass", () => {
    const replacement = heavy.replace("bbbb", "0000");
    const history = { ...deployments, "stablecoin-heavy": [deploy(replacement, startedAt + 1), deploy(heavy)] };
    const error = { ...dex, status: "error" };
    const newRun = (row: typeof dex) => ({ ...row, worker_version: replacement, started_at: startedAt + 2 });
    expect(check({ deployments: history, cronRuns: byJob(coins, error, newRun(dex), v9) }).status).toBe("failed");
    const recovered = check({ deployments: history, cronRuns: byJob(coins, error, newRun(dex), newRun(v9)) });
    expect(recovered.status).toBe("passed");
    expect(recovered.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ job: dex.job, outcome: "recovered" }),
      expect.objectContaining({ job: v9.job, reason: "superseded-before-first-slot" }),
    ]));
  });

  it("rechecks aged issue scopes, preserves Due, and requires all scoped jobs to recover", () => {
    const later = notBefore + 23_000;
    const ages = { ...deployments, "stablecoin-api": [deploy(workerVersion, later)] };
    const openIssue = { number: 10, body: "Due: 2027-01-01\n" +
      "<!-- post-deploy-failed-jobs: stablecoin-heavy:sync-dex-liquidity -->" };
    const recent = { ...coins, started_at: later, metadata: { ...metadata, syncStartSec: later } };
    const args = { deployments: ages, openIssue, nowSec: later + 30, publishedStablecoins: publication(later) };
    const error = { ...dex, started_at: later, status: "error" };
    const state = (rows: typeof cronRuns) => check({ ...args, cronRuns: rows });
    expect(state({ ...byJob(recent), [dex.job]: [], [v9.job]: [] }).canCloseIssue).toBe(false);
    const failure = state({ ...byJob(recent, error), [v9.job]: [] });
    expect(failure.status).toBe("failed");
    expect(render(failure, later)).toContain(openIssue.body.split("\n")[0]);
    expect(render(failure, later)).toContain(openIssue.body.split("\n")[1]);
    const healthy = { ...dex, started_at: later + 1 };
    // Even for a DEX-only issue, every tracked job on the affected Worker must pass before closing.
    expect(state({ ...byJob(recent, error, healthy), [v9.job]: [] }).canCloseIssue).toBe(false);
    expect(state(byJob(recent, error, healthy, { ...v9, started_at: later })).canCloseIssue).toBe(true);
    expect(check({ ...args, publishedStablecoins: null, cronRuns: byJob(recent, error, healthy, { ...v9, started_at: later }) }))
      .toMatchObject({ status: "unavailable", reason: "publication-input-unavailable", canCloseIssue: false });
  });

  it("accepts Worker deployments without a CI SHA", () => {
    const verdict = check({ deployments: { ...deployments, "stablecoin-heavy": [{ ...deploy(heavy), annotations: {} }] } });
    expect(verdict.status).toBe("passed");
    expect(render(verdict, nowSec)).toContain("Worker deploy SHA unavailable");
  });

  it.each([{ deployments: {} }, { openIssue: {} }, { cronRuns: null }, { cronRuns: { ...cronRuns, [job]: [{ ...coins, metadata: "broken" }] } },
    { cronRuns: { ...cronRuns, [job]: Array(100).fill(coins) } }, { publishedStablecoins: null },
    { publishedStablecoins: null, cronRuns: byJob({ ...coins, status: "error" }, dex, v9) }])("reports unavailable evidence %#", (patch) => {
    expect(check(patch)).toMatchObject({ status: "unavailable", canCloseIssue: false });
  });

  it("reports a missing Cloudflare file at the CLI boundary", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      runMonitor(join(tmpdir(), "nonexistent-pharos-evidence"));
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ status: "unavailable", reason: "deployment-input-unavailable" });
    } finally { log.mockRestore(); }
  });
});
