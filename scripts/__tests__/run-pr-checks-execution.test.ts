import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspectPrCheckout, runPrChecks, type RunPrChecksOptions } from "../maintenance/run-pr-checks.ts";
import type { PrCheckReceipt } from "../lib/pr-check-receipt.mts";
import type * as ChangedFilesModule from "../lib/changed-files.mts";
import type * as CriticalOwnershipModule from "../lib/critical-ownership.mts";

const fixture = vi.hoisted(() => ({ changedFiles: [] as string[] }));
vi.mock("../lib/changed-files.mts", async (importOriginal) => ({
  ...await importOriginal<typeof ChangedFilesModule>(),
  collectChangedFiles: () => fixture.changedFiles,
}));
vi.mock("../lib/critical-ownership.mts", async (importOriginal) => ({
  ...await importOriginal<typeof CriticalOwnershipModule>(),
  deriveBaseCriticalOwnership: () => new Map(),
}));

const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);
const testEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
const repoRoot = resolve(import.meta.dirname, "../..");

function harness() {
  const receipts: PrCheckReceipt[] = [];
  const stdout = { write: vi.fn<(chunk: string) => unknown>() };
  const stderr = { write: vi.fn<(chunk: string) => unknown>() };
  const runCommandImpl = vi.fn(async (command: { cmd: string }) => ({
    status: 0, aborted: false,
    output: command.cmd.startsWith("git rev-parse") ? baseSha : command.cmd.startsWith("git show") ? "0" : "",
  }));
  const runSecrets = vi.fn(async () => ({ ok: true, exitCode: 0, summary: "Trusted security clean." }));
  const selectPlanTestFiles = vi.fn(() => ["scripts/__tests__/runtime-guard.test.ts"]);
  const options: RunPrChecksOptions = {
    repoRoot,
    now: () => 0, stdout, stderr, runCommandImpl,
    runtimeVersions: () => ({ node: "24.16.0", npm: "11.13.0" }),
    inspectCheckout: () => ({ headSha, requestedHeadSha: headSha, mergeBase: baseSha, treeClean: true }),
    selectPlanTestFiles, runSecrets,
    writeReceipt: (receipt) => { receipts.push(receipt); return ".tmp/receipt.json"; },
  };
  return { options, receipts, stdout, stderr, runCommandImpl, runSecrets, selectPlanTestFiles };
}

beforeEach(() => { fixture.changedFiles = ["worker/src/api/example.ts"]; });

describe("readiness execution", () => {
  it("plans every selected command and test partition without executing a gate", async () => {
    const h = harness();
    expect(await runPrChecks(["--plan", `--base=${baseSha}`], testEnv, h.options)).toBe(0);
    expect(h.runCommandImpl.mock.calls.every(([command]) => command.cmd.startsWith("git "))).toBe(true);
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(h.selectPlanTestFiles).toHaveBeenCalledWith(baseSha, fixture.changedFiles, testEnv);
    const output = h.stdout.write.mock.calls.map(([chunk]) => chunk).join("");
    expect(output).toContain(headSha);
    expect(output).toContain("npm run test:pr");
    expect(output).toContain("runtime-guard.test.ts");
    expect(output).toContain("CI partitions");
    expect(h.receipts[0].outcome).toBe("incomplete");
    expect(h.receipts[0].leaves.filter((leaf) => leaf.status !== "not-selected").every((leaf) => leaf.status === "skipped")).toBe(true);
  });

  it("fails Node 26 fast with mise guidance before refs or checks", async () => {
    const h = harness();
    h.options.runtimeVersions = () => ({ node: "26.10.0", npm: "12.2.0" });
    const inspect = vi.fn(h.options.inspectCheckout!);
    h.options.inspectCheckout = inspect;
    expect(await runPrChecks([], testEnv, h.options)).toBe(1);
    expect(h.runCommandImpl).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(h.stderr.write.mock.calls.join("")).toContain("mise settings add idiomatic_version_file_enable_tools node && mise install");
    expect(h.receipts[0].outcome).toBe("failed");
  });

  it("runs later independent leaves after both nonzero and thrown failures", async () => {
    const h = harness();
    h.runCommandImpl.mockImplementation(async (command) => {
      if (command.cmd.startsWith("git rev-parse")) return { status: 0, aborted: false, output: baseSha };
      if (command.cmd.startsWith("git show")) return { status: 0, aborted: false, output: "0" };
      if (command.cmd.includes("lint:changed")) return { status: 1, aborted: false, output: "> banner\nError: lint violation" };
      if (command.cmd.includes("check:table-primitives")) throw new Error("spawn ENOENT");
      return { status: 0, aborted: false, output: "" };
    });
    expect(await runPrChecks([`--base=${baseSha}`], testEnv, h.options)).toBe(1);
    expect(h.receipts[0].outcome).toBe("failed");
    expect(h.receipts[0].leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pr-static:lint:changed", status: "failed", firstError: "Error: lint violation" }),
      expect.objectContaining({ id: "pr-static:check:table-primitives", status: "failed", firstError: "spawn ENOENT" }),
      expect.objectContaining({ id: "pr-tests", status: "passed" }),
    ]));
    const output = h.stdout.write.mock.calls.map(([chunk]) => chunk).join("");
    expect(output).toContain("failed | 0 | npm run lint:changed");
    expect(output).toContain("spawn ENOENT");
    expect(h.runSecrets).toHaveBeenCalledWith({ baseSha, headSha, repoRoot });
  });

  it("reports clean successful execution as passed in both the receipt and JSON", async () => {
    const h = harness();
    expect(await runPrChecks([`--base=${baseSha}`, "--json"], testEnv, h.options)).toBe(0);
    const report = JSON.parse(h.stdout.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(h.receipts[0]).toMatchObject({ treeClean: true, weakened: false, outcome: "passed", incompleteReasons: [] });
    expect(report).toMatchObject({ status: h.receipts[0].outcome, incompleteReasons: [] });
  });

  it("keeps dirty authoring checks executable but makes their receipt and JSON incomplete", async () => {
    const h = harness();
    h.options.inspectCheckout = () => ({ headSha, requestedHeadSha: headSha, mergeBase: baseSha, treeClean: false });
    expect(await runPrChecks([`--base=${baseSha}`, "--json"], testEnv, h.options)).toBe(0);
    const report = JSON.parse(h.stdout.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(h.receipts[0]).toMatchObject({ treeClean: false, weakened: true, outcome: "incomplete", incompleteReasons: ["dirty-worktree"] });
    expect(report).toMatchObject({ status: h.receipts[0].outcome, incompleteReasons: ["dirty-worktree"] });
    expect(h.receipts[0].leaves.some((leaf) => leaf.status === "passed")).toBe(true);
    expect(h.runSecrets).toHaveBeenCalledOnce();
    expect(h.stderr.write.mock.calls.at(-1)?.[0]).toContain("dirty-worktree");
  });

  it("never conceals a failed leaf behind dirty-worktree incompleteness", async () => {
    const h = harness();
    h.options.inspectCheckout = () => ({ headSha, requestedHeadSha: headSha, mergeBase: baseSha, treeClean: false });
    h.runSecrets.mockResolvedValue({ ok: false, exitCode: 1, summary: "Secret scan failed." });
    expect(await runPrChecks([`--base=${baseSha}`, "--json"], testEnv, h.options)).toBe(1);
    const report = JSON.parse(h.stdout.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(h.receipts[0]).toMatchObject({ outcome: "failed", incompleteReasons: ["dirty-worktree"] });
    expect(report.status).toBe(h.receipts[0].outcome);
  });

  it("marks filtered successful invocations incomplete", async () => {
    const h = harness();
    expect(await runPrChecks([`--base=${baseSha}`, "--testNamePattern=one case", "--json"], testEnv, h.options)).toBe(0);
    expect(h.receipts[0]).toMatchObject({ weakened: true, outcome: "incomplete" });
    expect(h.runCommandImpl.mock.calls.some(([command]) => command.cmd.includes("--testNamePattern=one case"))).toBe(true);
    const report = JSON.parse(h.stdout.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(report.status).toBe(h.receipts[0].outcome);
  });

  it("rejects forwarded test plan-only arguments before any check", async () => {
    const h = harness();
    expect(await runPrChecks(["--plan-out=.tmp/plan.json"], testEnv, h.options)).toBe(1);
    expect(h.runCommandImpl).not.toHaveBeenCalled();
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(h.receipts[0].outcome).toBe("failed");
  });

  it("rejects an explicit head different from the checkout and binds failure to actual HEAD", async () => {
    const h = harness();
    h.options.inspectCheckout = () => ({ headSha, requestedHeadSha: "c".repeat(40), mergeBase: baseSha, treeClean: true });
    expect(await runPrChecks([`--base=${baseSha}`, "--head=other"], testEnv, h.options)).toBe(1);
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(h.runCommandImpl.mock.calls.every(([command]) => command.cmd.startsWith("git "))).toBe(true);
    expect(h.receipts[0]).toMatchObject({ headSha, outcome: "failed" });
    expect(h.stderr.write.mock.calls.join("")).toContain("Tests and coverage inspect the checkout");
  });

  it("defers critical-owner tests out of pr-tests only when the coverage leaf executes them", async () => {
    fixture.changedFiles = ["worker/src/lib/evm-rpc.ts"];
    const deferFlag = async (argv: string[]) => {
      const h = harness();
      await runPrChecks(argv, testEnv, h.options);
      const ran = (fragment: string): unknown[] | undefined => h.runCommandImpl.mock.calls.find(([command]) => command.cmd.includes(fragment));
      return { coverageRan: ran("coverage:critical") !== undefined, flag: (ran("test:pr")?.[1] as Record<string, string> | undefined)?.PR_TESTS_DEFER_CRITICAL_OWNERS };
    };
    expect(await deferFlag([`--base=${baseSha}`, "--with-coverage"])).toEqual({ coverageRan: true, flag: "1" });
    expect(await deferFlag([`--base=${baseSha}`])).toEqual({ coverageRan: false, flag: undefined });
    fixture.changedFiles = ["worker/src/api/example.ts"];
    expect(await deferFlag([`--base=${baseSha}`])).toEqual({ coverageRan: false, flag: undefined });
  });

  it("records classifier-selected coverage and Pages as deferred to CI without weakening a clean pass", async () => {
    fixture.changedFiles = ["worker/src/lib/evm-rpc.ts", "src/app/page.tsx"];
    const h = harness();
    expect(await runPrChecks([`--base=${baseSha}`], testEnv, h.options)).toBe(0);
    expect(h.runCommandImpl.mock.calls.some(([command]) => /coverage:critical|check:pages-artifact/.test(command.cmd))).toBe(false);
    expect(h.receipts[0]).toMatchObject({ weakened: false, outcome: "passed" });
    expect(h.receipts[0].leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pages-artifact", status: "deferred-to-ci" }),
      expect.objectContaining({ id: "critical-coverage", status: "deferred-to-ci" }),
    ]));
  });

  it("starts pages-artifact only after every other leaf has settled", async () => {
    fixture.changedFiles = ["worker/src/lib/evm-rpc.ts", "src/app/page.tsx"];
    const h = harness();
    const inFlight = new Set<string>();
    const inFlightAtPagesStart: string[][] = [];
    const track = async <T,>(id: string, result: T): Promise<T> => {
      if (id.includes("check:pages-artifact")) inFlightAtPagesStart.push([...inFlight]);
      inFlight.add(id);
      // Keep the coverage leaf in flight across the whole static track, so a
      // pages-artifact leaf scheduled concurrently would observe it.
      for (let hop = id.includes("coverage:critical") ? 1000 : 1; hop > 0; hop--) await Promise.resolve();
      inFlight.delete(id);
      return result;
    };
    h.runCommandImpl.mockImplementation((command) => command.cmd.startsWith("git ")
      ? Promise.resolve({ status: 0, aborted: false, output: command.cmd.startsWith("git rev-parse") ? baseSha : "0" })
      : track(command.cmd, { status: 0, aborted: false, output: "" }));
    h.runSecrets.mockImplementation(() => track("gitleaks", { ok: true, exitCode: 0, summary: "clean" }));
    expect(await runPrChecks([`--base=${baseSha}`, "--with-coverage", "--with-pages"], testEnv, h.options)).toBe(0);
    expect(inFlightAtPagesStart).toEqual([[]]);
    expect(h.receipts[0].leaves.at(-1)).toMatchObject({ id: "critical-coverage", status: "passed" });
  });
});

it("detects tracked and untracked dirt while respecting ignored files and overriding hidden-untracked configuration", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "pharos-checkout-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
  try {
    git("init", "--quiet");
    writeFileSync(resolve(directory, ".gitignore"), "ignored.txt\n");
    writeFileSync(resolve(directory, "tracked.txt"), "committed\n");
    git("add", ".gitignore", "tracked.txt");
    git("-c", "user.name=Pharos test", "-c", "user.email=test@pharos.invalid", "commit", "--quiet", "-m", "fixture");
    git("config", "status.showUntrackedFiles", "no");
    expect(inspectPrCheckout("HEAD", "HEAD", directory).treeClean).toBe(true);
    writeFileSync(resolve(directory, "ignored.txt"), "ignored author fixture\n");
    expect(inspectPrCheckout("HEAD", "HEAD", directory).treeClean).toBe(true);
    writeFileSync(resolve(directory, "untracked.txt"), "uncommitted\n");
    expect(inspectPrCheckout("HEAD", "HEAD", directory).treeClean).toBe(false);
    unlinkSync(resolve(directory, "untracked.txt"));
    writeFileSync(resolve(directory, "tracked.txt"), "modified\n");
    expect(inspectPrCheckout("HEAD", "HEAD", directory).treeClean).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
