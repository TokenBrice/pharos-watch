import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCiValidateStepPlan,
  buildNoncriticalTestShardCommands,
  buildValidatePrebuildRunnerArgs,
  PAGES_VALIDATE_COMMANDS,
  NONCRITICAL_TEST_SHARD_COUNT,
  VALIDATE_PREBUILD_MAX_PARALLEL,
  VALIDATE_PREBUILD_COMMANDS,
  VALIDATE_PREBUILD_TASK_NAMES,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validate-contract.mjs";
import {
  buildCriticalCoverageArgs,
  buildNoncriticalTestArgs,
  CRITICAL_TEST_FILES,
} from "../lib/critical-test-files.mjs";
import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import {
  buildPostPrebuildExecutionUnits,
  getPostPrebuildCommandEnv,
  runPostPrebuildValidation,
} from "../run-validate-postbuild.mjs";

function extractRunSteps(yaml) {
  const lines = yaml.split(/\r?\n/g);
  const steps = [];
  let current = null;

  function flushCurrent() {
    if (current?.cmd && current.cmd !== "|") {
      steps.push(current);
    }
    current = null;
  }

  for (const line of lines) {
    if (/^\s*-\s+(uses|run|if):/.test(line)) {
      flushCurrent();
      current = { cmd: null, condition: null };
    }

    if (!current) {
      continue;
    }

    const ifMatch = line.match(/^\s*if:\s+\$\{\{\s+inputs\.([a-z_]+)\s+\}\}\s*$/);
    if (ifMatch) {
      current.condition = ifMatch[1];
      continue;
    }

    const inlineIfMatch = line.match(/^\s*-\s+if:\s+\$\{\{\s+inputs\.([a-z_]+)\s+\}\}\s*$/);
    if (inlineIfMatch) {
      current.condition = inlineIfMatch[1];
      continue;
    }

    const trimmed = line.trim();
    const runPrefix = trimmed.startsWith("- ") ? "- run:" : "run:";
    if (trimmed.startsWith(runPrefix)) {
      current.cmd = trimmed.slice(runPrefix.length).trim();
      continue;
    }

    if (/^\s*-\s+uses:/.test(line)) {
      flushCurrent();
    }
  }

  flushCurrent();
  return steps;
}

function extractJobBlock(yaml: string, jobName: string, nextJobName?: string): string {
  const startMarker = `  ${jobName}:`;
  const start = yaml.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing workflow job block: ${jobName}`);
  }
  if (!nextJobName) {
    return yaml.slice(start);
  }
  const endMarker = `  ${nextJobName}:`;
  const end = yaml.indexOf(endMarker, start);
  return end === -1 ? yaml.slice(start) : yaml.slice(start, end);
}

describe("validate-ci parity", () => {
  it("keeps the shared CI validate workflow aligned with the merge-gate command contract", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const setupWorkspaceAction = readFileSync(
      resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"),
      "utf8",
    );
    const validatePrebuildJob = extractJobBlock(workflow, "validate-prebuild", "pages-build");
    const pagesBuildJob = extractJobBlock(workflow, "pages-build", "test-noncritical");
    const testNoncriticalJob = extractJobBlock(workflow, "test-noncritical", "coverage-critical");
    const coverageCriticalJob = extractJobBlock(workflow, "coverage-critical", "typecheck-worker");
    const typecheckWorkerJob = extractJobBlock(workflow, "typecheck-worker", "typecheck-worker-scripts");
    const typecheckWorkerScriptsJob = extractJobBlock(workflow, "typecheck-worker-scripts", "validate");
    const setupWorkspaceRunSteps = extractRunSteps(setupWorkspaceAction).filter((step) => step.cmd === "npm ci");

    expect([...setupWorkspaceRunSteps, ...extractRunSteps(validatePrebuildJob)]).toEqual([
      { cmd: "npm ci", condition: null },
      { cmd: "npm run validate:prebuild", condition: null },
    ]);
    expect(extractRunSteps(pagesBuildJob)).toEqual(PAGES_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: null })));
    expect(extractRunSteps(testNoncriticalJob)).toEqual([
      { cmd: "npm run test:noncritical -- --shard=${{ matrix.shard }}/3", condition: null },
    ]);
    expect(extractRunSteps(coverageCriticalJob)).toEqual([{ cmd: "npm run coverage:critical", condition: null }]);
    expect(extractRunSteps(typecheckWorkerJob)).toEqual([{ cmd: "npm run typecheck:worker", condition: null }]);
    expect(extractRunSteps(typecheckWorkerScriptsJob)).toEqual([
      { cmd: "npm run typecheck:worker-scripts", condition: null },
    ]);
  });

  it("does not keep a duplicate LTS validate lane after Node 24 became the baseline", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");

    expect(workflow).not.toContain("validate-lts:");
    expect(workflow).not.toContain("validate:lts");
  });

  it("runs the shared validate workflow on the Node 24 baseline", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const setupWorkspaceAction = readFileSync(
      resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"),
      "utf8",
    );

    expect(extractJobBlock(workflow, "validate-prebuild", "pages-build")).toContain("node-version: 24.x");
    expect(setupWorkspaceAction).toContain('default: "24"');
    expect(workflow).not.toContain("node-version: 25");
    expect(setupWorkspaceAction).not.toContain('default: "25"');
  });

  it("keeps validate:prebuild delegated to the shared registry", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["validate:prebuild"]).toBe("node scripts/run-validate-prebuild.mjs");
    expect(packageJson.scripts["test:noncritical"]).toBe("node scripts/run-noncritical-tests.mjs");
    expect(packageJson.scripts["coverage:critical"]).toBe("node scripts/run-critical-coverage.mjs");
    expect(VALIDATE_PREBUILD_COMMANDS).toEqual([
      "npm run audit:deps",
      "npm run audit:pricing-providers",
      "npm run lint",
      "npm run typecheck",
      "npm run check:cemetery-dataset",
      "npm run check:cron-abort-contract",
      "npm run check:cron-connections",
      "npm run check:cron-sync",
      "npm run check:doc-counts",
      "npm run check:doc-source-paths",
      "npm run check:doc-sync",
      "npm run check:duplicate-exports",
      "npm run check:env-contract",
      "npm run check:frozen-invariants",
      "npm run check:hotspot-ratchet",
      "npm run check:llms-txt",
      "npm run check:migrations",
      "npm run check:openapi",
      "npm run check:postman",
      "npm run check:redemption-backstops",
      "npm run check:shared-cycles",
      "npm run check:sql-safety",
      "npm run check:stablecoin-data",
      "npm run check:unused-code",
      "npm run check:verified-doc-links",
      "npm run check:world-map",
      "npm run check:worker-boundary",
    ]);
  });

  it("keeps the prebuild runner bounded while preserving the shared command set", () => {
    expect(VALIDATE_PREBUILD_TASK_NAMES).toEqual(VALIDATE_PREBUILD_COMMANDS.map((cmd) => cmd.slice("npm run ".length)));
    expect(buildValidatePrebuildRunnerArgs()).toEqual([
      "-l",
      "--aggregate-output",
      "--max-parallel",
      String(VALIDATE_PREBUILD_MAX_PARALLEL),
      ...VALIDATE_PREBUILD_TASK_NAMES,
    ]);
    expect(buildValidatePrebuildRunnerArgs({ continueOnError: true })).toEqual([
      "-l",
      "--aggregate-output",
      "--continue-on-error",
      "--max-parallel",
      String(VALIDATE_PREBUILD_MAX_PARALLEL),
      ...VALIDATE_PREBUILD_TASK_NAMES,
    ]);
  });

  it("keeps critical and non-critical test runners derived from one critical test list", () => {
    expect(buildCriticalCoverageArgs()).toEqual([
      "run",
      "--coverage",
      "--coverage.thresholds.lines=0",
      ...CRITICAL_TEST_FILES,
    ]);
    expect(buildNoncriticalTestArgs(["--reporter=dot"])).toEqual([
      "run",
      ...CRITICAL_TEST_FILES.flatMap((file) => ["--exclude", file]),
      "--reporter=dot",
    ]);
  });

  it("keeps the expanded validate contract model available for local planning", () => {
    expect(buildCiValidateStepPlan()).toEqual([
      { cmd: "npm run validate:prebuild", condition: null },
      ...PAGES_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: "pages_changed && run_pages_build_and_seo" })),
      ...buildNoncriticalTestShardCommands().map((cmd) => ({ cmd, condition: null })),
      { cmd: "npm run coverage:critical", condition: null },
      ...WORKER_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: "worker_changed" })),
    ]);
  });

  it("requires all non-critical Vitest shards in the reusable validate workflow", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const testNoncriticalJob = extractJobBlock(workflow, "test-noncritical", "coverage-critical");
    const validateJob = extractJobBlock(workflow, "validate");

    expect(NONCRITICAL_TEST_SHARD_COUNT).toBe(3);
    expect(buildNoncriticalTestShardCommands()).toEqual([
      "npm run test:noncritical -- --shard=1/3",
      "npm run test:noncritical -- --shard=2/3",
      "npm run test:noncritical -- --shard=3/3",
    ]);
    expect(testNoncriticalJob).toContain("shard: [1, 2, 3]");
    expect(testNoncriticalJob).toContain("fail-fast: false");
    expect(testNoncriticalJob).toContain("npm run test:noncritical -- --shard=${{ matrix.shard }}/3");
    expect(validateJob).toContain("- test-noncritical");
    expect(validateJob).toContain('["test-noncritical", process.env.TEST_NONCRITICAL_RESULT]');
  });

  it("keeps PR Pages build validation but lets deploy callers skip duplicate Pages build and SEO work", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const pagesBuildJob = extractJobBlock(workflow, "pages-build", "test-noncritical");
    const validateJob = extractJobBlock(workflow, "validate");

    expect(workflow).toContain("run_pages_build_and_seo:");
    expect(pagesBuildJob).toContain("if: ${{ inputs.pages_changed && inputs.run_pages_build_and_seo }}");
    expect(validateJob).toContain(
      "PAGES_BUILD_EXPECTED: ${{ inputs.pages_changed && inputs.run_pages_build_and_seo }}",
    );

    const deployWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/deploy-cloudflare.yml"), "utf8");
    const deployValidateJob = extractJobBlock(deployWorkflow, "validate", "no-deploy-required");
    expect(deployValidateJob).toContain("run_pages_build_and_seo: false");

    const deployWorkerJob = extractJobBlock(deployWorkflow, "deploy-worker", "smoke-api");
    expect(deployWorkerJob).toContain("- pages-prepare");
    expect(deployWorkerJob).toContain("needs.pages-prepare.result == 'success'");
  });

  it("keeps the critical coverage baseline aligned with the ratchet target list", () => {
    const baseline = JSON.parse(
      readFileSync(resolve(process.cwd(), ".ci/critical-coverage-baseline.json"), "utf8"),
    ) as { files: Record<string, number> };

    expect(Object.keys(baseline.files)).toEqual(CRITICAL_FILES);
  });

  it("runs post-prebuild CI checks in independent execution groups", () => {
    expect(
      buildPostPrebuildExecutionUnits({ pagesChanged: true, workerChanged: true }).map((unit) => unit.commands),
    ).toEqual([
      PAGES_VALIDATE_COMMANDS,
      ["npm run test:noncritical"],
      ["npm run coverage:critical"],
      ["npm run typecheck:worker"],
      ["npm run typecheck:worker-scripts"],
    ]);

    expect(
      buildPostPrebuildExecutionUnits({ pagesChanged: false, workerChanged: true }).map((unit) => unit.commands),
    ).toEqual([
      ["npm run test:noncritical"],
      ["npm run coverage:critical"],
      ["npm run typecheck:worker"],
      ["npm run typecheck:worker-scripts"],
    ]);
  });

  it("threads the coverage compare ref into the post-prebuild coverage command", () => {
    expect(
      getPostPrebuildCommandEnv("npm run coverage:critical", {
        coverageCompareRef: "abc123",
      }),
    ).toEqual({ CRITICAL_COVERAGE_COMPARE_REF: "abc123" });
    expect(getPostPrebuildCommandEnv("npm run test:noncritical", { coverageCompareRef: "abc123" })).toEqual({});
  });

  it("aborts sibling post-prebuild groups after the first failure", async () => {
    const calls: string[] = [];
    const aborted: string[] = [];
    let exitStatus: number | undefined;

    await runPostPrebuildValidation(
      { pagesChanged: true, workerChanged: true },
      {
        exit: (status) => {
          exitStatus = status;
        },
        runCommandImpl: (cmd, _extraEnv, { signal } = {}) => {
          calls.push(cmd);

          if (cmd === "npm run build") {
            return Promise.resolve({ status: 1, aborted: false });
          }

          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted.push(cmd);
              resolve({ status: 130, aborted: true });
            });
          });
        },
      },
    );

    expect(exitStatus).toBe(1);
    expect(calls).toContain("npm run build");
    expect(calls).not.toContain("npm run seo:check");
    expect(aborted).toEqual([
      "npm run test:noncritical",
      "npm run coverage:critical",
      "npm run typecheck:worker",
      "npm run typecheck:worker-scripts",
    ]);
  });
});
