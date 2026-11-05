import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspectPrCheckout, runPrChecks, type RunPrChecksOptions } from "../maintenance/run-pr-checks.ts";
import { writePrCheckReceipt, type PrCheckReceipt } from "../lib/pr-check-receipt.mts";
import { assertFaithfulResourceReport, assertRequiredResourceCases, decideV9Contagion, RESOURCE_TEST_FILE, runV9ResourceLane } from "../maintenance/run-v9-resource-lane.ts";
import type * as ChangedFilesModule from "../lib/changed-files.mts";
import type * as CriticalOwnershipModule from "../lib/critical-ownership.mts";
import { RESOURCE_HARNESS_REVISION, RESOURCE_PHASES } from "../../worker/scripts/lib/v9-resource-policy";
import { V9_EVALUATION_BUILD_SOURCE_PATHS, runV9EvaluationBuildManifestGenerator as runManifest } from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";

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
const directories: string[] = [];
const tempDirectory = () => {
  const directory = mkdtempSync(resolve(tmpdir(), "pharos-pr-checks-"));
  directories.push(directory);
  return directory;
};
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const outputOf = (writer: { write: { mock: { calls: [string][] } } }) => writer.write.mock.calls.map(([chunk]) => chunk).join("");
const readText = (directory: string, name: string) => readFileSync(resolve(directory, name), "utf8");
const readJson = (directory: string, name: string) => JSON.parse(readText(directory, name));
const commandResult = (cmd: string, status = 0, output?: string) => ({
  status, aborted: false, output: output ?? (cmd.startsWith("git rev-parse") ? baseSha : cmd.startsWith("git show") ? "0" : ""),
});

const checkout = (treeClean = true, requestedHeadSha = headSha) => ({ headSha, requestedHeadSha, mergeBase: baseSha, treeClean });

function harness() {
  const receipts: PrCheckReceipt[] = [];
  const stdout = { write: vi.fn<(chunk: string) => unknown>() };
  const stderr = { write: vi.fn<(chunk: string) => unknown>() };
  const runCommandImpl = vi.fn(async (command: { cmd: string }) => commandResult(command.cmd));
  const runSecrets = vi.fn(async () => ({ ok: true, exitCode: 0, summary: "Trusted security clean." }));
  const selectPlanTestFiles = vi.fn(() => ["scripts/__tests__/runtime-guard.test.ts"]);
  const options: RunPrChecksOptions = {
    repoRoot,
    now: () => 0, stdout, stderr, runCommandImpl,
    runtimeVersions: () => ({ node: "24.16.0", npm: "11.13.0" }),
    inspectCheckout: () => checkout(),
    selectPlanTestFiles, runSecrets,
    writeReceipt: (receipt) => { receipts.push(receipt); return ".tmp/receipt.json"; },
  };
  return { options, receipts, stdout, stderr, runCommandImpl, runSecrets, selectPlanTestFiles,
    get receipt() { return receipts[0]; },
    get commands() { return runCommandImpl.mock.calls.map(([command]) => command.cmd); },
    run: (argv: readonly string[] = [`--base=${baseSha}`], env = testEnv) => runPrChecks(argv, env, options),
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => { fixture.changedFiles = ["worker/src/api/example.ts"]; h = harness(); });

describe("receipt explanation dispatch", () => {
  it("treats a missing receipt as a completed diagnostic, not readiness or a trigger to run checks", async () => {
    const root = tempDirectory();
    expect(await runPrChecks(["--explain-receipt"], testEnv, {
      ...h.options, repoRoot: root,
      inspectReceiptCheckout: () => ({ headSha, treeClean: true, baseRef: "origin/main" }),
    })).toBe(0);
    expect(outputOf(h.stdout)).toContain("Receipt: missing");
    expect(h.runCommandImpl).not.toHaveBeenCalled();
    expect(h.receipts).toEqual([]);
  });

  it("reports unreadable receipt evidence without overwriting it or falling through to the gate", async () => {
    const root = tempDirectory();
    const path = writePrCheckReceipt({
      schemaVersion: 1, node: "24.16.0", npm: "11.13.0", baseSha, headSha, treeClean: true,
      flags: {}, weakened: false, startedAt: "start", finishedAt: "finish", leaves: [], outcome: "passed",
    }, root);
    writeFileSync(path, "{invalid");
    expect(await runPrChecks(["--explain-receipt"], testEnv, {
      ...h.options, repoRoot: root,
      inspectReceiptCheckout: () => ({ headSha, treeClean: true, baseRef: "origin/main", localBaseSha: baseSha }),
    })).toBe(1);
    expect(outputOf(h.stderr)).toContain("Receipt explanation failed");
    expect(h.runCommandImpl).not.toHaveBeenCalled();
    expect(h.receipts).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("{invalid");
  });
});

describe("isolated V9 resource execution", () => {
  const contagion = "evaluates a bounded nine-scenario matrix within 256 MiB of old-space";
  const report = (cases: Array<{ title: string; status: string }>) => ({
    testResults: [{ name: resolve(repoRoot, RESOURCE_TEST_FILE), assertionResults: cases }],
  });

  const publicationBytes = { unit: "card", units: 396, largestUnitBytes: 85_123,
    unitLimitBytes: 106_404, streamedTotalBytes: 8_158_138, streamedTotalRegressionLimitBytes: 8_250_000, streamedTotalLimitBytes: 14_000_000 };
  const guardReport = (invocationId: string, publicationCycles: number) => ({
    schemaVersion: 1, invocationId, complete: true, diagnosticOnly: false,
    harnessRevision: RESOURCE_HARNESS_REVISION, profile: "compute", phaseManifest: "post-p2",
    violations: [], publicationCycles, policy: "unqualified", declaredPhases: [...RESOURCE_PHASES],
    stages: { bundle: { durationMs: 1000, builds: 2 }, setup: { durationMs: 2000, children: 1, failed: 0 },
      live: { durationMs: 3000, children: 1, failed: 0 }, natural: { durationMs: 2500, children: 1, failed: 0 },
      correctness: { durationMs: 1500, children: 2, failed: 0 } },
    runs: [{ violations: [], live: { status: 0, signal: null, reasons: [],
      phaseMaxima: Object.fromEntries(RESOURCE_PHASES.map((phase) => [phase, { postGcHeapBytes: 90 }])),
      correctness: { publicationBytes } },
      "hard-cap": { status: 0, signal: null, reasons: [], correctness: { publicationBytes } } }],
  });

  const resourceChild = (directory: string, cycles: number, commands: string[][] = []) => async (command: { args: readonly string[] }) => {
    commands.push([...command.args]);
    if (command.args.includes("worker/scripts/measure-v9-resource.ts")) {
      const id = command.args.find((arg) => arg.startsWith("--invocation-id="))!.split("=")[1];
      writeFileSync(resolve(directory, "report.json"), JSON.stringify(guardReport(id, cycles)));
    } else writeFileSync(resolve(directory, "vitest.json"), JSON.stringify(report([{ title: contagion, status: "passed" }])));
    return 0;
  };
  const runResource = (directory: string, options: Parameters<typeof runV9ResourceLane>[0]) =>
    runV9ResourceLane({ argv: [], outputDirectory: directory, resourceDirectory: directory, ...options });

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
    const directory = tempDirectory();
    writeFileSync(resolve(directory, "vitest.json"), JSON.stringify(report(
      [{ title: contagion, status: "passed" }],
    )));
    await expect(runResource(directory, { runCommand: async () => 0, env: {} })).rejects.toThrow();
  });

  it("rejects stale faithful reports and violations even when child statuses pass", () => {
    const faithful = { ...guardReport("previous-run", 2), policy: "qualified",
      appliedPolicy: { globalPostGcHeapBytes: 117440512, phaseLimitsBytes: Object.fromEntries(RESOURCE_PHASES.map(phase => [phase, 100])) } };
    const check = (value: unknown = faithful, cycles = 2, id = "previous-run") =>
      () => assertFaithfulResourceReport(value, id, cycles);
    expect(check(faithful, 2, "current-run")).toThrow("stale-resource-report");
    expect(() => assertFaithfulResourceReport(faithful, "previous-run")).not.toThrow();
    expect(check(faithful, 1)).toThrow("resource-cycle-count-mismatch");
    expect(check({ ...faithful, publicationCycles: 1 }, 1)).not.toThrow();
    expect(check({ ...faithful, publicationCycles: 1 }, 2)).toThrow("resource-cycle-count-mismatch");
    expect(check({ ...faithful, violations: [{ reason: "phase-budget-exceeded" }] })).toThrow();
    expect(check({ ...faithful, runs: [] })).toThrow();
    for (const declaredPhases of [[], ["phase"], RESOURCE_PHASES.slice(1), [...RESOURCE_PHASES].reverse(), [...RESOURCE_PHASES, "extra"]]) {
      expect(check({ ...faithful, declaredPhases })).toThrow();
    }
    expect(check({ ...faithful, harnessRevision: "obsolete" })).toThrow();
    expect(check({ ...faithful, runs: [{ ...faithful.runs[0], live: { ...faithful.runs[0].live, phaseMaxima: {} } }] })).toThrow("missing-resource-phase");
    const { appliedPolicy: _applied, ...unqualified } = faithful;
    expect(check({ ...unqualified, policy: "unqualified" })).not.toThrow();
    expect(check({ ...unqualified, policy: "qualified" })).toThrow("missing-applied-resource-policy");
    expect(check({ ...faithful, policy: "unqualified" })).toThrow("unqualified-resource-policy-applied");
    for (const mode of ["live", "hard-cap"] as const) {
      for (const invalid of [undefined, { publicationBytes: { ...publicationBytes, largestUnitBytes: 106_405 } },
        { publicationBytes: { ...publicationBytes, streamedTotalBytes: 8_250_001 } },
        { publicationBytes: { ...publicationBytes, streamedTotalBytes: 9_200_001 } }]) {
        expect(check({ ...faithful, runs: [{ ...faithful.runs[0],
          [mode]: { ...faithful.runs[0][mode], correctness: invalid } }] })).toThrow();
      }
      expect(check({ ...faithful, runs: [{ ...faithful.runs[0],
        [mode]: { ...faithful.runs[0][mode], status: null, signal: "SIGABRT" } }] })).toThrow();
    }
  });

  it("reports separate card-unit and streamed-total metrics without replacing natural memory status", async () => {
    const directory = tempDirectory();
    expect(await runResource(directory, { env: {},
      runCommand: resourceChild(directory, 2) })).toBe(0);
    const summary = readText(directory, "summary.md");
    for (const text of [
      "| live | 396 | 85123 | 106404 | 8158138 | 8250000 | 14000000 |",
      "| hard-cap | 396 | 85123 | 106404 | 8158138 | 8250000 | 14000000 |",
      "Natural 128 MiB exit status: 0", 'policy: **"unqualified"**', "2 publication cycles", "Contagion: **passed**",
    ]) expect(summary).toContain(text);
  });

  it("runs contagion only for a PR diff that reaches a contagion input and fails closed otherwise", () => {
    expect(decideV9Contagion(undefined, () => { throw new Error("must not read"); }))
      .toEqual({ required: true, reason: "no-pr-base", changedFiles: [] });
    expect(decideV9Contagion(baseSha, () => { throw new Error("git failed"); }))
      .toMatchObject({ required: true, reason: "diff-unavailable" });
    expect(decideV9Contagion(baseSha, () => [])).toMatchObject({ required: true, reason: "diff-unavailable" });
    expect(decideV9Contagion(baseSha, () => ["README.md", "src/app/page.tsx"]))
      .toEqual({ required: false, reason: "no-contagion-inputs", changedFiles: ["README.md", "src/app/page.tsx"] });
    for (const file of [
      "shared/lib/safety-score-v9/contagion.ts", "shared/lib/safety-score-v9/evaluate-set.ts",
      "shared/lib/dependency-graph.ts", "shared/lib/strongly-connected-components.ts",
      "shared/data/safety-score-v9/methodology-policy-candidate-v1.json",
      "shared/types/safety-score-v9-facts.ts", "worker/src/lib/safety-score-v9/fact-set.ts",
      "worker/src/lib/__tests__/safety-score-v9-resource-budget.test-support.ts",
      "worker/scripts/lib/v9-resource-policy.ts", "package-lock.json", "worker/wrangler.heavy.toml",
    ]) expect(decideV9Contagion(baseSha, () => [file]), file).toMatchObject({ required: true, reason: "contagion-inputs" });
  });

  it("skips the contagion step after a failed guard and records it as skipped", async () => {
    const directory = tempDirectory();
    const commands: string[] = [];
    await expect(runResource(directory, { env: {},
      runCommand: async (command) => { commands.push(command.cmd); return 1; },
    })).rejects.toThrow();
    expect(commands).toHaveLength(1);
    const lane = readJson(directory, "report.json").lane;
    expect(lane).toMatchObject({ prContext: false, publicationCycles: 2,
      contagion: { required: false, reason: "skipped-after-failure", status: "skipped" } });
    expect(readJson(directory, "contagion.json"))
      .toMatchObject({ required: false, reason: "skipped-after-failure", status: "skipped" });
    expect(readText(directory, "summary.md"))
      .toContain("Contagion: **skipped** (the guard measurement failed first)");
  });

  it.each([
    ["uses one publication cycle and runs no contagion when a PR diff has no contagion input", "README.md", false],
    ["runs the named contagion pass when a PR diff reaches a contagion input", "shared/lib/safety-score-v9/evaluate-set.ts", true],
  ] as const)("%s", async (_name, file, required) => {
    const directory = tempDirectory();
    const commands: string[][] = [];
    expect(await runResource(directory, {
      env: { PR_BASE_SHA: baseSha }, listChangedFiles: () => [file],
      runCommand: resourceChild(directory, 1, commands),
    })).toBe(0);
    expect(commands).toHaveLength(required ? 2 : 1);
    expect(commands[0]).toContain("--publication-cycles=1");
    const lane = readJson(directory, "report.json").lane;
    const contagion = { required, reason: required ? "contagion-inputs" : "no-contagion-inputs",
      status: required ? "passed" : "skipped", changedFiles: [file] };
    expect(lane.contagion).toMatchObject(contagion);
    const summary = readText(directory, "summary.md");
    if (required) expect(summary).toContain("Contagion: **passed**");
    else {
      expect(lane).toMatchObject({ prContext: true, publicationCycles: 1, contagion });
      expect(summary).toContain("1 publication cycle");
      expect(summary).toContain("Contagion: **skipped** (no contagion input changed)");
    }
  });

  it.each([
    { name: "a non-PR context", env: {}, cycles: 2, label: "no PR base (nightly/manual/local context)" },
    { name: "an unreadable PR diff", env: { PR_BASE_SHA: baseSha }, cycles: 1, label: "PR diff unavailable, so it fails closed" },
  ])("labels a passed contagion matrix for $name instead of calling it non-PR context", async ({ env, cycles, label }) => {
    const directory = tempDirectory();
    expect(await runResource(directory, {
      env, listChangedFiles: () => { throw new Error("must not read a diff"); },
      runCommand: resourceChild(directory, cycles),
    })).toBe(0);
    const summary = readText(directory, "summary.md");
    expect(summary).toContain(`Contagion: **passed** (nine-scenario matrix; ${label}).`);
    expect(summary).not.toContain("non-PR context");
  });

  it("keeps admission covered without probes under npm test despite ambient opt-in", () => {
    const directory = tempDirectory();
    execFileSync("npm", ["test", "--", RESOURCE_TEST_FILE,
      "--maxWorkers=1", "--no-file-parallelism", "--reporter=json", `--outputFile=${resolve(directory, "vitest.json")}`,
      "--coverage.enabled", "--coverage.include=worker/src/lib/safety-score-v9/resource-budget.ts",
      "--coverage.reporter=json", `--coverage.reportsDirectory=${directory}`,
    ], {
      cwd: repoRoot, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, PHAROS_V9_RESOURCE_LANE: "1", CONTAGION_MATRIX: "poison",
        SAFETY_SCORE_V9_RESOURCE_CAPTURE: "/missing/poison-capture.json" },
      stdio: "pipe",
    });
    const result = readJson(directory, "vitest.json");
    const coverage = readJson(directory, "coverage-final.json") as Record<string, { s: Record<string, number> }>;
    const admission = coverage[resolve(repoRoot, "worker/src/lib/safety-score-v9/resource-budget.ts")];
    expect(admission).toBeDefined();
    expect(Object.values(admission.s).some((hits) => hits > 0)).toBe(true);
    const cases = result.testResults.flatMap((file: { assertionResults: Array<{ title: string; status: string }> }) => file.assertionResults);
    expect(cases.find((test: { title: string }) => test.title === "uses the codec expanded-byte ceiling and preserves unknown measurement")?.status).toBe("passed");
    for (const title of [contagion, "keeps the frozen same-capture production envelope within both byte budgets"]) {
      expect(["skipped", "pending"]).toContain(cases.find((test: { title: string }) => test.title === title)?.status);
    }
  }, 65_000);

  it("runs the resource lane once after ordinary tests settle and records its outcome", async () => {
    fixture.changedFiles = ["worker/src/lib/safety-score-v9/resource-budget.ts"];
    let testing = false;
    const resourceCalls: string[] = [];
    h.runCommandImpl.mockImplementation(async (command) => {
      if (command.cmd.startsWith("git ")) return commandResult(command.cmd);
      if (command.cmd.includes("npm run test:pr")) {
        testing = true;
        await Promise.resolve();
        testing = false;
      }
      if (command.cmd === "npm run test:v9-resource") {
        expect(testing).toBe(false);
        resourceCalls.push(command.cmd);
        return commandResult(command.cmd, 1, "resource probe failed");
      }
      return commandResult(command.cmd);
    });
    expect(await h.run()).toBe(1);
    expect(resourceCalls).toHaveLength(1);
    expect(h.receipt.leaves.filter((leaf) => leaf.id === "v9-resource")).toEqual([
      expect.objectContaining({ status: "failed", command: "npm run test:v9-resource" }),
    ]);
  });
});

describe("readiness execution", () => {
  it.each([
    ["executes mixed-PR docs as static leaves and propagates a docs failure", "check:verified-doc-links"],
    ["propagates a failing router invariant from the shared docs command", "doc-ownership-invariants"],
  ])("%s", async (_name, failed) => {
    fixture.changedFiles = ["README.md", "src/app/page.tsx"];
    h.runCommandImpl.mockImplementation(async (command) =>
      commandResult(command.cmd, command.cmd.includes(failed === "doc-ownership-invariants" ? "pharos-change-contract.test.ts" : failed) ? 1 : 0));
    expect(await h.run()).toBe(1);
    expect(h.receipt.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `pr-static:${failed}`, status: "failed" }),
    ]));
    if (failed === "check:verified-doc-links") {
      expect(h.receipt.leaves.filter((leaf) => leaf.id.startsWith("pr-static:"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "pr-static:check:verified-doc-links", status: "failed" }),
        expect.objectContaining({ id: "pr-static:check:doc-sync", status: "passed" }),
        expect.objectContaining({ id: "pr-static:doc-ownership-invariants", status: "passed", command: "npm exec -- vitest run scripts/__tests__/doc-ownership-registry.test.ts scripts/__tests__/pharos-change-contract.test.ts" }),
      ]));
      expect(h.runCommandImpl.mock.calls.filter(([command]) => command.cmd === "npm run check:doc-sync")).toHaveLength(1);
    }
    expect(h.receipt.outcome).toBe("failed");
  });

  it("plans every selected command and test partition without executing a gate", async () => {
    expect(await h.run(["--plan", `--base=${baseSha}`])).toBe(0);
    expect(h.commands.every((cmd) => cmd.startsWith("git "))).toBe(true);
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(h.selectPlanTestFiles).toHaveBeenCalledWith(baseSha, fixture.changedFiles, testEnv);
    const output = outputOf(h.stdout);
    expect(output).toContain(headSha);
    expect(output).toContain("npm run check:test-corpus-budget");
    expect(output).toContain("npm run test:pr");
    expect(output).toContain("runtime-guard.test.ts");
    expect(output).toContain("CI partitions");
    expect(h.receipt.outcome).toBe("incomplete");
    expect(h.receipt.leaves.filter((leaf) => leaf.status !== "not-selected").every((leaf) => leaf.status === "skipped")).toBe(true);
  });

  it("fails Node 26 fast with mise guidance before refs or checks", async () => {
    h.options.runtimeVersions = () => ({ node: "26.10.0", npm: "12.2.0" });
    const inspect = vi.fn(h.options.inspectCheckout!);
    h.options.inspectCheckout = inspect;
    expect(await h.run([])).toBe(1);
    expect(h.runCommandImpl).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(outputOf(h.stderr)).toContain("mise settings add idiomatic_version_file_enable_tools node && mise install");
    expect(h.receipt.outcome).toBe("failed");
  });

  it("runs later independent leaves after both nonzero and thrown failures", async () => {
    h.runCommandImpl.mockImplementation(async (command) => {
      if (command.cmd.startsWith("git ")) return commandResult(command.cmd);
      if (command.cmd.includes("lint:changed")) return commandResult(command.cmd, 1, "> banner\nError: lint violation");
      if (command.cmd.includes("check:env-contract")) throw new Error("spawn ENOENT");
      return commandResult(command.cmd);
    });
    expect(await h.run()).toBe(1);
    expect(h.receipt.outcome).toBe("failed");
    expect(h.receipt.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pr-static:lint:changed", status: "failed", firstError: "Error: lint violation" }),
      expect.objectContaining({ id: "pr-static:check:env-contract", status: "failed", firstError: "spawn ENOENT" }),
      expect.objectContaining({ id: "pr-static:check:critical-coverage-completeness", status: "passed" }),
      expect.objectContaining({ id: "pr-tests", status: "passed" }),
    ]));
    const output = outputOf(h.stdout);
    expect(output).toContain("failed | 0 | npm run lint:changed");
    expect(output).toContain("spawn ENOENT");
    expect(h.runSecrets).toHaveBeenCalledWith({ baseSha, headSha, repoRoot });
  });

  it.each([
    ["reports clean successful execution as passed in both the receipt and JSON", true],
    ["keeps dirty authoring checks executable but makes their receipt and JSON incomplete", false],
  ] as const)("%s", async (_name, treeClean) => {
    h.options.inspectCheckout = () => checkout(treeClean);
    expect(await h.run([`--base=${baseSha}`, "--json"])).toBe(0);
    const incompleteReasons = treeClean ? [] : ["dirty-worktree"];
    expect(h.receipt).toMatchObject({ treeClean, weakened: !treeClean,
      outcome: treeClean ? "passed" : "incomplete", incompleteReasons });
    expect(JSON.parse(outputOf(h.stdout))).toMatchObject({ status: h.receipt.outcome, incompleteReasons });
    if (!treeClean) {
      expect(h.receipt.leaves.some((leaf) => leaf.status === "passed")).toBe(true);
      expect(h.runSecrets).toHaveBeenCalledOnce();
      expect(h.stderr.write.mock.calls.at(-1)?.[0]).toContain("dirty-worktree");
    }
  });

  it("never conceals a failed leaf behind dirty-worktree incompleteness", async () => {
    h.options.inspectCheckout = () => checkout(false);
    h.runSecrets.mockResolvedValue({ ok: false, exitCode: 1, summary: "Secret scan failed." });
    expect(await h.run([`--base=${baseSha}`, "--json"])).toBe(1);
    const report = JSON.parse(outputOf(h.stdout));
    expect(h.receipt).toMatchObject({ outcome: "failed", incompleteReasons: ["dirty-worktree"] });
    expect(report.status).toBe(h.receipt.outcome);
  });

  it("marks filtered successful invocations incomplete", async () => {
    expect(await h.run([`--base=${baseSha}`, "--testNamePattern=one case", "--json"])).toBe(0);
    expect(h.receipt).toMatchObject({ weakened: true, outcome: "incomplete" });
    expect(h.commands.some((cmd) => cmd.includes("--testNamePattern=one case"))).toBe(true);
    const report = JSON.parse(outputOf(h.stdout));
    expect(report.status).toBe(h.receipt.outcome);
  });

  it("rejects forwarded test plan-only arguments before any check", async () => {
    expect(await h.run(["--plan-out=.tmp/plan.json"])).toBe(1);
    expect(h.runCommandImpl).not.toHaveBeenCalled();
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(h.receipt.outcome).toBe("failed");
  });

  it("rejects an explicit head different from the checkout and binds failure to actual HEAD", async () => {
    h.options.inspectCheckout = () => checkout(true, "c".repeat(40));
    expect(await h.run([`--base=${baseSha}`, "--head=other"])).toBe(1);
    expect(h.runSecrets).not.toHaveBeenCalled();
    expect(h.commands.every((cmd) => cmd.startsWith("git "))).toBe(true);
    expect(h.receipt).toMatchObject({ headSha, outcome: "failed" });
    expect(outputOf(h.stderr)).toContain("Tests inspect the checkout");
  });

  it("never delegates critical-owner tests to local coverage or emits a deferral override", async () => {
    fixture.changedFiles = ["worker/src/lib/evm-rpc.ts"];
    const assertNoDeferral = async (argv: string[], env = testEnv) => {
      const h = harness();
      await h.run(argv, env);
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
    expect(await h.run()).toBe(0);
    expect(h.commands.some((cmd) => /coverage:critical|check:pages-artifact/.test(cmd))).toBe(false);
    expect(h.receipt).toMatchObject({ weakened: false, outcome: "passed" });
    expect(h.receipt.leaves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pages-artifact", status: "deferred-to-ci" }),
    ]));
    expect(h.receipt.leaves.some((leaf) => leaf.id === "critical-coverage")).toBe(false);
    expect(h.runCommandImpl).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "pr-static:check:critical-coverage-completeness" }),
      expect.objectContaining({ PR_BASE_SHA: baseSha, PR_HEAD_SHA: headSha }),
    );
  });
});

describe("local prepare execution", () => {
  it("collects independent prepare failures before later diagnostics without repair", async () => {
    const reason = "prepare failed";
    fixture.changedFiles = ["shared/data/stablecoins/canonical-order.json"];
    const prepare = ["test-corpus-budget", "incident-review-keys", "new-asset-evidence-packet", "safety-score-v9-evaluation-build"];
    const settled: string[] = [];
    const starts: string[][] = [];
    h.runCommandImpl.mockImplementation(async (command) => {
      if (command.cmd.startsWith("git ")) return commandResult(command.cmd);
      starts.push([...settled]);
      const id = prepare.find((id) => command.cmd.includes(id));
      if (!id) return commandResult(command.cmd);
      await Promise.resolve();
      settled.push(id);
      if (id === "incident-review-keys") throw new Error("spawn ENOENT");
      return commandResult(command.cmd, 1, reason);
    });
    expect(await h.run(["--base=moving-base", "--head=moving-head", "--with-pages", "--json"])).toBe(1);
    expect(starts).toEqual(starts.map((_, i) => prepare.slice(0, Math.min(i, prepare.length))));
    expect(settled).toEqual(prepare);
    expect(h.receipt).toMatchObject({ baseSha, headSha, outcome: "failed" });
    expect(h.receipt.leaves.filter((leaf) => prepare.includes(leaf.id)).map((leaf) => [leaf.id, leaf.status, leaf.firstError]))
      .toEqual(prepare.map((id) => [id, "failed", id === "incident-review-keys" ? "spawn ENOENT" : reason]));
    for (const id of ["pr-tests", "v9-resource", "pages-artifact", "gitleaks"]) {
      expect(h.receipt.leaves.find((leaf) => leaf.id === id)?.status).toBe("passed");
    }
    expect(JSON.parse(outputOf(h.stdout)).status).toBe("failed");
    expect(outputOf(h.stderr)).toContain("npm run generate:safety-score-v9-evaluation-build");
    for (const id of ["test-corpus-budget", "new-asset-evidence-packet"]) {
      expect(h.commands).toContain(`npm run check:${id} -- --base=${baseSha} --head=${headSha}`);
    }
    expect(h.commands.some((cmd) => /generate:|git (add|commit)|--(write|update|override)/.test(cmd))).toBe(false);
  });

  it.each([false, true])("refuses invalid manifest prerequisites read-only (missing: %s)", (missing) => {
    const root = tempDirectory();
    for (const path of V9_EVALUATION_BUILD_SOURCE_PATHS) {
      const file = resolve(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{}");
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
    runManifest([], root);
    const output = resolve(root, "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts");
    runManifest(["--check"], root);
    const input = resolve(root, "shared/data/stablecoins/coins.worker-full.generated.json");
    if (missing) unlinkSync(input);
    else writeFileSync(input, '{"changed":true}');
    const bytes = () => [readFileSync(output), existsSync(input) ? readFileSync(input) : null];
    const before = bytes();
    expect(() => runManifest(["--check"], root))
      .toThrow(missing ? "Missing Safety Score v9 evaluation-build sources:" : "exit 1");
    expect(bytes()).toEqual(before);
  });
});

it("detects tracked and untracked dirt while respecting ignored files and overriding hidden-untracked configuration", () => {
  const directory = tempDirectory();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
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
});
