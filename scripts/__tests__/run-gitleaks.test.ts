import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGitleaksMergeResolutionInput,
  collectGitleaksTrustedFiles,
  ensurePinnedGitleaks,
  GITLEAKS_VERSION,
  resolveGitleaksPin,
  runGitleaks,
  runGitleaksConfigSelfTest,
  snapshotGitleaksTrustedInputs,
} from "../ci/run-gitleaks";

interface SelfTestFinding {
  File: string;
  StartLine: number;
  RuleID: string;
}

// Model report contents from each fixture's own line, independently of scan order.
function selfTestScanStatus(args: string[], transform = (findings: SelfTestFinding[]) => findings): number {
  const root = args.at(-1)!;
  const findings: SelfTestFinding[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    for (const [index, line] of lines.entries()) {
      const value = JSON.parse(line);
      for (const [key, rule] of [["api_key", "generic-api-key"], ["aws_access_key_id", "aws-access-token"]]) {
        if (key in value) findings.push({ File: relative(root, file), StartLine: index + 1, RuleID: rule });
      }
    }
  }
  const reportPath = args.find((arg) => arg.startsWith("--report-path="))!.slice("--report-path=".length);
  writeFileSync(reportPath, JSON.stringify(transform(findings)));
  return findings.length ? 1 : 0;
}

function writeRepoFile(root: string, path: string, contents: string): void {
  const destination = resolve(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function scannerRepo(root: string): void {
  writeRepoFile(root, "scripts/ci/run-gitleaks.ts", 'import "../lib/scanner-helper.mjs";\n');
  writeRepoFile(root, "scripts/lib/scanner-helper.mjs", 'export { value } from "./scanner-leaf.mjs";\n');
  writeRepoFile(root, "scripts/lib/scanner-leaf.mjs", "export const value = 1;\n");
  writeRepoFile(root, ".gitleaks.toml", "[extend]\nuseDefault = true\n");
  writeRepoFile(root, ".gitleaksignore", "# fingerprints\n");
}

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
        status: args[0] === "dir" ? selfTestScanStatus(args) : 0,
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
        args[0] === "dir" ? { status: selfTestScanStatus(args) } : scanResult);
      await expect(runGitleaks({
        argv: ["--range"], env: { NODE_ENV: "test" }, platformKey: "linux-x64",
        ensureBinary: async () => "/fake/gitleaks", runBinary,
      })).resolves.toEqual({ status });
    }
  });

  it("scans only the bytes a merge resolution introduced and fails closed on them", async () => {
    const resolution = Buffer.from("api_key = \"introduced-by-resolution\"\n");
    const runBinary = vi.fn((_binary: string, args: string[], _options: Record<string, unknown>): { status: number } => ({
      status: args[0] === "dir" ? selfTestScanStatus(args) : 1,
    }));
    const buildWorktreeInput = vi.fn(() => Buffer.from("unused\n"));
    const buildMergeResolutionInput = vi.fn(() => resolution);

    await expect(runGitleaks({
      argv: ["--tree"], env: { NODE_ENV: "test" }, platformKey: "linux-x64",
      ensureBinary: async () => "/fake/gitleaks", runBinary, buildWorktreeInput, buildMergeResolutionInput,
    })).resolves.toEqual({ status: 1 });

    const scan = runBinary.mock.calls.at(-1)!;
    expect(scan[1][0]).toBe("stdin");
    expect(scan[1].some((arg) => arg.startsWith("--log-opts"))).toBe(false);
    expect(scan[2]).toMatchObject({ input: resolution });
    expect(buildWorktreeInput).not.toHaveBeenCalled();
    expect(buildMergeResolutionInput).toHaveBeenCalledWith({ baseRef: "origin/main", headRef: "HEAD" });
  });

  it("extracts combined-diff lines present in neither parent and nothing for a non-merge HEAD", () => {
    const combined = [
      "diff --cc config.ts",
      "--- a/config.ts",
      "+++ b/config.ts",
      "@@@ -1,2 -1,2 +1,3 @@@",
      "  shared line",
      "+ from parent two only",
      " +from parent one only",
      "++token = \"resolution-only\"",
    ].join("\n");
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args.includes("--merges") ? "historical-merge\n" : args.includes("--parents") ? "merge parent1 parent2\n" : combined);
    expect(buildGitleaksMergeResolutionInput({ execFile }).toString()).toBe("token = \"resolution-only\"\ntoken = \"resolution-only\"\n");
    expect(execFile).toHaveBeenCalledWith("git", ["rev-list", "--merges", "origin/main..HEAD"], { encoding: "utf8" });
    expect(execFile).toHaveBeenCalledWith("git", ["diff-tree", "--cc", "--no-color", "-r", "historical-merge"], { encoding: "utf8" });

    const single = vi.fn((_file: string, args: readonly string[]) =>
      args.includes("--merges") ? "\n" : args.includes("--parents") ? "head parent1\n" : combined);
    expect(buildGitleaksMergeResolutionInput({ execFile: single }).toString()).toBe("\n");
    expect(single).toHaveBeenCalledTimes(2);
  });

  it("extracts resolution-only lines introduced by historical merges inside the scan range", () => {
    const repo = mkdtempSync(join(tmpdir(), "gitleaks-merge-history-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      git(["init", "-q", "-b", "main", "."]);
      git(["config", "user.email", "t@example.com"]);
      git(["config", "user.name", "t"]);
      writeFileSync(join(repo, "config.txt"), "base\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).trim();

      writeFileSync(join(repo, "config.txt"), "main-side\n");
      git(["commit", "-qam", "main side"]);
      git(["checkout", "-qb", "pr"]);
      git(["reset", "-q", "--hard", base]);
      writeFileSync(join(repo, "config.txt"), "pr-side\n");
      git(["commit", "-qam", "pr side"]);
      // Merge main into the PR branch; the intended conflict makes git exit nonzero.
      try {
        execFileSync("git", ["merge", "--no-commit", "main"], { cwd: repo, encoding: "utf8", stdio: "ignore" });
      } catch {
        // conflict as planned
      }
      // Resolve with a line that exists in neither parent: only a merge-aware lane can see it.
      // Assembled at runtime so the repository's own scan never sees a literal credential.
      const credentialLine = ["api", "_key = \"", "A1b2C3d4E5f6G7h8", "I9j0K1l2M3n4O5p6\""].join("");
      writeFileSync(join(repo, "config.txt"), `${credentialLine}\n`);
      git(["add", "."]);
      git(["commit", "-qm", "merge with resolution-only credential"]);
      writeFileSync(join(repo, "trailer.txt"), "later commit\n");
      git(["add", "."]);
      git(["commit", "-qm", "later pr commit"]);
      const head = git(["rev-parse", "HEAD"]).trim();

      const execFile = (file: string, args: string[], options: { encoding: "utf8" }) =>
        execFileSync(file, args, { ...options, cwd: repo }) as string;
      const input = buildGitleaksMergeResolutionInput({ baseRef: base, execFile, headRef: head }).toString();
      expect(input).toContain(credentialLine);
      // The checked-out HEAD is a plain commit here, so the historical merge is
      // the only lane that can carry the resolution-only line.
      expect(git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/g)).toHaveLength(2);
    } finally {
      rmSync(repo, { force: true, recursive: true });
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
  it("batches self-tests into three scans while retaining per-line rule assertions", () => {
    const reports: SelfTestFinding[][] = [];
    const fixtureCounts: number[] = [];
    const runBinary = vi.fn((_binary: string, args: string[]) => {
      fixtureCounts.push(readdirSync(args.at(-1)!, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .reduce((count, entry) => count + readFileSync(join(entry.parentPath, entry.name), "utf8").trimEnd().split("\n").length, 0));
      return { status: selfTestScanStatus(args, (findings) => {
        reports.push(findings);
        return findings;
      }) };
    });
    runGitleaksConfigSelfTest("/fake/gitleaks", { runBinary });
    expect(runBinary).toHaveBeenCalledTimes(3);
    expect(fixtureCounts).toEqual([50, 49, 50]);
    expect(reports.map((report) => report.length)).toEqual([0, 49, 50]);
    expect(reports[1].every((finding) => finding.RuleID === "aws-access-token")).toBe(true);
    expect(reports[2].every((finding) => finding.RuleID === "generic-api-key")).toBe(true);
  });

  it.each(["aws", "generic"])("rejects a single missing %s finding even when the scan exits 1", (group) => {
    const runBinary = vi.fn((_binary: string, args: string[]) => ({
      status: selfTestScanStatus(args, (findings) => args.at(-1)!.endsWith(group) ? findings.slice(1) : findings),
    }));
    expect(() => runGitleaksConfigSelfTest("/fake/gitleaks", { runBinary })).toThrow(`${group} control failed`);
  });

  it("rejects a public control finding and a positive finding with the wrong rule", () => {
    for (const failure of ["public", "rule"]) {
      const runBinary = vi.fn((_binary: string, args: string[]) => ({
        status: selfTestScanStatus(args, (findings) => {
          if (failure === "public" && args.at(-1)!.endsWith("public")) {
            return [{ File: "shared/data/stablecoins/coins/xaum-matrixdock.json", StartLine: 1, RuleID: "generic-api-key" }];
          }
          return failure === "rule" ? findings.map((finding, index) =>
            index === 0 ? { ...finding, RuleID: "wrong-rule" } : finding) : findings;
        }),
      }));
      expect(() => runGitleaksConfigSelfTest("/fake/gitleaks", { runBinary })).toThrow("control failed");
    }
  });

  it("snapshots the actual scanner without installing or scanning", async () => {
    const destination = mkdtempSync(join(tmpdir(), "gitleaks-trusted-"));
    const ensureBinary = vi.fn<() => Promise<string>>();
    try {
      await expect(runGitleaks({ argv: [`--snapshot-trusted=${destination}`], ensureBinary })).resolves.toEqual({ status: 0 });
      expect(ensureBinary).not.toHaveBeenCalled();
      expect(readFileSync(join(destination, "scripts/ci/run-gitleaks.ts")))
        .toEqual(readFileSync(resolve("scripts/ci/run-gitleaks.ts")));
      expect(readFileSync(join(destination, ".gitleaks.toml"))).toEqual(readFileSync(".gitleaks.toml"));
      expect(readFileSync(join(destination, ".gitleaksignore"))).toEqual(readFileSync(".gitleaksignore"));
      expect(JSON.parse(readFileSync(join(destination, "package.json"), "utf8"))).toEqual({ private: true, type: "module" });
      const output = execFileSync(process.execPath, [
        join(destination, "scripts/ci/run-gitleaks.ts"), "--range", "--candidate-policy", `--trusted-root=${destination}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(output).toContain("[gitleaks] candidate policy identical to trusted base; skipping");
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("copies transitive imports, re-exports and literal dynamic imports with repo-relative paths", () => {
    const root = mkdtempSync(join(tmpdir(), "gitleaks-closure-"));
    const destination = mkdtempSync(join(tmpdir(), "gitleaks-snapshot-"));
    try {
      scannerRepo(root);
      writeRepoFile(root, "scripts/lib/scanner-leaf.mjs",
        'import { resolve } from "node:path";\nexport const value = /["\']/;\nvoid import("./dynamic.mjs");\n');
      writeRepoFile(root, "scripts/lib/dynamic.mjs", 'export const text = "import \\"./not-a-dependency.mjs\\"";\n');
      const files = collectGitleaksTrustedFiles(root);
      expect(files).toEqual([
        ".gitleaks.toml", ".gitleaksignore", "scripts/ci/run-gitleaks.ts",
        "scripts/lib/dynamic.mjs", "scripts/lib/scanner-helper.mjs", "scripts/lib/scanner-leaf.mjs",
      ]);
      snapshotGitleaksTrustedInputs(root, destination);
      for (const file of files) expect(readFileSync(join(destination, file))).toEqual(readFileSync(join(root, file)));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it.each([
    'import "./missing.mjs";',
    'import "not-installed";',
    'void import(computedPath);',
    'void import("../lib/scanner-leaf.mjs" + suffix);',
  ])("fails closed for an unresolved or nonliteral scanner import: %s", (source) => {
    const root = mkdtempSync(join(tmpdir(), "gitleaks-closure-fail-"));
    try {
      scannerRepo(root);
      writeRepoFile(root, "scripts/ci/run-gitleaks.ts", source);
      expect(() => collectGitleaksTrustedFiles(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["range", "full", "tree", "worktree"])("uses trusted policy/cache but cwd git input for %s", async (mode) => {
    const policyRoot = resolve("/trusted/policy");
    const ensureBinary = vi.fn(async () => "/fake/gitleaks");
    const input = Buffer.from("cwd git bytes\n");
    const buildMergeResolutionInput = vi.fn(() => input);
    const buildWorktreeInput = vi.fn(() => input);
    const runBinary = vi.fn((_binary: string, args: string[]) => ({
      status: args[0] === "dir" ? selfTestScanStatus(args) : 0,
    }));
    await expect(runGitleaks({
      argv: [`--${mode === "full" ? "range" : mode}`, `--policy-root=${policyRoot}`],
      env: { GITLEAKS_BASE_REF: mode === "full" ? "000000" : "base", GITLEAKS_HEAD_REF: "head", NODE_ENV: "test" },
      ensureBinary, runBinary, buildMergeResolutionInput, buildWorktreeInput, platformKey: "linux-x64",
    })).resolves.toEqual({ status: 0 });
    expect(ensureBinary).toHaveBeenCalledWith({ cacheRoot: resolve(policyRoot, ".cache/gitleaks"), platformKey: "linux-x64" });
    for (const call of runBinary.mock.calls) expect(call[1]).toContain(`--config=${resolve(policyRoot, ".gitleaks.toml")}`);
    const scan = runBinary.mock.calls.at(-1)!;
    expect(scan[1]).toContain(`--gitleaks-ignore-path=${resolve(policyRoot, ".gitleaksignore")}`);
    expect(scan[1]).not.toContain("--config=.gitleaks.toml");
    if (mode === "range") expect(scan[1]).toContain("--log-opts=--no-merges base..head");
    if (mode === "tree") expect(buildMergeResolutionInput).toHaveBeenCalledWith({ baseRef: "base", headRef: "head" });
    if (mode === "worktree") expect(buildWorktreeInput).toHaveBeenCalledOnce();
  });

  it.each(["identical", "config", "ignore", "scanner", "helper", "closure"])("checks candidate %s inputs against trusted bytes", async (change) => {
    const root = mkdtempSync(join(tmpdir(), "gitleaks-candidate-"));
    const trusted = mkdtempSync(join(tmpdir(), "gitleaks-base-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      scannerRepo(root);
      snapshotGitleaksTrustedInputs(root, trusted);
      const paths: Record<string, string> = {
        config: ".gitleaks.toml", ignore: ".gitleaksignore", scanner: "scripts/ci/run-gitleaks.ts",
        helper: "scripts/lib/scanner-leaf.mjs",
      };
      if (paths[change]) writeFileSync(join(root, paths[change]), `${readFileSync(join(root, paths[change]), "utf8")}\n// changed\n`);
      if (change === "closure") {
        writeRepoFile(root, "scripts/lib/scanner-leaf.mjs", 'import "./added.mjs";\n');
        writeRepoFile(root, "scripts/lib/added.mjs", "export const added = 1;\n");
      }
      vi.spyOn(process, "cwd").mockReturnValue(root);
      const ensureBinary = vi.fn(async () => "/fake/gitleaks");
      const runBinary = vi.fn((_binary: string, args: string[]) => ({
        status: args[0] === "dir" ? selfTestScanStatus(args) : 1,
      }));
      const result = await runGitleaks({
        argv: ["--range", "--candidate-policy", `--trusted-root=${trusted}`],
        env: { GITLEAKS_BASE_REF: "base", GITLEAKS_HEAD_REF: "head", NODE_ENV: "test" },
        ensureBinary, runBinary, platformKey: "linux-x64",
      });
      if (change === "identical") {
        expect(result).toEqual({ status: 0 });
        expect(log).toHaveBeenCalledWith("[gitleaks] candidate policy identical to trusted base; skipping");
        expect(ensureBinary).not.toHaveBeenCalled();
        expect(runBinary).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ status: 1 });
        expect(runBinary).toHaveBeenCalledTimes(4);
        expect(runBinary.mock.calls[0][1]).toContain(`--config=${resolve(root, ".gitleaks.toml")}`);
        expect(runBinary.mock.calls.at(-1)![1]).toContain("--log-opts=--no-merges base..head");
        expect(log).not.toHaveBeenCalled();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(trusted, { recursive: true, force: true });
    }
  });

  it("fails changed candidate policy before the range scan when one self-test finding is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitleaks-candidate-fail-"));
    const trusted = mkdtempSync(join(tmpdir(), "gitleaks-trusted-fail-"));
    try {
      scannerRepo(root);
      snapshotGitleaksTrustedInputs(root, trusted);
      writeRepoFile(root, ".gitleaksignore", "# changed candidate\n");
      vi.spyOn(process, "cwd").mockReturnValue(root);
      const runBinary = vi.fn((_binary: string, args: string[]) => ({
        status: selfTestScanStatus(args, (findings) => findings.slice(1)),
      }));
      await expect(runGitleaks({
        argv: ["--range", "--candidate-policy", `--trusted-root=${trusted}`],
        ensureBinary: async () => "/fake/gitleaks", runBinary, platformKey: "linux-x64",
      })).rejects.toThrow("aws control failed");
      expect(runBinary.mock.calls.every((call) => call[1][0] === "dir")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(trusted, { recursive: true, force: true });
    }
  });

  it("requires a trusted root for candidate mode and rejects changing its policy or scan mode", async () => {
    for (const argv of [
      ["--candidate-policy"],
      ["--candidate-policy", "--trusted-root=/trusted", "--policy-root=/other"],
      ["--candidate-policy", "--trusted-root=/trusted", "--tree"],
    ]) {
      await expect(runGitleaks({ argv })).rejects.toThrow();
    }
  });
});
