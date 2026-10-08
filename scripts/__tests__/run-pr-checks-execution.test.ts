import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { runPrChecks, type RunPrChecksOptions } from "../maintenance/run-pr-checks.ts";
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

  it("marks filtered successful invocations incomplete", async () => {
    const h = harness();
    expect(await runPrChecks([`--base=${baseSha}`, "--testNamePattern=one case"], testEnv, h.options)).toBe(0);
    expect(h.receipts[0]).toMatchObject({ weakened: true, outcome: "incomplete" });
    expect(h.runCommandImpl.mock.calls.some(([command]) => command.cmd.includes("--testNamePattern=one case"))).toBe(true);
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
});
