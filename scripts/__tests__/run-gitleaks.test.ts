import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePinnedGitleaks, GITLEAKS_VERSION, resolveGitleaksPin, runGitleaks } from "../ci/run-gitleaks";

describe("run-gitleaks", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ["linux-x64", "linux_x64.tar.gz", "79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e"],
    ["linux-arm64", "linux_arm64.tar.gz", "b4cbbb6ddf7d1b2a603088cd03a4e3f7ce48ee7fd449b51f7de6ee2906f5fa2f"],
    ["darwin-arm64", "darwin_arm64.tar.gz", "b251ab2bcd4cd8ba9e56ff37698c033ebf38582b477d21ebd86586d927cf87e7"],
    ["darwin-x64", "darwin_x64.tar.gz", "ca221d012d247080c2f6f61f4b7a83bffa2453806b0c195c795bbe9a8c775ed5"],
  ])("selects the pinned %s release", (platformKey, assetSuffix, sha256) => {
    expect(resolveGitleaksPin(platformKey)).toEqual({ assetSuffix, sha256 });
  });

  it("returns success without bootstrapping on an unsupported lenient platform", async () => {
    const ensureBinary = vi.fn<() => Promise<string>>();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runGitleaks({ argv: ["--range", "--lenient-platform"], ensureBinary, platformKey: "win32-x64" }),
    ).resolves.toEqual({ status: 0 });

    expect(ensureBinary).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("[gitleaks] SKIPPED: no pinned binary for win32/x64");
    warning.mockRestore();
  });

  it("throws without bootstrapping on an unsupported strict platform", async () => {
    const ensureBinary = vi.fn<() => Promise<string>>();

    await expect(runGitleaks({ argv: ["--range"], ensureBinary, platformKey: "win32-x64" })).rejects.toThrow(
      "No pinned Gitleaks binary for win32/x64",
    );
    expect(ensureBinary).not.toHaveBeenCalled();
  });

  it("selects requested history ranges, zero-base full history, and worktree bytes", async () => {
    for (const mode of ["range", "full", "worktree"]) {
      const bytes = Buffer.from("new worktree bytes\n");
      const runBinary = vi.fn((_binary: string, args: string[], _options: Record<string, unknown>): { status: number } => ({
        status: args[0] === "dir" ? (runBinary.mock.calls.length % 2 === 1 ? 0 : 1) : 0,
      }));
      const buildWorktreeInput = vi.fn(() => bytes);
      expect(await runGitleaks({
        argv: [mode === "worktree" ? "--worktree" : "--range"],
        env: { GITLEAKS_BASE_REF: mode === "full" ? "000000" : "base-sha", GITLEAKS_HEAD_REF: "head-sha", NODE_ENV: "test" },
        platformKey: "linux-x64", ensureBinary: async () => "/fake/gitleaks", runBinary, buildWorktreeInput,
      })).toEqual({ status: 0 });
      const scan = runBinary.mock.calls.at(-1)!;
      if (mode === "range") expect(scan[1]).toContain("--log-opts=--no-merges base-sha..head-sha");
      if (mode === "full") {
        expect(scan[1][0]).toBe("git");
        expect(scan[1].some((arg) => arg.startsWith("--log-opts"))).toBe(false);
      }
      if (mode === "worktree") {
        expect(scan[1][0]).toBe("stdin");
        expect(scan[2]).toMatchObject({ input: bytes });
      } else expect(buildWorktreeInput).not.toHaveBeenCalled();
    }
  });

  it("fails closed for nonzero scans, spawn errors, and signal termination", async () => {
    for (const [scanResult, status] of [[{ status: 9 }, 9], [{ error: new Error("spawn failed") }, 1], [{ status: null }, 1]] as const) {
      const runBinary = vi.fn((_binary: string, args: string[]): { status?: number | null; error?: unknown } =>
        args[0] === "dir" ? { status: runBinary.mock.calls.length % 2 === 1 ? 0 : 1 } : scanResult);
      await expect(runGitleaks({
        argv: ["--range"], env: { NODE_ENV: "test" }, platformKey: "linux-x64",
        ensureBinary: async () => "/fake/gitleaks", runBinary,
      })).resolves.toEqual({ status });
    }
  });

  it("rejects untrusted downloads and never extracts them", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "gitleaks-checksum-"));
    const execFile = vi.fn();
    try {
      await expect(ensurePinnedGitleaks({
        cacheRoot, platformKey: "linux-x64", execFile,
        fetchImpl: vi.fn(async () => new Response("untrusted tarball")),
      })).rejects.toThrow("tarball checksum mismatch");
      expect(execFile).not.toHaveBeenCalled();
      expect(readdirSync(join(cacheRoot, `${GITLEAKS_VERSION}-linux-x64`))).toEqual([]);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("refuses a tampered cached binary and attempts a verified replacement", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "gitleaks-cache-"));
    const directory = join(cacheRoot, `${GITLEAKS_VERSION}-linux-x64`);
    const fetchImpl = vi.fn(async () => new Response("bad replacement"));
    try {
      mkdirSync(directory);
      writeFileSync(join(directory, "gitleaks"), "original binary");
      writeFileSync(join(directory, "verified.json"), JSON.stringify({
        tarballSha256: resolveGitleaksPin("linux-x64")!.sha256,
        binarySha256: createHash("sha256").update("original binary").digest("hex"),
      }));
      await expect(ensurePinnedGitleaks({ cacheRoot, platformKey: "linux-x64", fetchImpl }))
        .resolves.toBe(join(directory, "gitleaks"));
      expect(fetchImpl).not.toHaveBeenCalled();
      writeFileSync(join(directory, "gitleaks"), "tampered binary");
      await expect(ensurePinnedGitleaks({ cacheRoot, platformKey: "linux-x64", fetchImpl }))
        .rejects.toThrow("tarball checksum mismatch");
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
