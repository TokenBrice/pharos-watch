import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function routeResponse(path: string, status = 200): ProbeResponse {
  return { latencyMs: 3, ok: status >= 200 && status < 300, payload: null, status, url: `${WORKER_API_URL}${path}` };
}

function dependencies({
  shell = pagesRelease(),
  health = workerHealth() as ProbeResponse | null,
  routes = {} as Record<string, ProbeResponse>,
} = {}) {
  const probes: Record<string, ProbeResponse> = health ? { health } : {};
  return {
    collectWorkerProbes: vi.fn(async () => probes),
    fetchJson: vi.fn(async (_args: unknown, path: string) =>
      path === "/__pharos_release.json" ? shell : routes[path] ?? routeResponse(path)),
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
      apiKey: "ci-key",
    });

    expect(run.acceptance.outcome).toBe("passed");
    expect(run.exitCode).toBe(0);
    expect(run.probes.map((probe) => [probe.id, probe.surface, probe.outcome])).toEqual([
      ["pages-shell", "pages", "passed"],
      ["worker-health", "worker", "passed"],
      ["worker-route-sweep", "worker", "passed"],
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

  it("probes Worker health and sweeps public routes with the CI key for a Worker-only release", async () => {
    const deps = dependencies();
    const run = await runPostDeployAcceptance({
      ...deps,
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(deps.collectWorkerProbes).toHaveBeenCalledWith({ apiUrl: WORKER_API_URL }, { includeHealth: true });
    expect(deps.fetchJson).toHaveBeenCalledWith(
      { apiUrl: WORKER_API_URL, apiKey: "ci-key", timeoutMs: 10_000, noCache: true },
      "/api/stablecoins",
    );
    expect(run.probes.map((probe) => probe.id)).toEqual(["worker-health", "worker-route-sweep"]);
    expect(deps.fetchJson.mock.calls).toHaveLength(39);
  });

  it("fails a healthy Worker when the active deployment version is stale", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies(),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: "worker-version-1",
    });

    expect(run.probes[0]).toMatchObject({ outcome: "failed" });
    expect(run.acceptance.failureKind).toBe("deployment");
    expect(run.acceptance.reason).toContain("worker active version");
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
    expect(run.acceptance.failureKind).toBe("deployment");
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

  it("passes a reachable Worker whose health is degraded and records its warnings", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: workerHealth({ payload: { status: "degraded", warnings: ["cache-quality-degraded: yield-data:producer-degraded-since-last-clean-run"] } }) }),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(run.probes[0]).toMatchObject({
      detail: `GET ${HEALTH_URL} returned 200 (degraded); active version ${WORKER_VERSION}. Warnings: cache-quality-degraded: yield-data:producer-degraded-since-last-clean-run`,
      outcome: "passed",
    });
    expect(run.exitCode).toBe(0);
  });

  it("fails a reachable Worker whose health endpoint reports the surface stale", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: workerHealth({ payload: { status: "stale" } }) }),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(run.probes[0]).toMatchObject({
      detail: `GET ${HEALTH_URL} returned 200 (stale); active version ${WORKER_VERSION}.`,
      outcome: "failed",
    });
    expect(run.acceptance).toMatchObject({ outcome: "failed", failureKind: "operational" });
    expect(run.acceptance.reason.startsWith("activated; operational acceptance failed")).toBe(true);
    expect(run.acceptance.reason).toContain("worker-health");
    expect(run.acceptance.reason).toContain("stale");
    expect(run.acceptance.reason).toContain("200");
    expect(run.exitCode).toBe(1);
  });

  it("fails with a zero status when the Worker health probe never completed", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: null }),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(run.probes[0]).toMatchObject({
      detail: `GET ${HEALTH_URL} returned 0; active version ${WORKER_VERSION}.`,
      outcome: "failed",
    });
    expect(run.exitCode).toBe(1);
  });
  it("names health components without confusing successful markers with deployment failure", async () => {
    const warnings = ["db-unhealthy", "yield-data:coverage", "prices:stale", "DEWS sentinel:future"];
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: workerHealth({ payload: { status: "stale", warnings } }) }),
      pagesDeployed: true,
      workerDeployed: true,
      expectedPagesCommit: RELEASE_COMMIT,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      expectedHeavyWorkerVersion: "heavy-version",
      observedHeavyWorkerVersion: "heavy-version",
      apiKey: "ci-key",
    });
    expect(run.acceptance).toMatchObject({ outcome: "failed", failureKind: "operational" });
    expect(run.exitCode).toBe(1);
    for (const warning of warnings) expect(run.summary).toContain(warning);
    expect(run.acceptance.reason).toContain("activated; operational acceptance failed:");
    expect(run.probes.map((probe) => probe.id)).toEqual(["pages-shell", "worker-health", "worker-route-sweep"]);
  });

  it("classifies a heavy identity mismatch as deployment failure even if health is stale", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ health: workerHealth({ payload: { status: "stale" } }) }),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      expectedHeavyWorkerVersion: "heavy-version",
      observedHeavyWorkerVersion: "prior-heavy-version",
    });
    expect(run.acceptance).toMatchObject({ outcome: "failed", failureKind: "deployment" });
    expect(run.acceptance.reason).toContain("heavy worker active version");
    expect(run.exitCode).toBe(1);
    expect(run.probes.map((probe) => probe.id)).toEqual(["worker-health", "worker-route-sweep"]);
  });

  it("fails acceptance as operational when a swept public route returns 5xx", async () => {
    const run = await runPostDeployAcceptance({
      ...dependencies({ routes: { "/api/depeg-events": routeResponse("/api/depeg-events", 503) } }),
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(run.acceptance).toMatchObject({ outcome: "failed", failureKind: "operational" });
    expect(run.acceptance.reason).toContain("/api/depeg-events");
    expect(run.acceptance.reason).toContain("http-5xx");
    expect(run.summary).toContain("| worker-route-sweep | worker | failed |");
    expect(run.exitCode).toBe(1);
  });

  it("retries a single 5xx once before passing the route sweep", async () => {
    const deps = dependencies();
    let attempts = 0;
    deps.fetchJson.mockImplementation(async (_args: unknown, path: string) => {
      if (path !== "/api/depeg-events") return routeResponse(path);
      attempts += 1;
      return routeResponse(path, attempts === 1 ? 503 : 200);
    });
    const run = await runPostDeployAcceptance({
      ...deps,
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(attempts).toBe(2);
    expect(run.probes.find((probe) => probe.id === "worker-route-sweep")).toMatchObject({ outcome: "passed" });
    expect(run.acceptance.outcome).toBe("passed");
    expect(run.exitCode).toBe(0);
  });

  it("fails when a 5xx persists after one retry", async () => {
    const deps = dependencies();
    let attempts = 0;
    deps.fetchJson.mockImplementation(async (_args: unknown, path: string) => {
      if (path !== "/api/depeg-events") return routeResponse(path);
      attempts += 1;
      return routeResponse(path, 503);
    });
    const run = await runPostDeployAcceptance({
      ...deps,
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(attempts).toBe(2);
    expect(run.probes.find((probe) => probe.id === "worker-route-sweep")).toMatchObject({ outcome: "failed" });
    expect(run.acceptance).toMatchObject({ outcome: "failed", failureKind: "operational" });
    expect(run.acceptance.reason).toContain("http-5xx");
    expect(run.exitCode).toBe(1);
  });

  it("keeps a rate-limited route unknown instead of passing or failing the release", async () => {
    const deps = dependencies();
    let attempts = 0;
    deps.fetchJson.mockImplementation(async (_args: unknown, path: string) => {
      if (path !== "/api/depeg-events") return routeResponse(path);
      attempts += 1;
      return routeResponse(path, 429);
    });
    const run = await runPostDeployAcceptance({
      ...deps,
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
      apiKey: "ci-key",
    });

    expect(attempts).toBe(1);
    expect(run.probes.find((probe) => probe.id === "worker-route-sweep")).toMatchObject({ outcome: "pending" });
    expect(run.acceptance.outcome).toBe("pending");
    expect(run.exitCode).toBe(0);
    expect(run.summary).toContain("rate-limited");
  });

  it("fails the route sweep when the CI API key is missing instead of treating anonymous 401s as healthy", async () => {
    const deps = dependencies();
    const run = await runPostDeployAcceptance({
      ...deps,
      workerDeployed: true,
      expectedWorkerVersion: WORKER_VERSION,
      observedWorkerVersion: WORKER_VERSION,
    });

    expect(run.acceptance).toMatchObject({ outcome: "failed", failureKind: "operational" });
    expect(run.acceptance.reason).toContain("missing PHAROS_API_KEY");
    expect(deps.fetchJson).not.toHaveBeenCalled();
    expect(run.exitCode).toBe(1);
  });
});

describe("run-post-deploy-acceptance CLI", () => {
  it.each<[string, string | undefined, string | undefined, number]>([
    ["verified API identity matches", WORKER_VERSION, WORKER_VERSION, 0],
    ["observed API identity is missing", WORKER_VERSION, undefined, 1],
    ["expected deploy identity is missing", undefined, WORKER_VERSION, 1],
    ["active API version changed", WORKER_VERSION, "another-version", 1],
  ])("preserves the Worker identity gate when %s", async (_case, expected, observed, expectedExit) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = await runPostDeployAcceptanceCli(
      {
        NODE_ENV: "test",
        PAGES_DEPLOYED: "false",
        WORKER_DEPLOYED: "true",
        EXPECTED_WORKER_VERSION: expected,
        OBSERVED_WORKER_VERSION: observed,
        PHAROS_API_KEY: "ci-key",
      },
      dependencies(),
    );
    expect(exitCode).toBe(expectedExit);
    const { acceptance } = JSON.parse(String(log.mock.calls[0][0]));
    expect(acceptance.outcome).toBe(expectedExit === 0 ? "passed" : "failed");
    if (expectedExit === 0) {
      expect(acceptance.failureKind).toBeUndefined();
    } else {
      expect(acceptance.failureKind).toBe("deployment");
      expect(acceptance.reason).toContain("worker active version");
    }
  });

  it("returns a failing exit code and summarizes failed probes without writing Actions outputs", async () => {
    const workDir = summaryDir();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const outputPath = join(workDir, "github-output.txt");
    const summaryPath = join(workDir, "summary.md");

    const exitCode = await runPostDeployAcceptanceCli(
      { GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath, NODE_ENV: "test", PAGES_DEPLOYED: "false", WORKER_DEPLOYED: "true",
        EXPECTED_WORKER_VERSION: WORKER_VERSION, OBSERVED_WORKER_VERSION: WORKER_VERSION, PHAROS_API_KEY: "ci-key" },
      dependencies({ health: workerHealth({ ok: false, payload: null, status: 502 }) }),
    );

    expect(exitCode).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("- Outcome: failed");
    expect(summary).toContain("activated; operational acceptance failed");
    expect(summary).toContain("worker-health");
    expect(summary).toContain("unreadable");
    expect(summary).toContain("502");
    expect(summary).toContain("| Probe | Surface | Outcome | Evidence |");
  });
});
