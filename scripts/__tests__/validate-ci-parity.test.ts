import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { PUBLIC_DOCS } from "../../shared/lib/public-docs";
import {
  buildNoncriticalTestShardCommands,
  NONCRITICAL_TEST_SHARD_COUNT,
  VALIDATE_PREBUILD_MAX_PARALLEL,
} from "../lib/validation-lanes.mjs";
import {
  GENERATED_ARTIFACT_REGISTRY,
  buildGeneratedArtifactCommands,
  buildGeneratedArtifactPhases,
  findDuplicateDeployImpactExactPaths,
  selectGeneratedArtifacts,
} from "../lib/automation-registry.mjs";
import {
  buildCriticalCoverageArgs,
  buildNoncriticalTestArgs,
  CRITICAL_TEST_FILES,
  escapeCoverageIncludeGlob,
} from "../lib/critical-test-files.mjs";
import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import {
  buildGeneratedArtifactExecutionPhases,
  buildGeneratedArtifactExecutionUnits,
  GENERATED_ARTIFACTS_MAX_PARALLEL,
  parseGeneratedArtifactsArgs,
  parseGeneratedArtifactsSkip,
  resolveGeneratedArtifactsSkip,
  runGeneratedArtifacts,
} from "../maintenance/run-generated-artifacts.mjs";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
};

type WorkflowJob = {
  concurrency?: { group: string; "cancel-in-progress": boolean };
  environment?: { name: string; url?: string };
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  "runs-on"?: string;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: { "fail-fast": boolean; matrix: Record<string, unknown[]> };
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowDocument = {
  jobs: Record<string, WorkflowJob>;
  on: {
    schedule: Array<{ cron: string }>;
    workflow_call: {
      inputs: Record<string, Record<string, unknown>>;
      secrets: Record<string, Record<string, unknown>>;
    };
    workflow_dispatch: {
      inputs: Record<string, { options: string[] }>;
    };
  };
  permissions: Record<string, string>;
};

function readWorkflow(file: string): WorkflowDocument {
  return parseYaml(readFileSync(resolve(process.cwd(), file), "utf8")) as WorkflowDocument;
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

function extractFeatureFlagEnvReads(source: string): string[] {
  return [...source.matchAll(/process\.env\.(NEXT_PUBLIC_PHAROS_[A-Z_]+)/g)].map((match) => match[1]);
}

describe("validate-ci parity", () => {
  it("keeps the shared CI validate workflow on the fixed validation phase entrypoints", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const setupWorkspaceAction = readFileSync(
      resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"),
      "utf8",
    );
    const validatePrebuildJob = extractJobBlock(workflow, "validate-prebuild", "pages-build");
    const pagesBuildJob = extractJobBlock(workflow, "pages-build", "test-noncritical");
    const testNoncriticalJob = extractJobBlock(workflow, "test-noncritical", "typecheck-worker");
    const typecheckWorkerJob = extractJobBlock(workflow, "typecheck-worker", "validate");
    expect(setupWorkspaceAction).toContain("run: npm ci");
    expect(validatePrebuildJob).toContain("- run: npm run validate:prebuild");
    expect(validatePrebuildJob).toContain(
      "VALIDATE_PREBUILD_SURFACE: ${{ inputs.pages_changed && inputs.worker_changed && 'full' || inputs.pages_changed && 'pages' || inputs.worker_changed && 'worker' || 'full' }}",
    );
    expect(validatePrebuildJob).toContain(
      "VALIDATE_PREBUILD_INCLUDE_ADVISORY: ${{ inputs.include_advisory_prebuild && '1' || '0' }}",
    );
    expect(pagesBuildJob).toContain("- run: npm run validate:pages");
    expect(pagesBuildJob.match(/^\s+- run:/gm)).toHaveLength(1);
    expect(testNoncriticalJob).toContain("- run: npm run test:noncritical -- --shard=${{ matrix.shard }}/2");
    expect(typecheckWorkerJob).toContain("- run: npm run validate:worker");
    expect(typecheckWorkerJob.match(/^\s+- run:/gm)).toHaveLength(1);
    expect(workflow).not.toContain("coverage-critical:");
    expect(workflow).not.toContain("coverage-compare-ref:");
    expect(workflow).not.toContain("coverage-ratchet-all:");
  });

  it("does not keep a duplicate LTS validate lane after Node 24 became the baseline", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");

    expect(workflow).not.toContain("validate-lts:");
    expect(workflow).not.toContain("validate:lts");
  });

  it("runs GitHub workflows through the exact shared Node 24 baseline", () => {
    const workflowFiles = [
      ".github/workflows/critical-coverage-ratchet.yml",
      ".github/workflows/dependency-audit.yml",
      ".github/workflows/deploy-cloudflare.yml",
      ".github/workflows/og-refresh.yml",
      ".github/workflows/pages-release.yml",
      ".github/workflows/protocol-api-mechanism-refresh.yml",
      ".github/workflows/safe-browsing-monitor.yml",
      ".github/workflows/shock-coverage-refresh.yml",
      ".github/workflows/telegram-load.yml",
      ".github/workflows/validate-ci.yml",
    ];
    const workflows = workflowFiles
      .map((filePath) => readFileSync(resolve(process.cwd(), filePath), "utf8"))
      .join("\n");
    const setupWorkspaceAction = readFileSync(
      resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"),
      "utf8",
    );

    expect(workflows).toContain(
      "runs-on: ${{ vars.CI_VALIDATE_RUNNER != '' && vars.CI_VALIDATE_RUNNER || 'ubuntu-latest' }}",
    );
    expect(setupWorkspaceAction).toContain('default: "24.16.0"');
    expect(workflows).not.toContain("actions/setup-node@");
    expect(workflows).not.toContain("node-version:");
    expect(setupWorkspaceAction).not.toContain('default: "25"');
  });

  it("keeps protocol API refreshes target-isolated, append-only, replayed, and review-gated", () => {
    const filePath = ".github/workflows/protocol-api-mechanism-refresh.yml";
    const source = readFileSync(resolve(process.cwd(), filePath), "utf8");
    const workflow = readWorkflow(filePath);
    const refresh = workflow.jobs.refresh;

    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(refresh["runs-on"]).toBe(
      "${{ vars.CI_VALIDATE_RUNNER != '' && vars.CI_VALIDATE_RUNNER || 'ubuntu-latest' }}",
    );
    expect(refresh.strategy).toEqual({
      "fail-fast": false,
      matrix: { asset: ["usde-ethena", "usdf-falcon"] },
    });
    expect(refresh.concurrency).toEqual({
      group: "protocol-api-mechanism-refresh-${{ matrix.asset }}",
      "cancel-in-progress": false,
    });
    expect(refresh.steps?.some((step) => step.uses === "./.github/actions/setup-workspace")).toBe(true);
    expect(source).toContain('BRANCH="automated/protocol-api-mechanism-refresh/${ASSET_ID}"');
    expect(source).toContain('--state all --base main --head "$BRANCH"');
    expect(source).toContain("CLOSED_UNMERGED_COUNT");
    expect(source).toContain("closed-unmerged PR history");
    expect(source).toContain('--limit 100 --json number,state,mergedAt');
    expect(source).toContain('git ls-remote --exit-code --heads origin "$BRANCH"');
    expect(source).toContain('if [ "$REMOTE_STATUS" -eq 2 ]');
    expect(source).toContain('if [ "$OPEN_PR_COUNT" -ne 0 ]');
    expect(source).toContain('elif [ "$OPEN_PR_COUNT" -eq 1 ]');
    expect(source).toContain('elif [ "$OPEN_PR_COUNT" -gt 1 ]');
    expect(source.match(/git checkout -B "\$BRANCH" origin\/main/g)).toHaveLength(2);
    expect(source).toContain('git checkout -B "$BRANCH" "origin/$BRANCH"');
    expect(source).toContain("git rebase origin/main");
    expect(source).toContain('git config core.hooksPath "$EMPTY_HOOKS"');
    expect(source.indexOf('git config core.hooksPath "$EMPTY_HOOKS"')).toBeLessThan(
      source.indexOf('git checkout -B "$BRANCH" "origin/$BRANCH"'),
    );
    expect(source).toContain('git merge-base --is-ancestor "origin/$BRANCH" origin/main');
    expect(source).toContain("has unmerged commits but no open PR");
    expect(source).toContain("refusing to overwrite it");
    expect(source).toContain('measure-protocol-api-mechanism-metrics.ts --asset "$ASSET_ID"');
    expect(source).toContain("measure-protocol-api-mechanism-metrics.ts --replay-all");
    expect(source.match(/git diff --name-status origin\/main\.\.\.HEAD/g)).toHaveLength(3);
    expect(source).toContain('if [ "$status" != "A" ]');
    expect(source).toContain('git diff --quiet -- "$ROOT"');
    expect(source).toContain('git ls-files --others --exclude-standard -- "$ROOT"');
    expect(source).toContain('git add -- "$ROOT"');
    expect(source).toContain('git push --force-with-lease -u origin "$BRANCH"');
    expect(source).toContain("gh pr edit");
    expect(source).not.toContain("gh pr merge");
    expect(source).not.toContain("--auto");
  });

  it("threads every public Pharos feature flag into Pages build workflows", () => {
    const flagsSource = readFileSync(resolve(process.cwd(), "src/lib/feature-flags.ts"), "utf8");
    const validateWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const pagesReleaseWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/pages-release.yml"), "utf8");
    const flags = [...new Set(extractFeatureFlagEnvReads(flagsSource))].sort();

    for (const flag of flags) {
      expect(validateWorkflow).toContain(`${flag}: \${{ vars.${flag} }}`);
      expect(pagesReleaseWorkflow).toContain(`${flag}: \${{ vars.${flag} }}`);
    }
  });

  it("keeps validation entrypoints delegated to the shared runners", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["validate:prebuild"]).toBe("node scripts/maintenance/run-validate-prebuild.mjs");
    expect(packageJson.scripts["validate:pages"]).toBe("node scripts/maintenance/run-validation-phase.mjs pages");
    expect(packageJson.scripts["validate:worker"]).toBe("node scripts/maintenance/run-validation-phase.mjs worker");
    expect(packageJson.scripts["bootstrap:generated"]).toBe(
      "node scripts/maintenance/run-generated-artifacts.mjs --bootstrap",
    );
    expect(packageJson.scripts.prebuild).toBe("node scripts/maintenance/run-generated-artifacts.mjs");
    expect(packageJson.scripts["check:generated-artifacts"]).toBe(
      "node scripts/maintenance/run-generated-artifacts.mjs --check",
    );
    expect(packageJson.scripts["test:noncritical"]).toBe("node scripts/maintenance/run-noncritical-tests.mjs");
    expect(packageJson.scripts["coverage:critical"]).toBe("node scripts/maintenance/run-critical-coverage.mjs");
    expect(packageJson.scripts.prepare).toBe("node scripts/maintenance/prepare-workspace.mjs");
    expect(packageJson.scripts["validate:worker-scheduled-smoke"]).toBe(
      "vitest run worker/src/__tests__/index.scheduled.test.ts",
    );

    const noncriticalRunner = readFileSync(
      resolve(process.cwd(), "scripts/maintenance/run-noncritical-tests.mjs"),
      "utf8",
    );
    expect(noncriticalRunner).not.toContain("automation-registry");
    expect(noncriticalRunner).not.toContain('spawnSync("bash"');
  });

  it("keeps generated artifacts dependency-aware, reproducible, and bootstrap-scoped", () => {
    const expectedArtifacts = [
      ["stablecoin-catalog", 0, "deterministic", true, []],
      ["sitemap-dates", 0, "git-history-derived", false, []],
      ["case-study-client-index", 0, "deterministic", true, []],
      ["docs-metadata", 0, "git-history-derived", false, []],
      ["depeg-event-search-data", 0, "pinned-input", true, []],
      ["homepage-bootstrap", 0, "network-derived", false, []],
      ["postman", 0, "deterministic", true, []],
      ["openapi", 0, "deterministic", true, []],
      ["world-map", 0, "deterministic", true, []],
      ["safety-score-v8-evaluation-build", 0, "deterministic", true, []],
      ["safety-score-v9-shock-coverage-registry", 0, "pinned-input", true, []],
      ["safety-score-v9-evaluation-build", 0, "deterministic", true, []],
      ["stablecoin-prevalidated-registry", 1, "deterministic", true, ["stablecoin-catalog"]],
      ["legacy-stablecoin-redirects", 1, "deterministic", true, ["stablecoin-catalog"]],
      ["stablecoin-client-registry", 1, "deterministic", true, ["stablecoin-catalog"]],
      ["cemetery-dataset", 2, "deterministic", false, ["stablecoin-prevalidated-registry"]],
      ["public-datasets", 2, "network-derived", false, ["stablecoin-prevalidated-registry"]],
      ["llms-txt", 2, "network-derived", false, ["stablecoin-prevalidated-registry"]],
      ["api-reference", 2, "mixed", false, ["openapi"]],
      ["og-editorial", 3, "deterministic", false, []],
      ["og-learn", 3, "deterministic", false, []],
      ["og-case-studies", 3, "deterministic", false, ["cemetery-dataset"]],
    ];
    const expectedCommands = [
      "tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts",
      "tsx scripts/maintenance/generate-sitemap-dates.ts",
      "tsx scripts/maintenance/generate-case-study-client-index.ts",
      "tsx scripts/maintenance/generate-docs-metadata.ts",
      "tsx scripts/maintenance/generate-depeg-event-search-data.ts",
      "tsx scripts/maintenance/generate-homepage-bootstrap.ts",
      "tsx scripts/maintenance/generate-postman-collection.ts",
      "tsx scripts/maintenance/generate-openapi-spec.ts",
      "tsx scripts/maintenance/build-world-map-svg.ts",
      "tsx scripts/maintenance/generate-safety-score-v8-evaluation-build-manifest.ts",
      "tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts",
      "tsx scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts",
      "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
      "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
      "node scripts/build-data/build-client-registry.mjs",
      "tsx scripts/maintenance/generate-cemetery-dataset.ts",
      "tsx scripts/maintenance/generate-public-datasets.ts",
      "tsx scripts/maintenance/generate-llms-txt.ts",
      "node scripts/maintenance/generate-api-reference.mjs",
      "node scripts/maintenance/build-og-editorial.mjs",
      "tsx scripts/maintenance/build-og-learn-images.ts",
      "tsx scripts/maintenance/build-og-case-studies.ts",
    ];
    const expectedCheckCommands = [
      "tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts --check",
      "tsx scripts/maintenance/generate-sitemap-dates.ts --check",
      "tsx scripts/maintenance/generate-case-study-client-index.ts --check",
      "tsx scripts/maintenance/generate-docs-metadata.ts --check",
      "tsx scripts/maintenance/generate-depeg-event-search-data.ts --check",
      "tsx scripts/maintenance/generate-homepage-bootstrap.ts --check",
      "tsx scripts/maintenance/generate-postman-collection.ts --check",
      "tsx scripts/maintenance/generate-openapi-spec.ts --check",
      "tsx scripts/maintenance/build-world-map-svg.ts --check",
      "tsx scripts/maintenance/generate-safety-score-v8-evaluation-build-manifest.ts --check",
      "tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts --check",
      "tsx scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts --check",
      "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs --check",
      "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs --check",
      "node scripts/build-data/build-client-registry.mjs --check",
      "tsx scripts/maintenance/generate-cemetery-dataset.ts --check",
      "tsx scripts/maintenance/generate-public-datasets.ts --check",
      "tsx scripts/maintenance/generate-llms-txt.ts --check",
      "node scripts/maintenance/generate-api-reference.mjs --check",
      "node scripts/maintenance/build-og-editorial.mjs --check",
      "tsx scripts/maintenance/build-og-learn-images.ts --check",
      "tsx scripts/maintenance/build-og-case-studies.ts --check",
    ];

    expect(
      GENERATED_ARTIFACT_REGISTRY.map((artifact) => [
        artifact.id,
        artifact.phase,
        artifact.reproducibility,
        artifact.bootstrap === true,
        artifact.dependsOn ?? [],
      ]),
    ).toEqual(expectedArtifacts);
    expect(GENERATED_ARTIFACT_REGISTRY.every((artifact) => artifact.checkCommand)).toBe(true);
    expect(GENERATED_ARTIFACT_REGISTRY.every((artifact) => artifact.phase >= 0 && artifact.phase <= 3)).toBe(true);
    expect(GENERATED_ARTIFACT_REGISTRY.every((artifact) => artifact.sourcePaths.length > 0)).toBe(true);
    expect(GENERATED_ARTIFACT_REGISTRY.every((artifact) => artifact.outputPaths.length > 0)).toBe(true);
    expect(
      GENERATED_ARTIFACT_REGISTRY.filter((artifact) => artifact.inputState === "committed-history").map(
        (artifact) => artifact.id,
      ),
    ).toEqual(["sitemap-dates", "docs-metadata"]);
    expect(GENERATED_ARTIFACT_REGISTRY.find((artifact) => artifact.id === "docs-metadata")?.sourcePaths).toEqual(
      [
        "scripts/maintenance/generate-docs-metadata.ts",
        "shared/lib/public-docs.ts",
        ...PUBLIC_DOCS.map((doc) => `docs/${doc.source}`),
      ].sort(),
    );
    expect(
      GENERATED_ARTIFACT_REGISTRY.find((artifact) => artifact.id === "safety-score-v9-shock-coverage-registry"),
    ).toMatchObject({
      outputPaths: ["shared/data/safety-score-v9/shock-coverage-measurements-v1.json"],
      sourcePaths: [
        "scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts",
        "shared/data/safety-score-v9/mechanism-measurements/**/*-shock-coverage.json",
        "shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json",
      ],
    });
    expect(GENERATED_ARTIFACT_REGISTRY.filter((artifact) => artifact.bootstrap).map((artifact) => artifact.id)).toEqual(
      [
        "stablecoin-catalog",
        "case-study-client-index",
        "depeg-event-search-data",
        "postman",
        "openapi",
        "world-map",
        "safety-score-v8-evaluation-build",
        "safety-score-v9-shock-coverage-registry",
        "safety-score-v9-evaluation-build",
        "stablecoin-prevalidated-registry",
        "legacy-stablecoin-redirects",
        "stablecoin-client-registry",
      ],
    );
    expect(buildGeneratedArtifactCommands()).toEqual(expectedCommands);
    expect(buildGeneratedArtifactCommands({ check: true })).toEqual(expectedCheckCommands);
    expect(buildGeneratedArtifactExecutionUnits().map((unit) => unit.commands)).toEqual(
      expectedCommands.map((cmd) => [cmd]),
    );
    expect(buildGeneratedArtifactExecutionUnits({ check: true }).map((unit) => unit.commands)).toEqual(
      expectedCheckCommands.map((cmd) => [cmd]),
    );
    expect(buildGeneratedArtifactPhases().map(({ phase }) => phase)).toEqual([0, 1, 2, 3]);
    expect(
      buildGeneratedArtifactPhases().map(({ artifacts }) => artifacts.map((artifact: { id: string }) => artifact.id)),
    ).toEqual([
      expectedArtifacts.slice(0, 12).map(([id]) => id),
      expectedArtifacts.slice(12, 15).map(([id]) => id),
      expectedArtifacts.slice(15, 19).map(([id]) => id),
      expectedArtifacts.slice(19).map(([id]) => id),
    ]);
    expect(buildGeneratedArtifactExecutionPhases().map(({ phase }) => phase)).toEqual([0, 1, 2, 3]);
    expect(
      buildGeneratedArtifactExecutionPhases().map(({ units }) =>
        units.map((unit: { commands: string[] }) => unit.commands[0]),
      ),
    ).toEqual([
      expectedCommands.slice(0, 12),
      expectedCommands.slice(12, 15),
      expectedCommands.slice(15, 19),
      expectedCommands.slice(19),
    ]);
    expect(GENERATED_ARTIFACTS_MAX_PARALLEL).toBe(4);
  });

  it("keeps generated-artifact phase barriers and skip behavior intact", () => {
    const phaseById = new Map(GENERATED_ARTIFACT_REGISTRY.map((artifact) => [artifact.id, artifact.phase]));
    for (const artifact of GENERATED_ARTIFACT_REGISTRY) {
      for (const dependency of artifact.dependsOn ?? []) {
        expect(phaseById.get(dependency), `${artifact.id} depends on ${dependency}`).toBeLessThan(artifact.phase);
      }
    }

    const env = { ...process.env, GENERATED_ARTIFACTS_SKIP: "world-map, stablecoin-catalog, world-map" };
    expect(parseGeneratedArtifactsSkip(env)).toEqual(["world-map", "stablecoin-catalog", "world-map"]);
    expect(resolveGeneratedArtifactsSkip({ env })).toEqual(["world-map", "stablecoin-catalog", "world-map"]);
    expect(resolveGeneratedArtifactsSkip({ check: true, env })).toEqual([]);
    expect(
      buildGeneratedArtifactExecutionPhases({ skip: ["world-map"] }).flatMap(({ units }) =>
        units.map((unit: { commands: string[] }) => unit.commands[0]),
      ),
    ).not.toContain("tsx scripts/maintenance/build-world-map-svg.ts");
    expect(buildGeneratedArtifactCommands({ bootstrap: true })).toEqual(
      GENERATED_ARTIFACT_REGISTRY.filter((artifact) => artifact.bootstrap).map((artifact) => artifact.command),
    );
    expect(
      buildGeneratedArtifactPhases({ bootstrap: true }).map(({ artifacts }) =>
        artifacts.map((artifact: { id: string }) => artifact.id),
      ),
    ).toEqual([
      [
        "stablecoin-catalog",
        "case-study-client-index",
        "depeg-event-search-data",
        "postman",
        "openapi",
        "world-map",
        "safety-score-v8-evaluation-build",
        "safety-score-v9-shock-coverage-registry",
        "safety-score-v9-evaluation-build",
      ],
      ["stablecoin-prevalidated-registry", "legacy-stablecoin-redirects", "stablecoin-client-registry"],
    ]);
  });

  it("supports targeted generated-artifact selection without losing dependency barriers", async () => {
    expect(parseGeneratedArtifactsArgs(["--check", "--only=api-reference,og-case-studies", "--phase", "2,3"])).toEqual({
      bootstrap: false,
      check: true,
      continueOnError: false,
      dryRun: false,
      help: false,
      only: ["api-reference", "og-case-studies"],
      phases: [2, 3],
    });
    expect(selectGeneratedArtifacts({ only: ["api-reference"] }).map((artifact) => artifact.id)).toEqual([
      "openapi",
      "api-reference",
    ]);
    expect(buildGeneratedArtifactCommands({ check: true, only: ["api-reference"] })).toEqual([
      "tsx scripts/maintenance/generate-openapi-spec.ts --check",
      "node scripts/maintenance/generate-api-reference.mjs --check",
    ]);
    expect(
      buildGeneratedArtifactPhases({ phases: [3] }).map(({ artifacts }) =>
        artifacts.map((artifact: { id: string }) => artifact.id),
      ),
    ).toEqual([["og-editorial", "og-learn", "og-case-studies"]]);
    expect(() => buildGeneratedArtifactCommands({ only: ["missing-artifact"] })).toThrow(
      "Unknown generated artifact id(s): missing-artifact",
    );

    const logs: string[] = [];
    let executed = false;
    const result = await runGeneratedArtifacts({
      argv: ["--check", "--only=api-reference", "--dry-run"],
      log: (line: string) => logs.push(line),
      runCommandImpl: async () => {
        executed = true;
        return 0;
      },
    });

    expect(executed).toBe(false);
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false, failures: [], results: [] });
    expect(logs).toEqual([
      "[generated-artifacts] Dry run enabled; 2 command(s) will not execute.",
      "[generated-artifacts] Command plan:",
      "phase 0:",
      "  1. tsx scripts/maintenance/generate-openapi-spec.ts --check",
      "phase 2:",
      "  1. node scripts/maintenance/generate-api-reference.mjs --check",
    ]);
  });

  it("keeps the prebuild runner bounded while preserving the shared command set", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const runner = readFileSync(resolve(process.cwd(), "scripts/maintenance/run-validate-prebuild.mjs"), "utf8");

    expect(packageJson.devDependencies).not.toHaveProperty("npm-run-all2");
    expect(runner).toContain("runParallelExecutionUnits");
    expect(runner).toContain("buildValidatePrebuildCommands");
    expect(runner).toContain("VALIDATE_PREBUILD_SURFACE_ENV");
    expect(runner).toContain("VALIDATE_PREBUILD_MAX_PARALLEL");
    expect(runner).not.toContain("VALIDATE_PREBUILD_TIER");
    expect(runner).not.toContain("run-p");
    expect(VALIDATE_PREBUILD_MAX_PARALLEL).toBe(8);
  });

  it("keeps critical coverage scoped while the normal Vitest runner includes critical tests", () => {
    expect(escapeCoverageIncludeGlob(String.raw`functions/api/admin/[[path]]\draft.ts`)).toBe(
      String.raw`functions/api/admin/\[\[path\]\]\\draft.ts`,
    );
    expect(buildCriticalCoverageArgs()).toEqual([
      "run",
      "--coverage",
      "--coverage.thresholds.lines=0",
      ...CRITICAL_FILES.map((file) => `--coverage.include=${escapeCoverageIncludeGlob(file)}`),
      ...CRITICAL_TEST_FILES,
    ]);
    expect(buildNoncriticalTestArgs(["--reporter=dot"])).toEqual(["run", "--reporter=dot"]);

    const noncriticalRunner = readFileSync(
      resolve(process.cwd(), "scripts/maintenance/run-noncritical-tests.mjs"),
      "utf8",
    );
    const vitestConfig = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(noncriticalRunner).not.toContain("VITEST_EXCLUDE_CRITICAL_TESTS");
    expect(noncriticalRunner).not.toContain("NONCRITICAL_EXCLUDE_CRITICAL_TESTS_ENV");
    expect(vitestConfig).not.toContain("VITEST_EXCLUDE_CRITICAL_TESTS");
    expect(vitestConfig).not.toContain("criticalTestExcludes");
  });

  it("documents test:critical-contracts as a targeted runner instead of a separate CI lane", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const scriptsDoc = readFileSync(resolve(process.cwd(), "docs/scripts.md"), "utf8");
    const testingDoc = readFileSync(resolve(process.cwd(), "docs/testing.md"), "utf8");
    const ciCriticalSection = scriptsDoc.slice(
      scriptsDoc.indexOf("## CI-Critical Scripts"),
      scriptsDoc.indexOf("## Operational Notes"),
    );

    expect(workflow).not.toContain("npm run test:critical-contracts");
    expect(ciCriticalSection).not.toContain("run-critical-contracts.mjs");
    expect(testingDoc).toContain("`npm run test:critical-contracts` is a targeted local runner");
  });

  it("keeps deploy-impact exact path registries duplicate-free", () => {
    expect(findDuplicateDeployImpactExactPaths()).toEqual([]);
  });

  it("requires all normal Vitest shards in the reusable validate workflow", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const testNoncriticalJob = extractJobBlock(workflow, "test-noncritical", "typecheck-worker");
    const validateJob = extractJobBlock(workflow, "validate");

    expect(NONCRITICAL_TEST_SHARD_COUNT).toBe(2);
    expect(buildNoncriticalTestShardCommands()).toEqual([
      "npm run test:noncritical -- --shard=1/2",
      "npm run test:noncritical -- --shard=2/2",
    ]);
    expect(testNoncriticalJob).toContain("shard: [1, 2]");
    expect(testNoncriticalJob).toContain("fail-fast: false");
    expect(testNoncriticalJob).toContain("npm run test:noncritical -- --shard=${{ matrix.shard }}/2");
    expect(validateJob).toContain("- test-noncritical");
    expect(validateJob).toContain("node <<'NODE'");
    expect(validateJob).toContain("test-noncritical");
    expect(validateJob).not.toContain("- coverage-critical");
  });

  it("starts non-mutating validate leaf jobs without waiting for validate-prebuild", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");

    for (const [jobName, nextJobName] of [
      ["pages-build", "test-noncritical"],
      ["test-noncritical", "typecheck-worker"],
      ["typecheck-worker", "validate"],
    ] as const) {
      expect(extractJobBlock(workflow, jobName, nextJobName)).not.toContain("needs: validate-prebuild");
    }

    const validateJob = extractJobBlock(workflow, "validate");
    expect(validateJob).toContain("- validate-prebuild");
    expect(validateJob).toContain("- test-noncritical");
    expect(validateJob).not.toContain("- coverage-critical");
  });

  it("provides one required PR gate for full and docs-only validation paths", () => {
    const workflow = readWorkflow(".github/workflows/pull-request-checks.yml");
    const gate = workflow.jobs["pr-gate"];

    expect(gate.name).toBe("PR gate");
    expect(gate.if).toBe("${{ always() }}");
    expect(gate.needs).toEqual(["detect-changes", "validate", "validate-docs", "gitleaks"]);
    expect(JSON.stringify(gate)).toContain("Exactly one validation path must succeed");
  });

  it("keeps production deployment on one native DAG with one Worker mutation path", () => {
    const workflow = readWorkflow(".github/workflows/deploy-cloudflare.yml");

    expect(Object.keys(workflow.jobs)).toEqual(["plan", "deploy-worker", "pages-release"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.workflow_dispatch.inputs.surface.options).toEqual(["both", "pages", "worker"]);

    const plan = workflow.jobs.plan;
    expect(plan.outputs).toEqual({
      pages_required: "${{ steps.classify.outputs.pages_deploy_required }}",
      worker_required: "${{ steps.classify.outputs.worker_deploy_required }}",
    });

    const worker = workflow.jobs["deploy-worker"];
    expect(worker.needs).toBe("plan");
    expect(worker.environment).toMatchObject({ name: "production", url: "https://api.pharos.watch" });
    expect(worker["runs-on"]).toBe("ubuntu-latest");
    const workerText = JSON.stringify(worker);
    expect(workerText.match(/wrangler deploy --strict/g)).toHaveLength(1);
    expect(workerText).toContain("wrangler deploy --strict");
    expect(workerText).toContain("wrangler d1 migrations apply stablecoin-db --remote");
    expect(workerText).toContain("wrangler deployments status --json");
    expect(workerText).toContain("GitHub Actions deploy ${process.env.GITHUB_SHA}");
    expect(workerText).toContain("version?.percentage !== 100");
    expect(workerText).not.toContain("site-api.pharos.watch/api/health");
    expect(workerText).not.toContain("X-Pharos-Site-Proxy-Secret");
    expect(workerText).not.toContain("versions upload");
    expect(workerText).not.toContain("triggers deploy");
    expect(workerText).not.toContain("continue-on-error");
    expect(workerText).not.toContain("test:smoke-ui");
    expect(workerText).not.toContain("test:smoke-ops");
    expect(workerText).not.toContain("test:smoke-transport");
    expect(workerText).not.toContain("Auto rollback");

    const pages = workflow.jobs["pages-release"];
    expect(pages.needs).toEqual(["plan", "deploy-worker"]);
    expect(pages.uses).toBe("./.github/workflows/pages-release.yml");
    // Code deploys refresh digest/depeg/dataset snapshots (fail-open) so digest
    // surfaces stop regressing to the committed snapshot on every merge.
    expect(pages.with).toEqual({ refresh_data: true });
    expect(Object.keys(pages.secrets ?? {}).sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    expect(pages.if).toContain("needs.deploy-worker.result == 'success'");
    expect(pages.if).toContain("needs.plan.outputs.worker_required != 'true'");
  });

  it("keeps Pages publication deterministic and separates scheduled data refresh", () => {
    const workflow = readWorkflow(".github/workflows/pages-release.yml");
    const workflowCall = workflow.on.workflow_call;
    expect(workflowCall.inputs.refresh_data).toMatchObject({ default: false, type: "boolean" });
    expect(Object.keys(workflowCall.secrets).sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);

    const job = workflow.jobs["pages-release"];
    expect(job.environment).toMatchObject({ name: "production", url: "https://pharos.watch" });
    expect(job["runs-on"]).toBe("ubuntu-latest");
    const steps = job.steps ?? [];
    const refresh = steps.find((step) => step.name === "Refresh API-backed release data");
    const build = steps.find((step) => step.name === "Build clean production export");
    const deploy = steps.find((step) => step.name === "Deploy Pages");
    const resolveDeployment = steps.find((step) => step.name === "Resolve active Pages deployment");
    const marker = steps.find((step) => step.name === "Verify deployment release marker");
    expect(refresh?.if).toBe("${{ inputs.refresh_data }}");
    expect(refresh?.env).toMatchObject({
      DIGEST_API_URL: "https://stablecoin-dashboard.pages.dev/_site-data",
      DEPEG_EVENTS_API_URL: "https://stablecoin-dashboard.pages.dev/_site-data",
      PUBLIC_DATASETS_API_URL: "https://stablecoin-dashboard.pages.dev/_site-data",
      PUBLIC_DATASETS_REQUIRE_API: "1",
    });
    expect(refresh?.run).toContain("sync-digests.ts");
    expect(refresh?.run).toContain("sync-depeg-events.ts");
    expect(refresh?.run).not.toContain("--allow-archive-shrink");
    expect(refresh?.run).toContain("npm run generate:public-datasets");
    expect(build?.run).toContain("npm run build");
    expect(build?.env?.PUBLIC_DATASETS_API_URL).toBe("");
    expect(deploy?.run).toContain("wrangler pages deploy out");
    expect(deploy?.run).toContain('--commit-hash="${GITHUB_SHA}"');
    expect(resolveDeployment?.run).toContain("wrangler pages deployment list");
    expect(resolveDeployment?.run).toContain('deployment?.Environment !== "Production"');
    expect(resolveDeployment?.run).toContain('deployment?.Branch !== "main"');
    expect(marker?.env).toEqual({
      DEPLOYMENT_URL: "${{ steps.pages-deployment.outputs.deployment_url }}",
    });
    expect(marker?.run).toContain("wait-pages-release-marker.mjs");
    expect(marker?.run).toContain('"${DEPLOYMENT_URL}/__pharos_release.json"');
    expect(marker?.run).not.toContain("steps.pages-deployment.outputs.deployment_url");
    expect(marker?.run).toContain("GITHUB_STEP_SUMMARY");
    expect(marker?.run).not.toContain("pharos.watch");

    const jobText = JSON.stringify(job);
    expect(jobText.match(/wrangler pages deploy out/g)).toHaveLength(1);
    expect(jobText).toContain("npm run check:feature-flag-inlining");
    expect(jobText).toContain("npm run check:build-size");
    expect(jobText).toContain("npm run check:build-attribution");
    expect(jobText).toContain("npm run seo:check");
    expect(jobText).not.toContain("playwright");
    expect(jobText).not.toContain("serve:static-export");
    expect(jobText).not.toContain("test:smoke-ui");
    expect(jobText).not.toContain("test:smoke-ops");
    expect(jobText).not.toContain("test:smoke-transport");
    expect(jobText).not.toContain("SITE_API_SHARED_SECRET");
    expect(jobText).not.toContain("PAGES_RELEASE_ALLOW_EXISTING_DATA_ON_FETCH_FAILURE");
    expect(jobText).not.toContain("rollback-pages");
  });

  it("uses one main-only daily Pages refresh without fallback planning", () => {
    const workflow = readWorkflow(".github/workflows/rebuild-pages.yml");

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.schedule).toEqual([{ cron: "17 8 * * *" }]);
    expect(Object.keys(workflow.jobs)).toEqual(["pages-release"]);
    const release = workflow.jobs["pages-release"];
    expect(release.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    expect(release.uses).toBe("./.github/workflows/pages-release.yml");
    expect(release.with).toEqual({ refresh_data: true });
    expect(Object.keys(release.secrets ?? {}).sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  });

  it("keeps the critical coverage baseline aligned with the ratchet target list", () => {
    const baseline = JSON.parse(
      readFileSync(resolve(process.cwd(), ".ci/critical-coverage-baseline.json"), "utf8"),
    ) as { files: Record<string, number> };

    expect(Object.keys(baseline.files)).toEqual(CRITICAL_FILES);
  });
});
