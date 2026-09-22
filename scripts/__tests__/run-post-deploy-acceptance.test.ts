import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAGES_SHELL_URL,
  type PostDeployAcceptanceDependencies,
  runPostDeployAcceptance,
  runPostDeployAcceptanceCli,
  WORKER_API_URL,
} from "../ci/run-post-deploy-acceptance.ts";

interface ProbeResponse {
  latencyMs: number;
  ok: boolean;
  payload: unknown;
  status: number;
  url: string;
}

const RELEASE_URL = `${PAGES_SHELL_URL}/__pharos_release.json`;
const HEALTH_URL = `${WORKER_API_URL}/api/health`;
const RELEASE_COMMIT = "abc123";
const WORKER_VERSION = "worker-version-2";
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function pagesRelease({ ok = true, payload = { commit: RELEASE_COMMIT } as unknown, status = 200 } = {}): ProbeResponse {
  return { latencyMs: 12, ok, payload, status, url: RELEASE_URL };
}

function workerHealth({
  ok = true,
  payload = { status: "healthy" } as unknown,
  status = 200,
} = {}): ProbeResponse {
  return { latencyMs: 8, ok, payload, status, url: HEALTH_URL };
}

function dependencies({
  shell = pagesRelease(),
  health = workerHealth() as ProbeResponse | null,
} = {}) {
  const probes: Record<string, ProbeResponse> = health ? { health } : {};
  return {
    collectWorkerProbes: vi.fn(async () => probes),
    fetchJson: vi.fn(async () => shell),
  } satisfies PostDeployAcceptanceDependencies;
}

function summaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "post-deploy-acceptance-"));
  tempDirs.push(dir);
  return dir;
}

describe("runPostDeployAcceptance", () => {
  it("passes when both deployed surfaces answer their read-only probes", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies(),
      pagesDeployed: true,
      workerDeployed: true,
      expectedPagesCommit: RELEASE_COMMIT,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
    });

    expect(run.acceptance.outcome).toBe("passed");
    expect(run.exitCode).toBe(0);
    expect(run.probes.map((probe) => [probe.id, probe.surface, probe.outcome])).toEqual([
      ["pages-shell", "pages", "passed"],
      ["worker-health", "worker", "passed"],
    ]);
    expect(run.summary).toContain(`| pages-shell | pages | passed | GET ${RELEASE_URL} returned 200; release commit ${RELEASE_COMMIT}. |`);
    expect(run.summary).toContain(`| worker-health | worker | passed | GET ${HEALTH_URL} returned 200 (healthy); active version ${WORKER_VERSION}. |`);
  });

  it("probes only the Pages shell for a Pages-only release", async () => {
    const deps = dependencies();
    const run = await runPostDeployAcceptance({
      ...deps,
      pagesDeployed: true,
      expectedPagesCommit: RELEASE_COMMIT,
    });

    expect(deps.fetchJson).toHaveBeenCalledWith({ apiUrl: PAGES_SHELL_URL }, "/__pharos_release.json");
    expect(deps.collectWorkerProbes).not.toHaveBeenCalled();
    expect(run.probes.map((probe) => probe.id)).toEqual(["pages-shell"]);
    expect(run.acceptance.outcome).toBe("passed");
  });

  it("probes only the public Worker health endpoint for a Worker-only release", async () => {
    const deps = dependencies();
    const run = await runPostDeployAcceptance({
      ...deps,
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
    });

    expect(deps.collectWorkerProbes).toHaveBeenCalledWith({ apiUrl: WORKER_API_URL }, { includeHealth: true });
    expect(deps.fetchJson).not.toHaveBeenCalled();
    expect(run.probes.map((probe) => probe.id)).toEqual(["worker-health"]);
  });

  it("fails a healthy Worker when the active deployment version is stale", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies(),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: "worker-version-1",
    });

    expect(run.probes[0]).toMatchObject({ outcome: "failed" });
    expect(run.exitCode).toBe(1);
  });

  it("reports pending without probing when no surface completed deployment", async () => {
    const deps = dependencies();
    const run = await runPostDeployAcceptance(deps);

    expect(run.acceptance).toEqual({
      outcome: "pending",
      reason: "No production surface completed deployment.",
    });
    expect(run.exitCode).toBe(0);
    expect(run.probes).toEqual([]);
    expect(run.summary).not.toContain("| pages-shell |");
    expect(deps.fetchJson).not.toHaveBeenCalled();
    expect(deps.collectWorkerProbes).not.toHaveBeenCalled();
  });

  it("fails the acceptance job when Pages serves a stale release marker", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ shell: pagesRelease({ payload: { commit: "prior-release" } }) }),
      pagesDeployed: true,
      expectedPagesCommit: RELEASE_COMMIT,
    });

    expect(run.probes.map((probe) => [probe.id, probe.outcome])).toEqual([
      ["pages-shell", "failed"],
    ]);
    expect(run.acceptance.outcome).toBe("failed");
    expect(run.exitCode).toBe(1);
  });

  it("fails when the Pages release marker responds with an error status", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ shell: pagesRelease({ ok: false, status: 503 }) }),
      pagesDeployed: true,
      expectedPagesCommit: RELEASE_COMMIT,
    });

    expect(run.probes[0]).toMatchObject({ detail: `GET ${RELEASE_URL} returned 503; release commit ${RELEASE_COMMIT}.`, outcome: "failed" });
    expect(run.exitCode).toBe(1);
  });

  it("fails a reachable Worker whose health endpoint reports a non-healthy state", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: workerHealth({ payload: { status: "degraded" } }) }),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
    });

    expect(run.probes[0]).toMatchObject({
      detail: `GET ${HEALTH_URL} returned 200 (degraded); active version ${WORKER_VERSION}.`,
      outcome: "failed",
    });
    expect(run.acceptance.reason).toBe("At least one completed read-only smoke probe failed.");
    expect(run.exitCode).toBe(1);
  });

  it("fails with a zero status when the Worker health probe never completed", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: null }),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
    });

    expect(run.probes[0]).toMatchObject({
      detail: `GET ${HEALTH_URL} returned 0; active version ${WORKER_VERSION}.`,
      outcome: "failed",
    });
    expect(run.exitCode).toBe(1);
  });
});

describe("run-post-deploy-acceptance CLI", () => {
  it("records the outcome as a step output and a job summary table", async () => {
    const workDir = summaryDir();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const summaryPath = join(workDir, "summary.md");
    const outputPath = join(workDir, "github-output.txt");

    const exitCode = await runPostDeployAcceptanceCli(
      {
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        NODE_ENV: "test",
        EXPECTED_PAGES_COMMIT: RELEASE_COMMIT,
        PAGES_DEPLOYED: "true",
        WORKER_DEPLOYED: "false",
      },
      dependencies(),
    );
    const summary = readFileSync(summaryPath, "utf8");

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("outcome=passed\n");
    expect(summary).toContain("- Outcome: passed");
    expect(summary).toContain(
      "- Scope: read-only GET probes only; no production mutation or automatic rollback.",
    );
    expect(summary).toContain(`| pages-shell | pages | passed | GET ${RELEASE_URL} returned 200; release commit ${RELEASE_COMMIT}. |`);
  });

  it("returns a failing exit code and records the failed outcome for a failed probe", async () => {
    const workDir = summaryDir();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const outputPath = join(workDir, "github-output.txt");

    const exitCode = await runPostDeployAcceptanceCli(
      { GITHUB_OUTPUT: outputPath, NODE_ENV: "test", PAGES_DEPLOYED: "false", WORKER_DEPLOYED: "true",
        EXPECTED_WORKER_VERSION: WORKER_VERSION, OBSERVED_WORKER_VERSION: WORKER_VERSION },
      dependencies({ health: workerHealth({ ok: false, payload: null, status: 502 }) }),
    );

    expect(exitCode).toBe(1);
    expect(readFileSync(outputPath, "utf8")).toBe("outcome=failed\n");
  });
});
