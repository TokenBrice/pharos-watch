import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePostDeployFirstExecutions as monitor, renderPostDeployFirstExecutionSummary as render } from "../ci/check-post-deploy-first-execution";
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
    for (const patch of [{ cacheWriteMode: undefined }, { cacheWriteMode: "no-write" }, { cacheWriteSucceeded: false }]) {
      const saved = withRun({ ...run, metadata: { ...metadata, ...patch } });
      expect(evaluate({ ...saved, publishedStablecoins: publication() }).reason).toBe("publication-write-unconfirmed");
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
  const deploy = (id: string) => [{ id, created_on: new Date(notBefore * 1_000).toISOString(),
    annotations: { "workers/message": "GitHub Actions deploy " + "a".repeat(40) },
    versions: [{ version_id: id, percentage: 100 }] }];
  const coins = { job, started_at: startedAt, duration_ms: 1_000, status: "ok", metadata, worker_version: workerVersion };
  const dex = { ...coins, job: "sync-dex-liquidity", metadata: null, worker_version: heavy };
  const v9 = { ...dex, job: "compute-safety-score-v9" };
  const saved = { nowSec: notBefore + 120, lookbackSec: 21_600,
    deployments: { "stablecoin-api": deploy(workerVersion), "stablecoin-heavy": deploy(heavy) },
    cronRuns: [coins, dex, v9], publishedStablecoins: publication() };
  const check = (patch: Partial<Parameters<typeof monitor>[0]> = {}) => monitor({ ...saved, ...patch });

  it.each([[4_499, "pending"], [4_500, "failed"], [21_601, "skip"]] as const)("grades missing runs at age %s", (age, status) => {
    expect(check({ nowSec: notBefore + age, cronRuns: [coins, v9, { ...dex, worker_version: workerVersion }] }).status).toBe(status);
  });

  it("passes after publication advances and V9 recaptures", () => {
    const later = { ...coins, started_at: startedAt + 5, metadata: { ...metadata, syncStartSec: startedAt + 5 } };
    const recapture = { ...v9, started_at: notBefore + 1, status: "skipped_neutral",
      metadata: { reason: "v9-evaluator-changed-recapture-pending" } };
    const publishedStablecoins = publication(startedAt + 5);
    expect(check().status).toBe("passed");
    expect(check({ publishedStablecoins }).status).toBe("pending");
    expect(check({ publishedStablecoins, cronRuns: [later, recapture, ...saved.cronRuns] }).status).toBe("passed");
  });

  it("keeps failures and redacts metadata", () => {
    for (const [offset, status] of [[-1, "error"], [1, "degraded"]] as const) {
      const attempt = { ...dex, started_at: startedAt + offset, status, metadata: '{"detail":"private-row"}' };
      const verdict = check({ cronRuns: [...saved.cronRuns, attempt] });
      expect(verdict.status).toBe("failed");
      const body = render(verdict, saved.nowSec);
      for (const field of ["Due: 2027-01-16", "Origin:", "Check:", "Done when:"]) expect(body).toContain(field);
      expect(body).not.toContain("private-row");
    }
  });

  it.each([{ deployments: {} }, { cronRuns: null }, { cronRuns: [{ ...coins, metadata: "broken" }] },
    { publishedStablecoins: null }])("fails closed on %j", (patch) => {
    expect(check(patch).status).toBe("failed");
  });
});
