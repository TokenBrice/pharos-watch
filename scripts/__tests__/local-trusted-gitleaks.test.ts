import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gitleaksCandidateMatchesTrusted,
  runGitleaks,
  runLocalTrustedGitleaks,
  snapshotGitleaksTrustedInputs,
} from "../ci/run-gitleaks";

const roots: string[] = [];
const strongPolicy = "[extend]\nuseDefault = true\n";
const weakPolicy = "[extend]\nuseDefault = false\n";

function fixture(weaken = false) {
  const root = mkdtempSync(join(tmpdir(), "pharos-local-trusted-test-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const put = (path: string, bytes: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  git("init", "--quiet");
  git("config", "user.name", "Scanner Test");
  git("config", "user.email", "scanner@example.invalid");
  put("scripts/ci/run-gitleaks.ts", 'import "../lib/scanner-helper.mjs";\n');
  put("scripts/lib/scanner-helper.mjs", "export const marker = 'trusted';\n");
  put(".gitleaks.toml", strongPolicy);
  put(".gitleaksignore", "# reviewed fingerprints\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  put("change.txt", "candidate content\n");
  if (weaken) put(".gitleaks.toml", weakPolicy);
  git("add", ".");
  git("commit", "--quiet", "-m", "head");
  const headSha = git("rev-parse", "HEAD");
  // Make the caller's checkout differ from the requested head, and its policy
  // differ from both commits: neither ambient input may select scanner policy.
  git("checkout", "--quiet", "--detach", baseSha);
  put(".gitleaks.toml", "# ambient policy must not be read\n");
  return { root, baseSha, headSha, git };
}

type ScannerOptions = Record<string, unknown>;
function stubScanner(onScan: (args: string[], options: ScannerOptions) => number = () => 0) {
  return vi.fn((_binary: string, args: string[], options: ScannerOptions) => {
    const snapshot = args.find((arg) => arg.startsWith("--snapshot-trusted="));
    if (snapshot) {
      snapshotGitleaksTrustedInputs(resolve(dirname(args[1]), "../.."), snapshot.slice("--snapshot-trusted=".length));
      return { status: 0 };
    }
    return { status: onScan(args, options) };
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("local trusted Gitleaks", () => {
  it.each([
    ["", "a".repeat(40)],
    ["origin/main", "a".repeat(40)],
    ["a".repeat(40), "HEAD"],
    ["0".repeat(40), "a".repeat(40)],
    ["a".repeat(40), "a".repeat(39)],
  ])("rejects invalid frozen refs before running a scanner (%s, %s)", async (baseSha, headSha) => {
    const runScanner = stubScanner();
    const result = await runLocalTrustedGitleaks({ baseSha, headSha, repoRoot: "/nonexistent" }, { runScanner });
    expect(result).toMatchObject({ ok: false, exitCode: 2 });
    expect(runScanner).not.toHaveBeenCalled();
  });

  it.each([
    ["--local-trusted"],
    ["--local-trusted", "--base=HEAD", `--head=${"a".repeat(40)}`],
    ["--local-trusted", `--base=${"a".repeat(40)}`, `--head=${"b".repeat(40)}`, "--lenient-platform"],
    ["--local-trusted", "--range"],
    ["--local-trusted", "--base"],
    ["--local-trusted", "--unknown"],
    ["--local-trusted", "unexpected"],
    ["--local-trusted", `--base=${"a".repeat(40)}`, `--base=${"a".repeat(40)}`],
  ])("rejects ambiguous or weaker local CLI arguments: %j", async (...argv) => {
    const ensureBinary = vi.fn();
    await expect(runGitleaks({ argv, ensureBinary })).rejects.toThrow();
    expect(ensureBinary).not.toHaveBeenCalled();
  });

  it("uses base policy even when candidate policy is weaker, and stops on trusted findings", async () => {
    const { root, baseSha, headSha } = fixture(true);
    let scanRoot = "";
    const runScanner = stubScanner((args, options) => {
      scanRoot = String(options.cwd);
      const policyRoot = args.find((arg) => arg.startsWith("--policy-root="))!.slice("--policy-root=".length);
      // Model the historical regression: weak candidate would be clean, but
      // the trusted policy detects findings. No fixture secret is required.
      return readFileSync(join(policyRoot, ".gitleaks.toml"), "utf8") === strongPolicy ? 1 : 0;
    });
    const result = await runLocalTrustedGitleaks({ repoRoot: root, baseSha, headSha }, { runScanner });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(runScanner).toHaveBeenCalledTimes(2);
    expect(existsSync(scanRoot)).toBe(false);
  });

  it.each([false, true])("sequences trusted passes before candidate policy (changed=%s) on the frozen head", async (weaken) => {
    const { root, baseSha, headSha, git } = fixture(weaken);
    let scanRoot = "";
    let candidateScanNeeded = false;
    const phases: string[] = [];
    const runScanner = stubScanner((args, options) => {
      scanRoot = String(options.cwd);
      const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: scanRoot, encoding: "utf8" }).trim();
      expect(currentHead).toBe(headSha);
      expect(options.env).toMatchObject({ GITLEAKS_BASE_REF: baseSha, GITLEAKS_HEAD_REF: headSha, GITLEAKS_FULL_HISTORY: "0" });
      if (args.includes("--candidate-policy")) {
        phases.push("candidate");
        const trustedRoot = args.find((arg) => arg.startsWith("--trusted-root="))!.slice("--trusted-root=".length);
        candidateScanNeeded = !gitleaksCandidateMatchesTrusted(scanRoot, trustedRoot);
        expect(readFileSync(join(scanRoot, ".gitleaks.toml"), "utf8")).toBe(weaken ? weakPolicy : strongPolicy);
      } else {
        phases.push(args.includes("--tree") ? "tree" : "range");
        const trustedRoot = args.find((arg) => arg.startsWith("--policy-root="))!.slice("--policy-root=".length);
        expect(readFileSync(join(trustedRoot, "scripts/lib/scanner-helper.mjs"), "utf8")).toContain("trusted");
        expect(readFileSync(join(trustedRoot, ".gitleaks.toml"), "utf8")).toBe(strongPolicy);
      }
      return 0;
    });
    const result = await runLocalTrustedGitleaks({ repoRoot: root, baseSha, headSha }, { runScanner });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(phases).toEqual(["range", "tree", "candidate"]);
    expect(candidateScanNeeded).toBe(weaken);
    expect(git("rev-parse", "HEAD")).toBe(baseSha);
    expect(readFileSync(join(root, ".gitleaks.toml"), "utf8")).toBe("# ambient policy must not be read\n");
    expect(existsSync(dirname(scanRoot))).toBe(false);
  });

  it("adds a parity merge checkout without changing branch range or candidate policy", async () => {
    const { root, baseSha, headSha, git } = fixture(true);
    // The synthetic merge tree intentionally has base policy, while the branch
    // has weaker candidate policy. Candidate inputs must still come from head.
    const mergeSha = git("commit-tree", git("rev-parse", `${baseSha}^{tree}`),
      "-p", baseSha, "-p", headSha, "-m", "synthetic merge");
    let scanRoot = "";
    const runScanner = stubScanner((args, options) => {
      scanRoot = String(options.cwd);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: scanRoot, encoding: "utf8" }).trim()).toBe(mergeSha);
      expect(options.env).toMatchObject({ GITLEAKS_BASE_REF: baseSha, GITLEAKS_HEAD_REF: headSha });
      if (args.includes("--candidate-policy")) {
        expect(readFileSync(join(scanRoot, ".gitleaks.toml"), "utf8")).toBe(weakPolicy);
      }
      return 0;
    });
    expect(await runLocalTrustedGitleaks({ repoRoot: root, baseSha, headSha, mergeSha }, { runScanner }))
      .toMatchObject({ ok: true, exitCode: 0 });
    expect(runScanner).toHaveBeenCalledTimes(4);
    expect(git("rev-parse", "HEAD")).toBe(baseSha);
    expect(existsSync(dirname(scanRoot))).toBe(false);
  });

  it("rejects an invalid optional parity merge before scanning", async () => {
    const runScanner = stubScanner();
    expect(await runLocalTrustedGitleaks({
      repoRoot: "/nonexistent", baseSha: "a".repeat(40), headSha: "b".repeat(40), mergeSha: "HEAD",
    }, { runScanner })).toMatchObject({ ok: false, exitCode: 2 });
    expect(runScanner).not.toHaveBeenCalled();
  });

  it("cleans temporary inputs after a scanner setup exception without exposing its message", async () => {
    const { root, baseSha, headSha } = fixture();
    let scanRoot = "";
    const runScanner = stubScanner((_args, options) => {
      scanRoot = String(options.cwd);
      throw new Error("private scanner diagnostic");
    });
    const result = await runLocalTrustedGitleaks({ repoRoot: root, baseSha, headSha }, { runScanner });
    expect(result).toMatchObject({ ok: false, exitCode: 2 });
    expect(result.summary).not.toContain("private scanner diagnostic");
    expect(existsSync(dirname(scanRoot))).toBe(false);
  });

  it("reports unavailable history as setup failure without starting a scanner", async () => {
    const { root, baseSha } = fixture();
    const runScanner = stubScanner();
    expect(await runLocalTrustedGitleaks({ repoRoot: root, baseSha, headSha: "f".repeat(40) }, { runScanner }))
      .toMatchObject({ ok: false, exitCode: 2 });
    expect(runScanner).not.toHaveBeenCalled();
  });

  it("maps legacy scanner setup throws to exit 2 without printing private diagnostics", async () => {
    const { root, git } = fixture();
    writeFileSync(join(root, "scripts/ci/run-gitleaks.ts"),
      'export async function runGitleaks() { throw new Error("private scanner diagnostic"); }\n');
    git("add", "scripts/ci/run-gitleaks.ts");
    git("commit", "--quiet", "-m", "scanner setup failure");
    const sha = git("rev-parse", "HEAD");
    const outcome = await runLocalTrustedGitleaks({ repoRoot: root, baseSha: sha, headSha: sha });
    expect(outcome).toMatchObject({ ok: false, exitCode: 2 });
    expect(outcome.summary).not.toContain("private scanner diagnostic");
  });

  it("returns usage exit 2 at the direct CLI boundary", () => {
    const outcome = spawnSync(process.execPath, [resolve("scripts/ci/run-gitleaks.ts"), "--local-trusted"], { encoding: "utf8" });
    expect(outcome.status).toBe(2);
    expect(outcome.stderr).not.toContain("Secret:");
  });
});
