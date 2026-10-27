import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspectPrCheckout, runPrChecks, type RunPrChecksOptions } from "../maintenance/run-pr-checks.ts";
import { writePrCheckReceipt, type PrCheckReceipt } from "../lib/pr-check-receipt.mts";
import { assertFaithfulResourceReport, assertRequiredResourceCases, RESOURCE_TEST_FILE, runV9ResourceLane } from "../maintenance/run-v9-resource-lane.ts";
import type * as ChangedFilesModule from "../lib/changed-files.mts";
import type * as CriticalOwnershipModule from "../lib/critical-ownership.mts";
import { RESOURCE_HARNESS_REVISION, RESOURCE_PHASES } from "../../worker/scripts/lib/v9-resource-policy";

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

describe("receipt explanation dispatch", () => {
  it("treats a missing receipt as a completed diagnostic, not readiness or a trigger to run checks", async () => {
    const root = mkdtempSync(`${tmpdir()}/pharos-explain-missing-`);
    try {
      const h = harness();
      expect(await runPrChecks(["--explain-receipt"], testEnv, {
        ...h.options, repoRoot: root,
        inspectReceiptCheckout: () => ({ headSha, treeClean: true, baseRef: "origin/main" }),
      })).toBe(0);
      expect(h.stdout.write.mock.calls.map(([chunk]) => chunk).join("")).toContain("Receipt: missing");
      expect(h.runCommandImpl).not.toHaveBeenCalled();
      expect(h.receipts).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports unreadable receipt evidence without overwriting it or falling through to the gate", async () => {
    const root = mkdtempSync(`${tmpdir()}/pharos-explain-invalid-`);
    try {
      const path = writePrCheckReceipt({
        schemaVersion: 1, node: "24.16.0", npm: "11.13.0", baseSha, headSha, treeClean: true,
        flags: {}, weakened: false, startedAt: "start", finishedAt: "finish", leaves: [], outcome: "passed",
      }, root);
      writeFileSync(path, "{invalid");
      const h = harness();
      expect(await runPrChecks(["--explain-receipt"], testEnv, {
        ...h.options, repoRoot: root,
        inspectReceiptCheckout: () => ({ headSha, treeClean: true, baseRef: "origin/main", localBaseSha: baseSha }),
      })).toBe(1);
      expect(h.stderr.write.mock.calls.map(([chunk]) => chunk).join("")).toContain("Receipt explanation failed");
      expect(h.runCommandImpl).not.toHaveBeenCalled();
      expect(h.receipts).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe("{invalid");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("isolated V9 resource execution", () => {
  const contagion = "evaluates a bounded nine-scenario matrix within 256 MiB of old-space";
  const report = (cases: Array<{ title: string; status: string }>) => ({
    testResults: [{ name: resolve(repoRoot, RESOURCE_TEST_FILE), assertionResults: cases }],
  });

  it("requires the independent named contagion pass, never an arbitrary pass count or optional capture", () => {
    const passed = [{ title: contagion, status: "passed" }];
    expect(() => assertRequiredResourceCases(report([
      ...passed, { title: "keeps the frozen same-capture production envelope within both byte budgets", status: "pending" },
    ]))).not.toThrow();
    for (const status of ["pending", "skipped", "failed", "todo"]) {
      expect(() => assertRequiredResourceCases(report([{ title: contagion, status }]))).toThrow(contagion);
    }
    expect(() => assertRequiredResourceCases(report([{ title: "unrelated", status: "passed" }]))).toThrow(contagion);
    expect(() => assertRequiredResourceCases({ testResults: [] })).toThrow(contagion);
    expect(() => assertRequiredResourceCases(report([...passed, passed[0]]))).toThrow(contagion);
  });

  it("removes stale evidence and fails closed when a launch produces no JSON", async () => {
    const directory = mkdtempSync(`${tmpdir()}/pharos-resource-launch-`);
    try {
      writeFileSync(resolve(directory, "vitest.json"), JSON.stringify(report(
        [{ title: contagion, status: "passed" }],
      )));
      await expect(runV9ResourceLane({
        argv: [], outputDirectory: directory, resourceDirectory: directory, runCommand: async () => 0,
      })).rejects.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects stale faithful reports and violations even when child statuses pass", () => {
    const correctness = { publicationBytes: { unit: "card", units: 396, largestUnitBytes: 85_123,
      unitLimitBytes: 106_404, streamedTotalBytes: 8_158_138, streamedTotalRegressionLimitBytes: 8_250_000, streamedTotalLimitBytes: 14_000_000 } };
    const faithful = { schemaVersion: 1, invocationId: "previous-run", complete: true, diagnosticOnly: false,
      harnessRevision: RESOURCE_HARNESS_REVISION,
      profile: "compute", phaseManifest: "post-p2", violations: [], policy: "qualified", declaredPhases: [...RESOURCE_PHASES],
      appliedPolicy: { globalPostGcHeapBytes: 117440512, phaseLimitsBytes: Object.fromEntries(RESOURCE_PHASES.map(phase => [phase, 100])) },
      runs: [{ violations: [], live: { status: 0, signal: null, reasons: [], correctness, phaseMaxima: Object.fromEntries(RESOURCE_PHASES.map(phase => [phase, { postGcHeapBytes: 90 }])) },
        "hard-cap": { status: 0, signal: null, reasons: [], correctness } }] };
    expect(() => assertFaithfulResourceReport(faithful, "current-run")).toThrow("stale-resource-report");
    expect(() => assertFaithfulResourceReport(faithful, "previous-run")).not.toThrow();
    expect(() => assertFaithfulResourceReport({ ...faithful, violations: [{ reason: "phase-budget-exceeded" }] }, "previous-run")).toThrow();
    expect(() => assertFaithfulResourceReport({ ...faithful, runs: [] }, "previous-run")).toThrow();
    for (const declaredPhases of [[], ["phase"], RESOURCE_PHASES.slice(1), [...RESOURCE_PHASES].reverse(), [...RESOURCE_PHASES, "extra"]]) {
      expect(() => assertFaithfulResourceReport({ ...faithful, declaredPhases }, "previous-run")).toThrow();
    }
    expect(() => assertFaithfulResourceReport({ ...faithful, harnessRevision: "obsolete" }, "previous-run")).toThrow();
    expect(() => assertFaithfulResourceReport({ ...faithful, runs: [{ ...faithful.runs[0], live: { ...faithful.runs[0].live, phaseMaxima: {} } }] }, "previous-run")).toThrow("missing-resource-phase");
    const { appliedPolicy: _applied, ...unqualified } = faithful;
    expect(() => assertFaithfulResourceReport({ ...unqualified, policy: "unqualified" }, "previous-run")).not.toThrow();
    expect(() => assertFaithfulResourceReport({ ...unqualified, policy: "qualified" }, "previous-run")).toThrow("missing-applied-resource-policy");
    expect(() => assertFaithfulResourceReport({ ...faithful, policy: "unqualified" }, "previous-run")).toThrow("unqualified-resource-policy-applied");
    for (const mode of ["live", "hard-cap"] as const) {
      for (const invalid of [undefined, { publicationBytes: { ...correctness.publicationBytes, largestUnitBytes: 106_405 } },
        { publicationBytes: { ...correctness.publicationBytes, streamedTotalBytes: 8_250_001 } },
        { publicationBytes: { ...correctness.publicationBytes, streamedTotalBytes: 9_200_001 } }]) {
        expect(() => assertFaithfulResourceReport({ ...faithful, runs: [{ ...faithful.runs[0],
          [mode]: { ...faithful.runs[0][mode], correctness: invalid } }] }, "previous-run")).toThrow();
      }
      expect(() => assertFaithfulResourceReport({ ...faithful, runs: [{ ...faithful.runs[0],
        [mode]: { ...faithful.runs[0][mode], status: null, signal: "SIGABRT" } }] }, "previous-run")).toThrow();
    }
  });

  it("reports separate card-unit and streamed-total metrics without replacing natural memory status", async () => {
    const directory = mkdtempSync(`${tmpdir()}/pharos-resource-summary-`);
    const publicationBytes = { unit: "card", units: 396, largestUnitBytes: 85_123,
      unitLimitBytes: 106_404, streamedTotalBytes: 8_158_138, streamedTotalRegressionLimitBytes: 8_250_000, streamedTotalLimitBytes: 14_000_000 };
    try {
      expect(await runV9ResourceLane({ argv: [], outputDirectory: directory, resourceDirectory: directory,
        runCommand: async (command) => {
          if (command.args.includes("worker/scripts/measure-v9-resource.ts")) {
            const invocationId = command.args.find((arg) => arg.startsWith("--invocation-id="))!.split("=")[1];
            writeFileSync(resolve(directory, "report.json"), JSON.stringify({
              schemaVersion: 1, invocationId, complete: true, diagnosticOnly: false,
              harnessRevision: RESOURCE_HARNESS_REVISION, profile: "compute", phaseManifest: "post-p2",
              violations: [], policy: "unqualified", declaredPhases: [...RESOURCE_PHASES],
              runs: [{ violations: [], live: { status: 0, signal: null, reasons: [],
                phaseMaxima: Object.fromEntries(RESOURCE_PHASES.map((phase) => [phase, { postGcHeapBytes: 90 }])),
                correctness: { publicationBytes } },
                "hard-cap": { status: 0, signal: null, reasons: [], correctness: { publicationBytes } } }],
            }));
          } else writeFileSync(resolve(directory, "vitest.json"), JSON.stringify(report([{ title: contagion, status: "passed" }])));
          return 0;
        } })).toBe(0);
      const summary = readFileSync(resolve(directory, "summary.md"), "utf8");
      expect(summary).toContain("| live | 396 | 85123 | 106404 | 8158138 | 8250000 | 14000000 |");
      expect(summary).toContain("| hard-cap | 396 | 85123 | 106404 | 8158138 | 8250000 | 14000000 |");
      expect(summary).toContain("Natural 128 MiB exit status: 0");
      expect(summary).toContain('policy: **"unqualified"**');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps admission covered without probes under npm test despite ambient opt-in", () => {
    const directory = mkdtempSync(`${tmpdir()}/pharos-resource-default-off-`);
    const output = resolve(directory, "vitest.json");
    try {
      execFileSync("npm", ["test", "--", RESOURCE_TEST_FILE,
        "--maxWorkers=1", "--no-file-parallelism", "--reporter=json", `--outputFile=${output}`,
        "--coverage.enabled", "--coverage.include=worker/src/lib/safety-score-v9/resource-budget.ts",
        "--coverage.reporter=json", `--coverage.reportsDirectory=${directory}`,
      ], {
        cwd: repoRoot, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, PHAROS_V9_RESOURCE_LANE: "1", CONTAGION_MATRIX: "poison",
          SAFETY_SCORE_V9_RESOURCE_CAPTURE: "/missing/poison-capture.json" },
        stdio: "pipe",
      });
      const result = JSON.parse(readFileSync(output, "utf8"));
      const coverage = JSON.parse(readFileSync(resolve(directory, "coverage-final.json"), "utf8")) as Record<string, { s: Record<string, number> }>;
      const admission = coverage[resolve(repoRoot, "worker/src/lib/safety-score-v9/resource-budget.ts")];
      expect(admission).toBeDefined();
      expect(Object.values(admission.s).some((hits) => hits > 0)).toBe(true);
      const cases = result.testResults.flatMap((file: { assertionResults: Array<{ title: string; status: string }> }) => file.assertionResults);
      expect(cases.find((test: { title: string }) => test.title === "uses the codec expanded-byte ceiling and preserves unknown measurement")?.status).toBe("passed");
      for (const title of [contagion, "keeps the frozen same-capture production envelope within both byte budgets"]) {
        expect(["skipped", "pending"]).toContain(cases.find((test: { title: string }) => test.title === title)?.status);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 65_000);

  it("runs the resource lane once after ordinary tests settle and records its outcome", async () => {
    fixture.changedFiles = ["worker/src/lib/safety-score-v9/resource-budget.ts"];
    const h = harness();
    let testing = false;
    const resourceCalls: string[] = [];
    h.runCommandImpl.mockImplementation(async (command) => {
      if (command.cmd.startsWith("git rev-parse")) return { status: 0, aborted: false, output: baseSha };
      if (command.cmd.startsWith("git show")) return { status: 0, aborted: false, output: "0" };
      if (command.cmd.includes("npm run test:pr")) {
        testing = true;
        await Promise.resolve();
        testing = false;
      }
      if (command.cmd === "npm run test:v9-resource") {
        expect(testing).toBe(false);
        resourceCalls.push(command.cmd);
        return { status: 1, aborted: false, output: "resource probe failed" };
      }
      return { status: 0, aborted: false, output: "" };
    });
    expect(await runPrChecks([`--base=${baseSha}`], testEnv, h.options)).toBe(1);
    expect(resourceCalls).toHaveLength(1);
    expect(h.receipts[0].leaves.filter((leaf) => leaf.id === "v9-resource")).toEqual([
      expect.objectContaining({ status: "failed", command: "npm run test:v9-resource" }),
    ]);
  });
});

describe("readiness execution", () => {
  it("executes mixed-PR docs as static leaves and propagates a docs failure", async () => {
    fixture.changedFiles = ["README.md", "src/app/page.tsx"];
    const h = harness();
    h.runCommandImpl.mockImplementation(async (command) => ({
      status: command.cmd === "npm run check:verified-doc-links" ? 1 : 0,
      aborted: false,
      output: command.cmd.startsWith("git rev-parse") ? baseSha : command.cmd.startsWith("git show") ? "0" : "",
    }));
    expect(await runPrChecks([`--base=${baseSha}`], testEnv, h.options)).toBe(1);
    const executed = h.receipts[0].leaves.filter((leaf) => leaf.id.startsWith("pr-static:"));
    expect(executed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pr-static:check:verified-doc-links", status: "failed" }),
      expect.objectContaining({ id: "pr-static:check:doc-sync", status: "passed" }),
      expect.objectContaining({ id: "pr-static:doc-ownership-invariants", status: "passed", command: "npm exec -- vitest run scripts/__tests__/doc-ownership-registry.test.ts scripts/__tests__/pharos-change-contract.test.ts" }),
    ]));
    expect(h.runCommandImpl.mock.calls.filter(([command]) => command.cmd === "npm run check:doc-sync")).toHaveLength(1);
    expect(h.receipts[0].outcome).toBe("failed");
  });

  it("propagates a failing router invariant from the shared docs command", async () => {
    fixture.changedFiles = ["README.md", "src/app/page.tsx"];
    const h = harness();
    h.runCommandImpl.mockImplementation(async (command) => ({
      status: command.cmd.includes("pharos-change-contract.test.ts") ? 1 : 0,
      aborted: false,
      output: command.cmd.startsWith("git rev-parse") ? baseSha : command.cmd.startsWith("git show") ? "0" : "",
    }));
    expect(await runPrChecks([`--base=${baseSha}`], testEnv, h.options)).toBe(1);
    expect(h.receipts[0].leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pr-static:doc-ownership-invariants", status: "failed" }),
    ]));
    expect(h.receipts[0].outcome).toBe("failed");
  });

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
      if (command.cmd.includes("check:env-contract")) throw new Error("spawn ENOENT");
      return { status: 0, aborted: false, output: "" };
    });
    expect(await runPrChecks([`--base=${baseSha}`], testEnv, h.options)).toBe(1);
    expect(h.receipts[0].outcome).toBe("failed");
    expect(h.receipts[0].leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pr-static:lint:changed", status: "failed", firstError: "Error: lint violation" }),
      expect.objectContaining({ id: "pr-static:check:env-contract", status: "failed", firstError: "spawn ENOENT" }),
      expect.objectContaining({ id: "pr-static:check:critical-coverage-completeness", status: "passed" }),
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
    expect(h.stderr.write.mock.calls.join("")).toContain("Tests inspect the checkout");
  });

  it("never delegates critical-owner tests to local coverage or emits a deferral override", async () => {
    fixture.changedFiles = ["worker/src/lib/evm-rpc.ts"];
    const assertNoDeferral = async (argv: string[], env = testEnv) => {
      const h = harness();
      await runPrChecks(argv, env, h.options);
      const ran = (fragment: string): unknown[] | undefined => h.runCommandImpl.mock.calls.find(([command]) => command.cmd.includes(fragment));
      const testCall = ran("test:pr");
      const testCommand = testCall?.[0] as { extraEnv?: Record<string, string> } | undefined;
      expect(ran("coverage:critical")).toBeUndefined();
      expect(testCommand).toBeDefined();
      expect(testCommand?.extraEnv ?? {}).not.toHaveProperty("PR_TESTS_DEFER_CRITICAL_OWNERS");
      expect(testCall?.[1]).toHaveProperty("PHAROS_V9_RESOURCE_LANE", "0");
    };
    await assertNoDeferral([`--base=${baseSha}`, "--with-pages"]);
    await assertNoDeferral([`--base=${baseSha}`]);
    // The retired ambient flag may be inherited, but must not produce a lane override.
    await assertNoDeferral([`--base=${baseSha}`], { ...testEnv, PR_TESTS_DEFER_CRITICAL_OWNERS: "1" });
    fixture.changedFiles = ["worker/src/api/example.ts"];
    await assertNoDeferral([`--base=${baseSha}`]);
  });

  it("records classifier-selected Pages as deferred to CI without weakening a clean pass", async () => {
    fixture.changedFiles = ["worker/src/lib/evm-rpc.ts", "src/app/page.tsx"];
    const h = harness();
    expect(await runPrChecks([`--base=${baseSha}`], testEnv, h.options)).toBe(0);
    expect(h.runCommandImpl.mock.calls.some(([command]) => /coverage:critical|check:pages-artifact/.test(command.cmd))).toBe(false);
    expect(h.receipts[0]).toMatchObject({ weakened: false, outcome: "passed" });
    expect(h.receipts[0].leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pages-artifact", status: "deferred-to-ci" }),
    ]));
    expect(h.receipts[0].leaves.some((leaf) => leaf.id === "critical-coverage")).toBe(false);
    expect(h.runCommandImpl).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "pr-static:check:critical-coverage-completeness" }),
      expect.objectContaining({ PR_BASE_SHA: baseSha, PR_HEAD_SHA: headSha }),
    );
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
