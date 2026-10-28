import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveWorkerDeployment,
  type ListedWorkerDeployment,
  fetchWorkerDeployments,
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
  vi.useRealTimers();
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

  it("uses one authenticated GET when already active and publishes the activation second", async () => {
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

  it.each(["stablecoin-heavy", "stablecoin-api"])("proves the requested %s script's first-ever sole 100% deployment", async (scriptName) => {
    const env = apiEnv();
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(Response.json(apiFixture([
      { ...activeDeployment(), created_on: ACTIVATED_AT },
    ])));
    await runWorkerDeploymentVerification(env, fetchApi, scriptName);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(String(fetchApi.mock.calls[0][0])).toContain(`/workers/scripts/${scriptName}/deployments`);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toContain("worker_version=version-2");
  });

  it("polls until the SHA-tagged deployment is the sole version at 100%", async () => {
    vi.useFakeTimers();
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fetchApi = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Response.json(apiFixture([activeDeployment({
        annotations: { "workers/message": workerDeployMessage("other-sha") },
      })])))
      .mockImplementationOnce(async () => Response.json(apiFixture([activeDeployment({
        versions: [{ percentage: 90, version_id: "version-2" }, { percentage: 10, version_id: "version-1" }],
      })])))
      .mockImplementation(async () => Response.json(apiFixture()));
    const verification = runWorkerDeploymentVerification(env, fetchApi, "stablecoin-heavy");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchApi).toHaveBeenCalledTimes(2);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
    await vi.advanceTimersByTimeAsync(10_000);
    await verification;
    expect(fetchApi).toHaveBeenCalledTimes(3);
    expect(String(fetchApi.mock.calls[2][0])).toContain("/workers/scripts/stablecoin-heavy/deployments");
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toContain("worker_version=version-2");
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
    ["authentication error", () => new Response("unauthorized", { status: 401 }), /HTTP 401/],
    ["HTTP error", () => new Response("unavailable", { status: 503 }), /HTTP 503/],
    ["API failure", () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), /unsuccessful or malformed/],
    ["missing history", () => Response.json({ success: true, result: {} }), /unsuccessful or malformed/],
    ["Wrangler array", () => Response.json(unorderedHistory()), /unsuccessful or malformed/],
    ["malformed deployment identity", () => Response.json({
      success: true, result: { deployments: [{ ...activeDeployment(), id: 123 }] },
    }), /unsuccessful or malformed/],
    ["malformed deployment annotations", () => Response.json({
      success: true, result: { deployments: [{ ...activeDeployment(), annotations: [] }] },
    }), /unsuccessful or malformed/],
    ["malformed active deployment", () => Response.json({
      success: true, result: { deployments: [{ versions: "invalid" }] },
    }), /unsuccessful or malformed/],
    ["malformed active version", () => Response.json({
      success: true, result: { deployments: [{ versions: [{ percentage: "100", version_id: "version-2" }] }] },
    }), /unsuccessful or malformed/],
    ["empty history", () => Response.json(apiFixture([])), /history is empty/],
    ["invalid JSON", () => new Response("<html>gateway timeout</html>"), /JSON/],
  ])("fails closed without outputs on %s", async (_case, response, error) => {
    vi.useFakeTimers();
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow(error);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
  });

  it("exhausts the 60-second deadline with no outputs and names the last observed identity", async () => {
    vi.useFakeTimers();
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fetchApi = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(apiFixture([
      activeDeployment({
        id: `deployment-${fetchApi.mock.calls.length}`,
        annotations: { "workers/message": workerDeployMessage("other-sha") },
        versions: [{ percentage: 100, version_id: "old-version" }],
      }),
    ])));
    const rejected = expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow(
      /60.*deployment-6.*other-sha.*old-version/,
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchApi).toHaveBeenCalledTimes(6);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetchApi).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
  });

  it("names the last observed identity if the final API request reaches the deadline", async () => {
    vi.useFakeTimers();
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fetchApi = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (fetchApi.mock.calls.length === 6) {
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("request timed out")), 10_000));
      }
      return Response.json(apiFixture([activeDeployment({ id: "last-observed", annotations: {} })]));
    });
    const rejected = expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow(/60.*last-observed/);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(fetchApi).toHaveBeenCalledTimes(6);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
  });

  it("does not publish a matching response that arrives after the deadline", async () => {
    vi.useFakeTimers();
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fetchApi = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 60_001));
      return Response.json(apiFixture());
    });
    const rejected = expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow(/60.*deployment-2/);
    await vi.advanceTimersByTimeAsync(60_001);
    await rejected;
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
  });

  it("propagates network failures instead of claiming history or active identity is available", async () => {
    vi.useFakeTimers();
    const env = apiEnv();
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const fetchApi = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    await expect(fetchWorkerDeployments(env, fetchApi)).rejects.toThrow("network unavailable");
    fetchApi.mockClear();
    await expect(runWorkerDeploymentVerification(env, fetchApi)).rejects.toThrow("network unavailable");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
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
