import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ActiveWorkerDeployment,
  type ListedWorkerDeployment,
  selectWorkerActivationAt,
  verifyActiveWorkerDeployment,
  workerDeployMessage,
} from "../ci/verify-worker-deployment.ts";

const SHA = "1f2e3d4c5b6a7988990011223344556677889900";
const SCRIPT = resolve(process.cwd(), "scripts/ci/verify-worker-deployment.ts");
const ACTIVATED_AT = "2026-03-01T08:15:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-worker-deployment-"));
  tempDirs.push(dir);
  return dir;
}

function activeDeployment(overrides: ActiveWorkerDeployment = {}): ActiveWorkerDeployment {
  return {
    annotations: { "workers/message": workerDeployMessage(SHA) },
    id: "deployment-2",
    versions: [{ percentage: 100, version_id: "version-2" }],
    ...overrides,
  };
}

/** Newest-first history whose target deployment shares a timestamp with another. */
function unorderedHistory(): ListedWorkerDeployment[] {
  return [
    { created_on: "2026-03-02T09:00:00.000Z", id: "deployment-3", versions: [{ version_id: "version-3" }] },
    { created_on: ACTIVATED_AT, id: "deployment-1", versions: [{ version_id: "version-1" }] },
    { created_on: ACTIVATED_AT, id: "deployment-2", versions: [{ version_id: "version-2" }] },
  ];
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function runCli(env: Record<string, string | undefined>) {
  const outputPath = join(tempDir(), "github-output.txt");
  writeFileSync(outputPath, "");
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath, GITHUB_SHA: SHA, ...env },
    },
  );
  return { ...result, githubOutput: readFileSync(outputPath, "utf8") };
}

describe("verifyActiveWorkerDeployment", () => {
  it("accepts the SHA-tagged deployment when it is the sole version at full traffic", () => {
    expect(verifyActiveWorkerDeployment(activeDeployment(), workerDeployMessage(SHA))).toEqual({
      deploymentId: "deployment-2",
      workerVersion: "version-2",
    });
  });

  it.each<[string, ActiveWorkerDeployment]>([
    ["a gradual rollout still splits traffic", {
      versions: [{ percentage: 60, version_id: "version-2" }, { percentage: 40, version_id: "version-1" }],
    }],
    ["the single active version is below full traffic", {
      versions: [{ percentage: 95, version_id: "version-2" }],
    }],
    ["no version is active at all", { versions: [] }],
    ["the active version carries no identity", { versions: [{ percentage: 100 }] }],
    ["the deployment was made for another commit", {
      annotations: { "workers/message": workerDeployMessage("0".repeat(40)) },
    }],
    ["the deployment carries no release message", { annotations: {} }],
  ])("fails the release when %s", (_case, overrides) => {
    expect(() => verifyActiveWorkerDeployment(activeDeployment(overrides), workerDeployMessage(SHA)))
      .toThrow(/Active Worker deployment did not match this release/);
  });

  it("reports the observed deployment identity and message when the release does not match", () => {
    expect(() =>
      verifyActiveWorkerDeployment(
        activeDeployment({ annotations: { "workers/message": "manual wrangler deploy" } }),
        workerDeployMessage(SHA),
      ),
    ).toThrow(/"deploymentId":"deployment-2".*"message":"manual wrangler deploy"/);
  });
});

describe("selectWorkerActivationAt", () => {
  it("uses the verified deployment's created_on from unordered history with a duplicate timestamp", () => {
    expect(selectWorkerActivationAt({
      deploymentId: "deployment-2",
      deployments: unorderedHistory(),
      workerVersion: "version-2",
    })).toEqual({
      activationAtSec: Date.parse(ACTIVATED_AT) / 1000,
      createdOn: ACTIVATED_AT,
    });
  });

  it("floors sub-second precision to the second the deployment became active", () => {
    expect(selectWorkerActivationAt({
      deploymentId: "deployment-2",
      deployments: [
        { created_on: "2026-03-01T08:15:00.940Z", id: "deployment-2", versions: [{ version_id: "version-2" }] },
      ],
      workerVersion: "version-2",
    }).activationAtSec).toBe(Date.parse(ACTIVATED_AT) / 1000);
  });

  it.each<[string, ListedWorkerDeployment[]]>([
    ["the deployment is absent from the history", [
      { created_on: "2026-03-02T09:00:00.000Z", id: "deployment-3", versions: [{ version_id: "version-3" }] },
    ]],
    ["the matched deployment lists a different version", [
      { created_on: ACTIVATED_AT, id: "deployment-2", versions: [{ version_id: "version-1" }] },
    ]],
    ["the matched deployment lists no versions", [{ created_on: ACTIVATED_AT, id: "deployment-2" }]],
    ["the matched deployment has no created_on", [
      { id: "deployment-2", versions: [{ version_id: "version-2" }] },
    ]],
    ["created_on is not a parseable instant", [
      { created_on: "not-a-timestamp", id: "deployment-2", versions: [{ version_id: "version-2" }] },
    ]],
    ["created_on predates the epoch", [
      { created_on: "1969-12-31T00:00:00.000Z", id: "deployment-2", versions: [{ version_id: "version-2" }] },
    ]],
    ["the history is empty", []],
  ])("skips the activation marker when %s", (_case, deployments) => {
    expect(selectWorkerActivationAt({
      deploymentId: "deployment-2",
      deployments,
      workerVersion: "version-2",
    }).activationAtSec).toBeNull();
  });

  it("skips the activation marker when the active deployment has no identity to match", () => {
    expect(selectWorkerActivationAt({
      deploymentId: null,
      deployments: [{ created_on: ACTIVATED_AT, versions: [{ version_id: "version-2" }] }],
      workerVersion: "version-2",
    }).activationAtSec).toBeNull();
  });
});

describe("verify-worker-deployment CLI", () => {
  it("publishes the verified version and Cloudflare activation second as step outputs", () => {
    const workDir = tempDir();
    const result = runCli({
      DEPLOYMENTS_FILE: writeJson(workDir, "deployments.json", unorderedHistory()),
      DEPLOYMENT_HISTORY_AVAILABLE: "true",
      DEPLOYMENT_STATUS_FILE: writeJson(workDir, "status.json", activeDeployment()),
    });

    expect(result.status).toBe(0);
    expect(result.githubOutput).toBe(
      `worker_version=version-2\nworker_activation_at=${Date.parse(ACTIVATED_AT) / 1000}\n`,
    );
    expect(result.stdout).toContain(`created_on=${ACTIVATED_AT}`);
  });

  it("publishes the version without an activation second when deployment history is unavailable", () => {
    const workDir = tempDir();
    const result = runCli({
      DEPLOYMENTS_FILE: join(workDir, "missing-deployments.json"),
      DEPLOYMENT_HISTORY_AVAILABLE: "false",
      DEPLOYMENT_STATUS_FILE: writeJson(workDir, "status.json", activeDeployment()),
    });

    expect(result.status).toBe(0);
    expect(result.githubOutput).toBe("worker_version=version-2\n");
    expect(result.stdout).toContain(
      "::warning::Cloudflare deployment deployment-2 had no valid matching created_on",
    );
  });

  it("warns and skips the marker when the deployment history file is unreadable JSON", () => {
    const workDir = tempDir();
    const deploymentsFile = join(workDir, "deployments.json");
    writeFileSync(deploymentsFile, "<html>gateway timeout</html>");
    const result = runCli({
      DEPLOYMENTS_FILE: deploymentsFile,
      DEPLOYMENT_HISTORY_AVAILABLE: "true",
      DEPLOYMENT_STATUS_FILE: writeJson(workDir, "status.json", activeDeployment()),
    });

    expect(result.status).toBe(0);
    expect(result.githubOutput).toBe("worker_version=version-2\n");
    expect(result.stdout).toContain("::warning::Cloudflare deployment history JSON was unavailable");
  });

  it("fails the deploy job and records no outputs when the active deployment does not match", () => {
    const workDir = tempDir();
    const result = runCli({
      DEPLOYMENTS_FILE: writeJson(workDir, "deployments.json", unorderedHistory()),
      DEPLOYMENT_HISTORY_AVAILABLE: "true",
      DEPLOYMENT_STATUS_FILE: writeJson(workDir, "status.json", activeDeployment({
        versions: [{ percentage: 100, version_id: "version-2" }, { percentage: 0, version_id: "version-1" }],
      })),
    });

    expect(result.status).not.toBe(0);
    expect(result.githubOutput).toBe("");
    expect(result.stderr).toContain("Active Worker deployment did not match this release");
  });

  it("fails when the deploy step captured no deployment status file", () => {
    const result = runCli({ DEPLOYMENT_HISTORY_AVAILABLE: "false" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DEPLOYMENT_STATUS_FILE");
  });
});
