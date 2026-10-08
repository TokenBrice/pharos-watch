import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readPrCheckReceipt, writePrCheckReceipt } from "../lib/pr-check-receipt.mts";
import { runCiParity, runCiParityClone, parityEnvironment } from "../maintenance/run-ci-parity.ts";
import type { ParityCommand } from "../maintenance/run-ci-parity.ts";
import type { PrCheckReceipt } from "../lib/pr-check-receipt.mts";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { createPrTestPlan } from "../lib/pr-test-plan.mts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const TREE = "d".repeat(40);
const runtimeVersions = () => ({ node: "24.16.0", npm: "11.13.0" });
const repoRoot = resolve(import.meta.dirname, "../..");

function fixture({ dirty = false, failure = "", leafFailure = false, badIdentity = false, childIncomplete = false } = {}) {
  const calls: ParityCommand[] = [];
  const childReceipt: PrCheckReceipt = {
    schemaVersion: 1, ...runtimeVersions(), baseSha: BASE, headSha: HEAD,
    mode: "ci-parity", mergeSha: badIdentity ? BASE : MERGE, mergeTree: TREE, treeClean: true,
    flags: {}, weakened: childIncomplete, startedAt: "2000-01-01T00:00:00Z", finishedAt: "2000-01-01T00:00:00Z",
    leaves: [
      { id: "pr-tests:1/4", command: "test shard", status: leafFailure ? "failed" : "passed", durationMs: 123, ...(leafFailure ? { firstError: "assertion failed" } : {}) },
      { id: "pages-artifact", command: "artifact", status: "passed", durationMs: 456 },
    ], outcome: leafFailure ? "failed" : childIncomplete ? "incomplete" : "passed",
  };
  const outputs: Record<string, string> = {
    "resolve-head": HEAD, "tracked-state": dirty ? " M scripts/example.ts" : "", history: "false",
    "resolve-base": BASE, "merge-tree": TREE, "merge-commit": MERGE,
  };
  const runCommand = vi.fn(async (command: ParityCommand) => {
    calls.push(command);
    return { status: command.id === failure || (command.id === "readiness-pipeline" && leafFailure) ? 1 : 0, output: command.id === failure ? "command failed" : outputs[command.id] ?? "" };
  });
  const writeReceipt = vi.fn((_receipt: PrCheckReceipt) => "receipt.json");
  const removeTemporaryRoot = vi.fn();
  const makeTemporaryRoot = vi.fn(() => "/tmp/parity-unit-fixture");
  const readChildReceipt = vi.fn(() => childReceipt);
  const log = vi.fn();
  return { calls, options: { repoRoot, runtimeVersions, env: { PATH: "/runtime/bin", HOME: "/home/developer", API_KEY: "not-forwarded" },
    runCommand, makeTemporaryRoot, removeTemporaryRoot, readChildReceipt, writeReceipt, log },
    receipt: () => writeReceipt.mock.calls[0]?.[0] };
}

describe("opt-in parity sequencing", () => {
  it("freezes branch refs, constructs an independent synthetic merge, prepares clean dependencies and cleans up", async () => {
    const f = fixture();
    expect(await runCiParity(["--ci-parity", `--base=${BASE}`, `--head=${HEAD}`], f.options)).toBe(0);
    expect(f.calls.map((call) => call.id)).toEqual([
      "resolve-head", "tracked-state", "history", "fetch", "resolve-base", "clone", "clone-refs", "detach-base", "merge", "merge-tree", "merge-commit", "detach-merge",
      "npm-ci", "bootstrap-generated", "bootstrap-history", "bootstrap-immutability", "readiness-pipeline",
    ]);
    expect(f.calls.find((call) => call.id === "clone")?.args).toEqual(["clone", "--no-local", "--no-checkout", repoRoot, "/tmp/parity-unit-fixture/repo"]);
    expect(f.calls.some((call) => call.args.includes("worktree"))).toBe(false);
    expect(f.calls.find((call) => call.id === "merge-commit")?.args).toContain(TREE);
    const child = f.calls.find((call) => call.id === "readiness-pipeline")!;
    expect(child.cwd).toBe("/tmp/parity-unit-fixture/repo");
    expect(child.env).toMatchObject({ PR_BASE_SHA: BASE, PR_HEAD_SHA: HEAD, PHAROS_PARITY_MERGE_SHA: MERGE });
    expect(child.env.API_KEY).toBeUndefined();
    expect(f.options.removeTemporaryRoot).toHaveBeenCalledWith("/tmp/parity-unit-fixture");
    expect(f.receipt()).toMatchObject({ mode: "ci-parity", headSha: HEAD, baseSha: BASE, mergeSha: MERGE, mergeTree: TREE, outcome: "passed", flags: { "ci-parity": true } });
  });

  it("refuses tracked dirty state before fetch/clone and replaces proof with failure", async () => {
    const f = fixture({ dirty: true });
    expect(await runCiParity(["--ci-parity"], f.options)).toBe(1);
    expect(f.calls.map((call) => call.id)).toEqual(["resolve-head", "tracked-state"]);
    expect(f.options.makeTemporaryRoot).not.toHaveBeenCalled();
    expect(f.receipt()).toMatchObject({ outcome: "failed", treeClean: false });
    expect(f.receipt()?.leaves.some((leaf) => leaf.firstError?.includes("dirty-tree"))).toBe(true);
  });

  it("fails with merge-conflict and disposes the clone", async () => {
    const f = fixture({ failure: "merge" });
    expect(await runCiParity(["--ci-parity"], f.options)).toBe(1);
    expect(f.options.removeTemporaryRoot).toHaveBeenCalledOnce();
    expect(f.calls.some((call) => call.id === "npm-ci")).toBe(false);
    expect(f.receipt()?.leaves.some((leaf) => leaf.firstError?.includes("merge-conflict"))).toBe(true);
  });

  it("aggregates failing and successful leaves and cleans up after leaf failure", async () => {
    const f = fixture({ leafFailure: true });
    expect(await runCiParity(["--ci-parity"], f.options)).toBe(1);
    expect(f.receipt()?.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pr-tests:1/4", status: "failed" }), expect.objectContaining({ id: "pages-artifact", status: "passed" }),
    ]));
    expect(f.options.removeTemporaryRoot).toHaveBeenCalledOnce();
  });

  it("marks --no-fetch incomplete even when every executed leaf passes", async () => {
    const f = fixture();
    expect(await runCiParity(["--ci-parity", "--no-fetch"], f.options)).toBe(0);
    expect(f.calls.some((call) => call.id === "fetch")).toBe(false);
    expect(f.receipt()).toMatchObject({ weakened: true, outcome: "incomplete", flags: { noFetch: true } });
  });

  it("does not conceal leaf failure behind --no-fetch incompleteness", async () => {
    const f = fixture({ leafFailure: true });
    expect(await runCiParity(["--ci-parity", "--no-fetch"], f.options)).toBe(1);
    expect(f.receipt()?.outcome).toBe("failed");
  });

  it("prints retained independent clone only when --keep-clone is requested", async () => {
    const f = fixture({ leafFailure: true });
    await runCiParity(["--ci-parity", "--keep-clone"], f.options);
    expect(f.options.removeTemporaryRoot).not.toHaveBeenCalled();
    expect(f.options.log).toHaveBeenCalledWith(expect.stringContaining("Kept independent clone: /tmp/parity-unit-fixture/repo"));
  });

  it("prints a non-executing plan without mutating a receipt or checking dirty state", async () => {
    const f = fixture({ dirty: true });
    expect(await runCiParity(["--ci-parity", "--plan"], f.options)).toBe(0);
    expect(f.options.runCommand).not.toHaveBeenCalled();
    expect(f.options.writeReceipt).not.toHaveBeenCalled();
    expect(f.options.log).toHaveBeenCalledWith(expect.stringContaining("PLAN ONLY"));
    expect(f.options.log).toHaveBeenCalledWith(expect.stringContaining("Production-only exclusions"));
  });

  it.each(["--skip-coverage", "--plan-only", "--testNamePattern=example", "--staged", "--frozen"])("rejects unsupported/weaker option %s before effects", async (flag) => {
    const f = fixture();
    await expect(runCiParity(["--ci-parity", flag], f.options)).rejects.toThrow();
    expect(f.options.runCommand).not.toHaveBeenCalled();
  });

  it("rejects stale explicit base after refresh", async () => {
    const f = fixture();
    expect(await runCiParity(["--ci-parity", `--base=${HEAD}`], f.options)).toBe(1);
    expect(f.options.makeTemporaryRoot).not.toHaveBeenCalled();
    expect(f.receipt()?.leaves.some((leaf) => leaf.firstError?.includes("stale-base"))).toBe(true);
  });

  it("rejects a receipt from a different tested merge", async () => {
    const f = fixture({ badIdentity: true });
    expect(await runCiParity(["--ci-parity"], f.options)).toBe(1);
    expect(f.options.removeTemporaryRoot).toHaveBeenCalledOnce();
    expect(f.receipt()?.leaves.some((leaf) => leaf.firstError?.includes("receipt-identity"))).toBe(true);
  });
});

describe("CI-shaped readiness leaves on the merge checkout", () => {
  function cloneFixture(files: string[], failingLeaf = "", shardFiles = ["scripts/__tests__/example.test.ts"]) {
    const calls: ParityCommand[] = [];
    const runCommand = vi.fn(async (command: ParityCommand) => {
      calls.push(command);
      return { status: command.id === failingLeaf ? 1 : 0, output: command.id === "tested-tree" ? `${MERGE}\n${TREE}\n` : command.id === failingLeaf ? "assertion failed" : "" };
    });
    const runSecrets = vi.fn(async () => ({ ok: true, exitCode: 0, summary: "trusted scans passed" }));
    return { calls, runSecrets, options: {
      env: { NODE_ENV: "test" as const, CI: "true", PR_BASE_SHA: BASE, PR_HEAD_SHA: HEAD, PHAROS_PARITY_MERGE_SHA: MERGE }, repoRoot,
      runCommand, runSecrets, changedFiles: files, classifyFiles: classifyChangedFiles,
      readPlan: () => createPrTestPlan(BASE, shardFiles, {}), runtimeVersions, log: vi.fn(),
    } };
  }

  it("runs every plain explicit partition and later leaves after a failed test shard", async () => {
    const f = cloneFixture(["scripts/__tests__/example.test.ts"], "pr-tests:1/4");
    const receipt = await runCiParityClone(f.options);
    expect(receipt.outcome).toBe("failed");
    const shards = f.calls.filter((call) => call.id.startsWith("pr-tests:"));
    expect(shards).toHaveLength(4);
    for (let i = 0; i < shards.length; i++) {
      expect(shards[i].args).toContain(`--shard=${i + 1}/4`);
      expect(shards[i].env).toMatchObject({ PR_TEST_PLAN_FILE: ".tmp/pr-test-plan.json", PR_BASE_SHA: BASE, PR_HEAD_SHA: HEAD });
    }
    expect(f.runSecrets).toHaveBeenCalledWith({ baseSha: BASE, headSha: HEAD, mergeSha: MERGE, repoRoot });
    expect(f.calls.find((call) => call.id === "classifier-smoke")?.env).toMatchObject({ DEPLOY_BASE_SHA: BASE, DEPLOY_HEAD_SHA: HEAD, DEPLOY_EVENT_NAME: "push" });
    expect(f.calls.some((call) => call.id === "prerequisite:firefox")).toBe(false);
  });

  it("uses the eight-partition rule for more than 800 selected files", async () => {
    const f = cloneFixture(["scripts/__tests__/example.test.ts"], "", Array.from({ length: 801 }, (_, i) => `scripts/__tests__/file-${i}.test.ts`));
    expect((await runCiParityClone(f.options)).outcome).toBe("passed");
    expect(f.calls.filter((call) => call.id.startsWith("pr-tests:"))).toHaveLength(8);
  });

  it("uses full critical-owner shards, then merge/ratchet, and the selected Pages lane", async () => {
    const f = cloneFixture(["scripts/lib/pr-lanes.mts", "src/app/page.tsx"], "critical-coverage:1/8");
    const receipt = await runCiParityClone(f.options);
    expect(receipt.outcome).toBe("failed");
    const coverage = f.calls.filter((call) => /^critical-coverage:\d/.test(call.id));
    expect(coverage).toHaveLength(8);
    expect(coverage.every((call) => call.env.PR_BASE_SHA === BASE && call.env.PR_HEAD_SHA === HEAD && call.env.CRITICAL_COVERAGE_COMPARE_REF === BASE)).toBe(true);
    const mergeIndex = f.calls.findIndex((call) => call.id === "critical-coverage-merge");
    expect(mergeIndex).toBeGreaterThan(f.calls.indexOf(coverage[7]));
    expect(f.calls.slice(mergeIndex + 1).some((call) => call.id === "pages-artifact")).toBe(true);
    expect(f.calls.some((call) => call.args.join(" ") === "run coverage:critical")).toBe(false);
  });

  it("selects Firefox from generated OG artifact classification, not test filenames", async () => {
    const f = cloneFixture(["scripts/maintenance/build-og-editorial.mjs"]);
    const receipt = await runCiParityClone(f.options);
    expect(receipt.outcome).toBe("passed");
    expect(f.calls.find((call) => call.id === "prerequisite:firefox")?.args).toEqual(["--no-install", "playwright", "install", "--with-deps", "firefox"]);
  });

  it("audits dependency changes only for advisories absent at the frozen base", async () => {
    const f = cloneFixture(["package.json", "package-lock.json"]);
    expect((await runCiParityClone(f.options)).outcome).toBe("passed");
    const audit = f.calls.find((call) => call.id === "static-guards:check:dependency-audit");
    expect(audit?.args).toEqual(["run", "check:dependency-audit", "--", `--new-since=${BASE}`]);
    expect(f.calls.find((call) => call.id === "static-compile:lint:changed")?.args).toEqual(["run", "lint:changed", "--", `--base=${BASE}`, `--head=${HEAD}`]);
  });

  it("reports a clear prerequisite reason for missing Firefox", async () => {
    const f = cloneFixture(["scripts/maintenance/build-og-editorial.mjs"], "prerequisite:firefox");
    const receipt = await runCiParityClone(f.options);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.leaves.some((leaf) => leaf.firstError?.includes("selected OG checks require Playwright Firefox"))).toBe(true);
  });

  it("keeps docs-only omissions explicit without generating a test plan", async () => {
    const f = cloneFixture(["docs/testing.md"]);
    const receipt = await runCiParityClone(f.options);
    expect(receipt.outcome).toBe("passed");
    expect(f.calls.some((call) => call.id === "test-plan" || call.id.startsWith("static-"))).toBe(false);
    expect(receipt.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pr-tests", status: "not-selected" }),
      expect.objectContaining({ id: "pages-artifact", status: "not-selected" }),
      expect.objectContaining({ id: "critical-coverage", status: "not-selected" }),
    ]));
  });
});

it("retains npm cache and runtime PATH without application secrets or ambient selectors", () => {
  expect(parityEnvironment({ PATH: "/pinned", HOME: "/home/me", npm_config_cache: "/cache/npm", API_KEY: "secret", PHAROS_PR_NO_FETCH: "1", PR_HEAD_SHA: "ambient" })).toEqual({
    NODE_ENV: "development", PATH: "/pinned", HOME: "/home/me", npm_config_cache: "/cache/npm", CI: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  });
});

it("reads both legacy version-one receipts and additive tested-merge identity", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "pharos-receipt-test-"));
  try {
    const f = fixture();
    await runCiParity(["--ci-parity"], f.options);
    const parity = f.receipt()!;
    const path = writePrCheckReceipt(parity, directory);
    expect(readPrCheckReceipt(path)).toEqual(parity);
    const legacy = { ...parity };
    delete legacy.mode;
    delete legacy.mergeSha;
    delete legacy.mergeTree;
    writePrCheckReceipt(legacy, directory);
    expect(readPrCheckReceipt(path)).toEqual(legacy);
    writePrCheckReceipt({ ...parity, mergeSha: "not-a-commit" }, directory);
    expect(() => readPrCheckReceipt(path)).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
