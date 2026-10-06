import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveWorkerDeployment,
  type ListedWorkerDeployment,
  fetchWorkerDeployments,
  readWorkerScriptName,
  runWorkerDeploymentVerification,
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

describe("Cloudflare deployment API verification", () => {
  function apiFixture(deployments: (ActiveWorkerDeployment & ListedWorkerDeployment & {
    source?: string; strategy?: string;
  })[] = [
    { ...activeDeployment(), created_on: ACTIVATED_AT, source: "api", strategy: "percentage" },
    ...unorderedHistory(),
  ]) {
    // Official Workers deployments list envelope, not Wrangler's flattened JSON.
    return { success: true, errors: [], messages: [], result: { deployments } };
  }

  function apiEnv(): NodeJS.ProcessEnv {
    return {
      NODE_ENV: "test",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-token",
      GITHUB_OUTPUT: join(tempDir(), "github-output.txt"),
      GITHUB_SHA: SHA,
    };
  }

  it("reads the script name from the production Wrangler config", () => {
    expect(readWorkerScriptName()).toBe("stablecoin-api");
  });

  it("uses one authenticated GET for active status and history and publishes the activation second", async () => {
    const env = apiEnv();
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(Response.json(apiFixture()));
    await runWorkerDeploymentVerification(env, fetchApi);

    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/test-account/workers/scripts/stablecoin-api/deployments",
      {
        headers: { Authorization: "Bearer test-token" },
        signal: expect.any(AbortSignal),
      },
    );
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe(
      `worker_version=version-2\nworker_activation_at=${Date.parse(ACTIVATED_AT) / 1000}\n`,
    );
  });

  it("uses the first API entry as active even when a later entry has a newer timestamp", async () => {
    const env = apiEnv();
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(Response.json(apiFixture()));
    await runWorkerDeploymentVerification(env, fetchApi);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toContain(
      `worker_activation_at=${Date.parse(ACTIVATED_AT) / 1000}`,
    );
  });

  it("keeps version verification but skips the D1 marker when created_on is invalid", async () => {
    const env = apiEnv();
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(apiFixture([{ ...activeDeployment(), created_on: "invalid", source: "api", strategy: "percentage" }])),
    );
    await runWorkerDeploymentVerification(env, fetchApi);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("worker_version=version-2\n");
  });

  it.each<[string, () => Response, RegExp]>([
    ["HTTP error", () => new Response("unavailable", { status: 503 }), /HTTP 503/],
    ["API failure", () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), /unsuccessful or malformed/],
    ["missing history", () => Response.json({ success: true, result: {} }), /unsuccessful or malformed/],
    ["Wrangler array", () => Response.json(unorderedHistory()), /unsuccessful or malformed/],
    ["empty history", () => Response.json(apiFixture([])), /history is empty/],
    ["invalid JSON", () => new Response("<html>gateway timeout</html>"), /JSON/],
  ])("fails closed without outputs on %s", async (_case, response, error) => {
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow(error);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
  });

  it("fails with no outputs when the first deployment does not match the release SHA", async () => {
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fixture = apiFixture();
    fixture.result.deployments[0].annotations = { "workers/message": workerDeployMessage("other-sha") };
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    await expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow(/did not match this release/);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
  });

  it("propagates network failures instead of claiming history or active identity is available", async () => {
    const fetchApi = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    await expect(fetchWorkerDeployments(apiEnv(), fetchApi)).rejects.toThrow("network unavailable");
  });

  it.each(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GITHUB_SHA"])(
    "requires %s before requesting production",
    async (key) => {
      const env = apiEnv();
      delete env[key];
      const fetchApi = vi.fn<typeof fetch>();
      await expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow(key);
      expect(fetchApi).not.toHaveBeenCalled();
    },
  );
});

describe("verify-worker-deployment CLI", () => {
  it("fails without credentials using Node alone, before any production request", () => {
    const result = runCli({ CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: undefined });
    expect(result.status).not.toBe(0);
    expect(result.githubOutput).toBe("");
    expect(result.stderr).toContain("CLOUDFLARE_ACCOUNT_ID");
  });
});
