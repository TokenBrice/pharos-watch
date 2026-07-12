import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  hasVersionUploadEvent,
  isRetryableCloudflareFailure,
  parseWranglerRetryArgs,
  runWranglerWithRetry,
} from "../../.github/scripts/retry-wrangler-control-plane.mjs";

describe("retry-wrangler-control-plane", () => {
  it("accepts only the supported Wrangler operation contract", () => {
    expect(
      parseWranglerRetryArgs([
        "--operation",
        "deployment-status",
        "--attempts",
        "3",
        "--stdout-file",
        "/tmp/status.json",
      ]),
    ).toMatchObject({
      attempts: 3,
      operation: "deployment-status",
      stdoutFile: "/tmp/status.json",
    });
    expect(() => parseWranglerRetryArgs(["--operation", "deploy"])).toThrow("must be deployment-status");
    expect(() =>
      parseWranglerRetryArgs(["--operation", "version-upload", "--stdout-file", "/tmp/status.json"]),
    ).toThrow("--stdout-file requires");
  });

  it("retries transient Cloudflare reads but fails closed on mutating requests", () => {
    const transientRead = "GET /accounts/redacted/workers/services/stablecoin-api -> 521 <none>";
    expect(isRetryableCloudflareFailure(transientRead)).toBe(true);
    expect(isRetryableCloudflareFailure(transientRead, { mutationRecorded: true })).toBe(false);
    expect(isRetryableCloudflareFailure("PUT /accounts/redacted/workers/scripts/stablecoin-api -> 522 <none>")).toBe(
      false,
    );
    expect(isRetryableCloudflareFailure("Received a malformed response from the API")).toBe(false);
    expect(isRetryableCloudflareFailure("Received a malformed response from the API", { readOnlyCommand: true })).toBe(
      true,
    );
    expect(isRetryableCloudflareFailure("entitlements.not_available [code: 10007]")).toBe(false);
    expect(
      isRetryableCloudflareFailure("GET /accounts/redacted/workers/scripts/stablecoin-api/subdomain -> 521 <none>"),
    ).toBe(false);
  });

  it("recognizes a structured version-upload event after unrelated output", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-wrangler-retry-"));
    try {
      const outputPath = join(directory, "output.jsonl");
      writeFileSync(
        outputPath,
        ["wrangler progress", JSON.stringify({ type: "version-upload", version_id: "candidate-123" })].join("\n"),
      );

      expect(hasVersionUploadEvent(outputPath)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("uses exponential backoff and succeeds after a transient upload preflight read failure", async () => {
    const runImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 1,
        stderr: "GET /accounts/redacted/workers/services/stablecoin-api -> 521 <none>\n",
        stdout: "",
      })
      .mockResolvedValueOnce({ status: 0, stderr: "", stdout: "uploaded\n" });
    const sleepImpl = vi.fn(async () => undefined);
    const output = { write: vi.fn() };

    await runWranglerWithRetry({
      attempts: 3,
      baseDelaySec: 2,
      env: { WRANGLER_OUTPUT_FILE_PATH: join(tmpdir(), `pharos-wrangler-retry-${process.pid}.jsonl`) },
      operation: "version-upload",
      runImpl,
      sleepImpl,
      stderr: output,
      stdout: output,
    });

    expect(runImpl).toHaveBeenCalledTimes(2);
    expect(runImpl).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["wrangler", "versions", "upload"]),
      expect.any(Object),
    );
    expect(sleepImpl).toHaveBeenCalledWith(2_000);
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("retrying in 2s"));
  });

  it("does not retry an ambiguous upload failure", async () => {
    const runImpl = vi.fn().mockResolvedValue({
      status: 1,
      stderr: "Received a malformed response from the API\n",
      stdout: "",
    });
    const sleepImpl = vi.fn(async () => undefined);
    const output = { write: vi.fn() };

    await expect(
      runWranglerWithRetry({
        attempts: 4,
        env: { WRANGLER_OUTPUT_FILE_PATH: join(tmpdir(), `pharos-wrangler-ambiguous-${process.pid}.jsonl`) },
        operation: "version-upload",
        runImpl,
        sleepImpl,
        stderr: output,
        stdout: output,
      }),
    ).rejects.toThrow("after 1 attempt");
    expect(runImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("requires structured Wrangler output tracking before version upload", async () => {
    await expect(
      runWranglerWithRetry({
        env: {},
        operation: "version-upload",
      }),
    ).rejects.toThrow("WRANGLER_OUTPUT_FILE_PATH is required");
  });
});
