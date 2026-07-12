import { describe, expect, it, vi } from "vitest";
import { fetchWorkflowJobs, waitForWorkflowJob } from "../../.github/scripts/wait-for-workflow-job.mjs";

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

const env = {
  GITHUB_API_URL: "https://api.github.test",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_RUN_ID: "123",
  GITHUB_TOKEN: "token",
};

describe("wait-for-workflow-job", () => {
  it("reads jobs through the GitHub REST API with actions-read token auth", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ total_count: 1, jobs: [{ name: "validate", status: "completed", conclusion: "success" }] }),
      );

    await expect(
      fetchWorkflowJobs({
        apiUrl: env.GITHUB_API_URL,
        fetchImpl,
        repository: env.GITHUB_REPOSITORY,
        runId: env.GITHUB_RUN_ID,
        token: env.GITHUB_TOKEN,
      }),
    ).resolves.toEqual([{ name: "validate", status: "completed", conclusion: "success" }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.test/repos/owner/repo/actions/runs/123/jobs?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
        }),
      }),
    );
  });

  it("retries transient API or parse failures before succeeding", async () => {
    const partialResponse = jsonResponse(null);
    partialResponse.json = async () => {
      throw new Error("partial response");
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(partialResponse)
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, jobs: [{ name: "validate", conclusion: "success" }] }));
    const sleepImpl = vi.fn(async () => undefined);

    await waitForWorkflowJob({
      attempts: 2,
      env,
      fetchImpl,
      jobName: "validate",
      sleepImpl,
      sleepSec: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on terminal job conclusions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ total_count: 1, jobs: [{ name: "validate", conclusion: "failure" }] }));

    await expect(
      waitForWorkflowJob({
        attempts: 2,
        env,
        fetchImpl,
        jobName: "validate",
        sleepImpl: vi.fn(async () => undefined),
        sleepSec: 0,
      }),
    ).rejects.toThrow("validate result was failure");
  });
});
