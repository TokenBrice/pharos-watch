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

const SHELL_URL = `${PAGES_SHELL_URL}/`;
const HEALTH_URL = `${WORKER_API_URL}/api/health`;
const HTML_SHELL = "<!doctype html><html lang=\"en\"><body>Pharos</body></html>";
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function pagesShell({ ok = true, payload = HTML_SHELL as unknown, status = 200 } = {}): ProbeResponse {
  return { latencyMs: 12, ok, payload, status, url: SHELL_URL };
}

function workerHealth({
  ok = true,
  payload = { status: "healthy" } as unknown,
  status = 200,
} = {}): ProbeResponse {
  return { latencyMs: 8, ok, payload, status, url: HEALTH_URL };
}

function dependencies({
  shell = pagesShell(),
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
    const run = await runPostDeployAcceptance({ ...dependencies(), pagesDeployed: true, workerDeployed: true });

    expect(run.acceptance.outcome).toBe("passed");
    expect(run.exitCode).toBe(0);
    expect(run.probes.map((probe) => [probe.id, probe.surface, probe.outcome])).toEqual([
      ["pages-shell", "pages", "passed"],
      ["worker-health", "worker", "passed"],
    ]);
    expect(run.summary).toContain(`| pages-shell | pages | passed | GET ${SHELL_URL} returned 200. |`);
    expect(run.summary).toContain(`| worker-health | worker | passed | GET ${HEALTH_URL} returned 200 (healthy). |`);
  });

  it("probes only the Pages shell for a Pages-only release", async () => {
    const deps = dependencies();
    const run = await runPostDeployAcceptance({ ...deps, pagesDeployed: true });

    expect(deps.fetchJson).toHaveBeenCalledWith({ apiUrl: PAGES_SHELL_URL }, "/");
    expect(deps.collectWorkerProbes).not.toHaveBeenCalled();
    expect(run.probes.map((probe) => probe.id)).toEqual(["pages-shell"]);
    expect(run.acceptance.outcome).toBe("passed");
  });

  it("probes only the public Worker health endpoint for a Worker-only release", async () => {
    const deps = dependencies();
    const run = await runPostDeployAcceptance({ ...deps, workerDeployed: true });

    expect(deps.collectWorkerProbes).toHaveBeenCalledWith({ apiUrl: WORKER_API_URL }, { includeHealth: true });
    expect(deps.fetchJson).not.toHaveBeenCalled();
    expect(run.probes.map((probe) => probe.id)).toEqual(["worker-health"]);
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

  it("fails the acceptance job when a served shell is not an HTML document", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ shell: pagesShell({ payload: { error: "not found" } }) }),
      pagesDeployed: true,
      workerDeployed: true,
    });

    expect(run.probes.map((probe) => [probe.id, probe.outcome])).toEqual([
      ["pages-shell", "failed"],
      ["worker-health", "passed"],
    ]);
    expect(run.acceptance.outcome).toBe("failed");
    expect(run.exitCode).toBe(1);
  });

  it("fails when the Pages shell responds with an error status", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ shell: pagesShell({ ok: false, payload: HTML_SHELL, status: 503 }) }),
      pagesDeployed: true,
    });

    expect(run.probes[0]).toMatchObject({ detail: `GET ${SHELL_URL} returned 503.`, outcome: "failed" });
    expect(run.exitCode).toBe(1);
  });

  it("fails a reachable Worker whose health endpoint reports a non-healthy state", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: workerHealth({ payload: { status: "degraded" } }) }),
      workerDeployed: true,
    });

    expect(run.probes[0]).toMatchObject({
      detail: `GET ${HEALTH_URL} returned 200 (degraded).`,
      outcome: "failed",
    });
    expect(run.acceptance.reason).toBe("At least one completed read-only smoke probe failed.");
    expect(run.exitCode).toBe(1);
  });

  it("fails with a zero status when the Worker health probe never completed", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: null }),
      workerDeployed: true,
    });

    expect(run.probes[0]).toMatchObject({ detail: `GET ${HEALTH_URL} returned 0.`, outcome: "failed" });
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
    expect(summary).toContain(`| pages-shell | pages | passed | GET ${SHELL_URL} returned 200. |`);
  });

  it("returns a failing exit code and records the failed outcome for a failed probe", async () => {
    const workDir = summaryDir();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const outputPath = join(workDir, "github-output.txt");

    const exitCode = await runPostDeployAcceptanceCli(
      { GITHUB_OUTPUT: outputPath, NODE_ENV: "test", PAGES_DEPLOYED: "false", WORKER_DEPLOYED: "true" },
      dependencies({ health: workerHealth({ ok: false, payload: null, status: 502 }) }),
    );

    expect(exitCode).toBe(1);
    expect(readFileSync(outputPath, "utf8")).toBe("outcome=failed\n");
  });
});
