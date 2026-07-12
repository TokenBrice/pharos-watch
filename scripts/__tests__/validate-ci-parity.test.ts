import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNoncriticalTestShardCommands,
  NONCRITICAL_TEST_SHARD_COUNT,
  VALIDATE_PREBUILD_MAX_PARALLEL,
} from "../lib/validation-lanes.mjs";
import {
  GENERATED_ARTIFACT_REGISTRY,
  buildGeneratedArtifactCommands,
  buildGeneratedArtifactPhases,
  deriveWorkerRuntimePackageClosure,
  findDuplicateDeployImpactExactPaths,
  getNoncriticalTestGeneratedPrerequisites,
  DEPLOY_IMPACT_REGISTRY,
} from "../lib/automation-registry.mjs";
import {
  buildCriticalCoverageArgs,
  buildNoncriticalTestArgs,
  CRITICAL_TEST_FILES,
  escapeCoverageIncludeGlob,
  NONCRITICAL_EXCLUDE_CRITICAL_TESTS_ENV,
} from "../lib/critical-test-files.mjs";
import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import {
  buildGeneratedArtifactExecutionPhases,
  buildGeneratedArtifactExecutionUnits,
  GENERATED_ARTIFACTS_MAX_PARALLEL,
  parseGeneratedArtifactsSkip,
  resolveGeneratedArtifactsSkip,
} from "../maintenance/run-generated-artifacts.mjs";

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

function expectTextInOrder(text: string, snippets: readonly string[]): void {
  let lastIndex = -1;
  for (const snippet of snippets) {
    const index = text.indexOf(snippet);
    expect(index, snippet).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
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
    const testNoncriticalJob = extractJobBlock(workflow, "test-noncritical", "coverage-critical");
    const coverageCriticalJob = extractJobBlock(workflow, "coverage-critical", "typecheck-worker");
    const typecheckWorkerJob = extractJobBlock(workflow, "typecheck-worker", "validate");
    expect(setupWorkspaceAction).toContain("run: npm ci");
    expect(validatePrebuildJob).toContain("- run: npm run validate:prebuild");
    expect(validatePrebuildJob).toContain(
      "VALIDATE_PREBUILD_SURFACE: ${{ inputs.pages_changed && inputs.worker_changed && 'full' || inputs.pages_changed && 'pages' || inputs.worker_changed && 'worker' || 'full' }}",
    );
    expect(pagesBuildJob).toContain("- run: npm run validate:pages");
    expect(pagesBuildJob.match(/^\s+- run:/gm)).toHaveLength(1);
    expect(testNoncriticalJob).toContain("- run: npm run test:noncritical -- --shard=${{ matrix.shard }}/2");
    expect(coverageCriticalJob).toContain("- run: npm run coverage:critical");
    expect(typecheckWorkerJob).toContain("- run: npm run validate:worker");
    expect(typecheckWorkerJob.match(/^\s+- run:/gm)).toHaveLength(1);
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
      ".github/workflows/pharos-change-contract.yml",
      ".github/workflows/safe-browsing-monitor.yml",
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
    expect(packageJson.scripts.prepare).toBe("npm run bootstrap:generated && git config core.hooksPath .githooks");
    expect(packageJson.scripts["validate:worker-scheduled-smoke"]).toBe(
      "vitest run worker/src/__tests__/index.scheduled.test.ts",
    );
  });

  it("keeps generated artifacts dependency-aware, reproducible, and bootstrap-scoped", () => {
    const expectedArtifacts = [
      ["stablecoin-catalog", 0, "deterministic", true, []],
      ["sitemap-dates", 0, "deterministic", false, []],
      ["case-study-client-index", 0, "deterministic", true, []],
      ["docs-metadata", 0, "deterministic", false, []],
      ["depeg-event-search-data", 0, "pinned-input", true, []],
      ["homepage-bootstrap", 0, "network-derived", false, []],
      ["postman", 0, "deterministic", true, []],
      ["openapi", 0, "deterministic", true, []],
      ["world-map", 0, "deterministic", true, []],
      ["stablecoin-prevalidated-registry", 1, "deterministic", true, ["stablecoin-catalog"]],
      ["legacy-stablecoin-redirects", 1, "deterministic", true, ["stablecoin-catalog"]],
      ["stablecoin-client-registry", 1, "deterministic", true, ["stablecoin-catalog"]],
      [
        "agent-code-map",
        2,
        "deterministic",
        true,
        ["stablecoin-prevalidated-registry", "legacy-stablecoin-redirects", "stablecoin-client-registry"],
      ],
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
      "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
      "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
      "node scripts/build-data/build-client-registry.mjs",
      "node scripts/maintenance/generate-agent-code-map.mjs",
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
      "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs --check",
      "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs --check",
      "node scripts/build-data/build-client-registry.mjs --check",
      "node scripts/maintenance/generate-agent-code-map.mjs --check",
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
    expect(GENERATED_ARTIFACT_REGISTRY.filter((artifact) => artifact.bootstrap).map((artifact) => artifact.id)).toEqual(
      [
        "stablecoin-catalog",
        "case-study-client-index",
        "depeg-event-search-data",
        "postman",
        "openapi",
        "world-map",
        "stablecoin-prevalidated-registry",
        "legacy-stablecoin-redirects",
        "stablecoin-client-registry",
        "agent-code-map",
      ],
    );
    expect(buildGeneratedArtifactCommands()).toEqual(expectedCommands);
    expect(buildGeneratedArtifactCommands({ check: true })).toEqual(expectedCheckCommands);
    expect(getNoncriticalTestGeneratedPrerequisites()).toEqual([
      "tsx scripts/maintenance/generate-sitemap-dates.ts --check",
      "tsx scripts/maintenance/generate-docs-metadata.ts --check",
    ]);
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
      expectedArtifacts.slice(0, 9).map(([id]) => id),
      expectedArtifacts.slice(9, 12).map(([id]) => id),
      expectedArtifacts.slice(12, 17).map(([id]) => id),
      expectedArtifacts.slice(17).map(([id]) => id),
    ]);
    expect(buildGeneratedArtifactExecutionPhases().map(({ phase }) => phase)).toEqual([0, 1, 2, 3]);
    expect(
      buildGeneratedArtifactExecutionPhases().map(({ units }) =>
        units.map((unit: { commands: string[] }) => unit.commands[0]),
      ),
    ).toEqual([
      expectedCommands.slice(0, 9),
      expectedCommands.slice(9, 12),
      expectedCommands.slice(12, 17),
      expectedCommands.slice(17),
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
      ["stablecoin-catalog", "case-study-client-index", "depeg-event-search-data", "postman", "openapi", "world-map"],
      ["stablecoin-prevalidated-registry", "legacy-stablecoin-redirects", "stablecoin-client-registry"],
      ["agent-code-map"],
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

  it("keeps critical and non-critical test runners derived from one critical test list", () => {
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

    // The critical-file exclusion rides vitest.config.ts (project include
    // lists ignore CLI --exclude), so pin the env contract on both sides.
    const noncriticalRunner = readFileSync(
      resolve(process.cwd(), "scripts/maintenance/run-noncritical-tests.mjs"),
      "utf8",
    );
    const vitestConfig = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(NONCRITICAL_EXCLUDE_CRITICAL_TESTS_ENV).toBe("VITEST_EXCLUDE_CRITICAL_TESTS");
    expect(noncriticalRunner).toContain("NONCRITICAL_EXCLUDE_CRITICAL_TESTS_ENV");
    expect(vitestConfig).toContain("NONCRITICAL_EXCLUDE_CRITICAL_TESTS_ENV");
    expect(vitestConfig).toContain("criticalTestExcludes");
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

  it("derives the Worker root runtime package set from the lockfile", () => {
    const packageLock = JSON.parse(readFileSync(resolve(process.cwd(), "package-lock.json"), "utf8"));

    expect(DEPLOY_IMPACT_REGISTRY.workerRootRuntimePackages).toEqual(deriveWorkerRuntimePackageClosure(packageLock));
    expect(DEPLOY_IMPACT_REGISTRY.workerRootRuntimePackages).toEqual(
      expect.arrayContaining(["@cf-wasm/resvg", "react", "satori", "viem", "zod"]),
    );
  });

  it("requires all non-critical Vitest shards in the reusable validate workflow", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const testNoncriticalJob = extractJobBlock(workflow, "test-noncritical", "coverage-critical");
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
  });

  it("starts non-mutating validate leaf jobs without waiting for validate-prebuild", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");

    for (const [jobName, nextJobName] of [
      ["pages-build", "test-noncritical"],
      ["test-noncritical", "coverage-critical"],
      ["coverage-critical", "typecheck-worker"],
      ["typecheck-worker", "validate"],
    ] as const) {
      expect(extractJobBlock(workflow, jobName, nextJobName)).not.toContain("needs: validate-prebuild");
    }

    const validateJob = extractJobBlock(workflow, "validate");
    expect(validateJob).toContain("- validate-prebuild");
    expect(validateJob).toContain("- test-noncritical");
    expect(validateJob).toContain("- coverage-critical");
  });

  it("keeps PR Pages build validation but lets production deploy overlap safe prep with validation", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const pagesBuildJob = extractJobBlock(workflow, "pages-build", "test-noncritical");
    const validateJob = extractJobBlock(workflow, "validate");

    expect(workflow).toContain("run_pages_build_and_seo:");
    expect(pagesBuildJob).toContain("if: ${{ inputs.pages_changed && inputs.run_pages_build_and_seo }}");
    expect(pagesBuildJob).toContain('NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true"');
    expect(validateJob).toContain(
      "PAGES_BUILD_EXPECTED: ${{ inputs.pages_changed && inputs.run_pages_build_and_seo }}",
    );

    const deployWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/deploy-cloudflare.yml"), "utf8");
    const productionRefGuardJob = extractJobBlock(deployWorkflow, "guard-production-ref", "detect-changes");
    expect(productionRefGuardJob).toContain('if [ "${GITHUB_REF}" != "refs/heads/main" ]; then');
    expect(extractJobBlock(deployWorkflow, "detect-changes", "validate")).toContain("needs: guard-production-ref");

    const deployValidateJob = extractJobBlock(deployWorkflow, "validate", "no-deploy-required");
    expect(deployValidateJob).toContain("run_pages_build_and_seo: false");

    const uploadWorkerJob = extractJobBlock(deployWorkflow, "upload-worker-version", "deploy-worker");
    expect(uploadWorkerJob).toContain("- validate");
    expect(uploadWorkerJob).not.toContain("Apply production D1 migrations");
    expect(uploadWorkerJob).not.toContain("Smoke uploaded preview worker");
    expect(uploadWorkerJob).toContain("uses: ./.github/actions/setup-workspace");
    expect(uploadWorkerJob).not.toContain("node-version:");
    expect(uploadWorkerJob).toContain("npx --no-install wrangler deployments status --json");
    expect(uploadWorkerJob).toContain("npx --no-install wrangler versions upload");
    expect(uploadWorkerJob).toContain("entitlements.not_available \\\\[code: 10007\\\\]");
    expect(uploadWorkerJob).toContain("version_upload_unavailable=true");
    expect(uploadWorkerJob).toContain("reduced rollback safety");

    const deployWorkerJob = extractJobBlock(deployWorkflow, "deploy-worker", "pages-release");
    expect(deployWorkerJob).toContain(
      "runs-on: ${{ vars.CI_WORKER_DEPLOY_RUNNER != '' && vars.CI_WORKER_DEPLOY_RUNNER || vars.CI_VALIDATE_RUNNER != '' && vars.CI_VALIDATE_RUNNER || 'ubuntu-latest' }}",
    );
    expect(deployWorkerJob).toContain("Wait for validation gate");
    expect(deployWorkerJob).toContain("Rehearse D1 migrations locally");
    expect(deployWorkerJob).toContain("Capture previous worker trigger config for rollback");
    expect(deployWorkerJob).toContain("Require previous worker version for automatic rollback");
    expect(deployWorkerJob).toContain("Worker rollback is not armed");
    expect(deployWorkerJob).toContain("Apply production D1 migrations");
    expect(deployWorkerJob).toContain("Smoke uploaded preview worker");
    expect(deployWorkerJob).toContain("needs.upload-worker-version.outputs.version_upload_unavailable != 'true'");
    expect(deployWorkerJob).toContain("node .github/scripts/deploy-worker-version.mjs");
    expect(deployWorkerJob).not.toContain("wrangler versions deploy");
    expect(deployWorkerJob).toContain("id: sync-worker-triggers");
    expect(deployWorkerJob).toContain("continue-on-error: true");
    expect(deployWorkerJob).toContain("Smoke production worker");
    expect(deployWorkerJob).toContain("Restore worker triggers after rollback");
    expect(deployWorkerJob).toContain("steps.sync-worker-triggers.outcome == 'failure'");
    expect(deployWorkerJob).toContain("wrangler triggers deploy --config .rollback-wrangler.toml");
    expect(deployWorkerJob).toContain("Deploy worker with legacy Wrangler deploy fallback");
    expect(deployWorkerJob).toContain("cd worker && npx --no-install wrangler deploy");
    expect(deployWorkerJob).toContain('SMOKE_API_SCOPE: "canary"');
    expect(deployWorkerJob).toContain("Run worker-only live smokes");
    expect(deployWorkerJob).toContain("id: worker-only-live-smokes");
    expect(deployWorkerJob).toContain("continue-on-error: true");
    expect(deployWorkerJob).toContain("SMOKE_UI_OVERFLOW_ROUTES: /depeg/");
    expect(deployWorkerJob).toContain("npm run test:smoke-ui -- --url https://pharos.watch --mode live");
    expect(deployWorkerJob).toContain("steps.worker-only-live-smokes.outcome == 'failure'");
    expect(deployWorkerJob).not.toContain("--mode live --skip-overflow");

    const pagesReleaseJob = extractJobBlock(deployWorkflow, "pages-release");
    expect(pagesReleaseJob).toContain("needs:");
    expect(pagesReleaseJob).toContain("- detect-changes");
    // The secret-bearing Pages release job must not start until validation
    // succeeds; the reusable workflow's internal wait remains defense in depth.
    expect(pagesReleaseJob).toContain("- validate");
    expect(pagesReleaseJob).not.toContain("- upload-worker-version");
    expect(pagesReleaseJob).toContain("uses: ./.github/workflows/pages-release.yml");
    expect(pagesReleaseJob).toContain(
      "pages_ui_changed: ${{ needs.detect-changes.outputs.pages_ui_changed == 'true' }}",
    );
    expect(pagesReleaseJob).toContain("wait_for_validate_job: true");
    expect(pagesReleaseJob).toContain(
      "wait_for_worker_promotion: ${{ needs.detect-changes.outputs.worker_promotion_required == 'true' }}",
    );
    expect(pagesReleaseJob).not.toContain("Fetch digests from the target API environment");
    expect(pagesReleaseJob).not.toContain("needs.upload-worker-version.outputs.preview_url");

    const pagesReleaseWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/pages-release.yml"), "utf8");
    const consolidatedPagesReleaseJob = extractJobBlock(pagesReleaseWorkflow, "pages-release");
    expect(consolidatedPagesReleaseJob).toContain("DEPEG_EVENTS_API_URL:");
    expect(consolidatedPagesReleaseJob).toContain("PUBLIC_DATASETS_API_URL:");
    expect(consolidatedPagesReleaseJob).toContain('PUBLIC_DATASETS_REQUIRE_API: "1"');
    expect(consolidatedPagesReleaseJob).toContain('NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true"');
    expect(consolidatedPagesReleaseJob).toContain("Install Chromium and fetch deploy data concurrently");
    expect(consolidatedPagesReleaseJob).toContain("Generate public dataset mirrors from the target API environment");
    expect(consolidatedPagesReleaseJob).toContain('PUBLIC_DATASETS_API_URL: ""');
    expect(consolidatedPagesReleaseJob).toContain('PUBLIC_DATASETS_REQUIRE_API: ""');
    expect(consolidatedPagesReleaseJob).toContain("Start local export smoke server");
    expect(consolidatedPagesReleaseJob).toContain("Run local pre-publish checks with bounded browser concurrency");
    expect(consolidatedPagesReleaseJob).toContain("PAGES_UI_CHANGED: ${{ inputs.pages_ui_changed }}");
    expect(consolidatedPagesReleaseJob).toContain('SMOKE_UI_OVERFLOW_WORKERS: "4"');
    expect(consolidatedPagesReleaseJob).toContain('SMOKE_PAGES_ASSET_WORKERS: "3"');
    expect(consolidatedPagesReleaseJob).toContain('SMOKE_PAGES_ASSET_TIMEOUT_MS: "60000"');
    expect(consolidatedPagesReleaseJob).toContain("SMOKE_UI_OVERFLOW_ROUTES:");
    expect(consolidatedPagesReleaseJob).toContain(
      "npm run test:smoke-pages-assets -- --url http://127.0.0.1:4173 --mode local",
    );
    expect(consolidatedPagesReleaseJob).toContain("npm run test:smoke-ui:mobile -- --url http://127.0.0.1:4173");
    expect(consolidatedPagesReleaseJob).toContain("Wait for validation gate");
    expect(consolidatedPagesReleaseJob).toContain("if: ${{ inputs.wait_for_validate_job }}");
    expect(consolidatedPagesReleaseJob).toContain("Wait for worker promotion gate");
    expect(consolidatedPagesReleaseJob).toContain("if: ${{ inputs.wait_for_worker_promotion }}");
    expect(consolidatedPagesReleaseJob).toContain("Run local artifact smoke against promoted worker");
    expect(consolidatedPagesReleaseJob).toContain("Deploy Pages with retry");
    expect(consolidatedPagesReleaseJob).toContain("Capture Pages release metrics");
    expect(consolidatedPagesReleaseJob).toContain("Fail because automated Pages rollback is not armed");
    expect(consolidatedPagesReleaseJob).not.toContain("Warn that automated Pages rollback is disabled");
    expect(consolidatedPagesReleaseJob).toContain("Run post-publish smokes in parallel");
    expect(consolidatedPagesReleaseJob).toContain("SMOKE_UI_OVERFLOW_ROUTES: /depeg/");
    expect(consolidatedPagesReleaseJob).toContain(
      "OPS_SMOKE_CF_ACCESS_CLIENT_ID: ${{ secrets.OPS_SMOKE_CF_ACCESS_CLIENT_ID }}",
    );
    expect(consolidatedPagesReleaseJob).toContain(
      "OPS_SMOKE_CF_ACCESS_CLIENT_SECRET: ${{ secrets.OPS_SMOKE_CF_ACCESS_CLIENT_SECRET }}",
    );
    expect(consolidatedPagesReleaseJob).toContain("npm run test:smoke-ui -- --url https://pharos.watch --mode live");
    expect(consolidatedPagesReleaseJob).toContain(
      "npm run test:smoke-pages-assets -- --url https://pharos.watch --mode live",
    );
    expect(consolidatedPagesReleaseJob).toContain("for attempt in 1 2 3 4 5 6 7 8 9 10");
    expect(consolidatedPagesReleaseJob).toContain("waiting for Pages asset propagation");
    expect(consolidatedPagesReleaseJob).not.toContain("--mode live --skip-overflow");
    expect(consolidatedPagesReleaseJob).toContain('SMOKE_OPS_SCOPE: "canary"');
    expect(consolidatedPagesReleaseJob).toContain("steps.post-publish-smokes.outputs.ui_status != 'success'");
    expect(consolidatedPagesReleaseJob).toContain("steps.post-publish-smokes.outputs.asset_status != 'success'");
    expect(consolidatedPagesReleaseJob).toContain("steps.post-publish-smokes.outputs.ops_status != 'success'");
    expect(consolidatedPagesReleaseJob).toContain("steps.post-publish-smokes.outputs.transport_status != 'success'");
    expectTextInOrder(consolidatedPagesReleaseJob, [
      "npx tsx scripts/maintenance/sync-digests.ts --output data/digests.json",
      "npx tsx scripts/maintenance/sync-depeg-events.ts --output data/depeg-events.json",
      "npm run generate:public-datasets",
      "npm run build",
      "npm run check:feature-flag-inlining",
      "npm run check:phishing-signatures",
      "npm run check:classifier-sensitive-copy",
      "npm run check:build-size",
      "Capture Pages release metrics",
      "npm run check:build-attribution",
      "Capture current production Pages deployment id",
      "Fail because automated Pages rollback is not armed",
      "Start local export smoke server",
      "Run local pre-publish checks with bounded browser concurrency",
      "npm run seo:check",
      "npm run test:a11y",
      "npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local",
      "npm run test:smoke-pages-assets -- --url http://127.0.0.1:4173 --mode local",
      "npm run test:smoke-ui:mobile -- --url http://127.0.0.1:4173",
      "Wait for validation gate",
      "Wait for worker promotion gate",
      "Run local artifact smoke against promoted worker",
      "Deploy Pages with retry",
    ]);
    expect(deployWorkflow).not.toContain("  smoke-api:");
    expect(deployWorkflow).not.toContain("  rollback-worker:");
  });

  it("keeps consolidated Pages release aligned with required production prebuild sync and guardrails", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/pages-release.yml"), "utf8");
    const pagesReleaseJob = extractJobBlock(workflow, "pages-release");

    expect(workflow).toContain("DEPEG_EVENTS_API_KEY:");
    expect(workflow).toContain("PUBLIC_DATASETS_API_KEY:");
    expect(pagesReleaseJob).toContain("DEPEG_EVENTS_API_URL:");
    expect(pagesReleaseJob).toContain("PUBLIC_DATASETS_API_URL:");
    expect(pagesReleaseJob).toContain('PUBLIC_DATASETS_REQUIRE_API: "1"');
    expect(pagesReleaseJob).toContain('NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true"');
    expect(pagesReleaseJob).toContain("fetch-depth: 0");
    expect(pagesReleaseJob).toContain("git-history-derived sitemap/docs metadata");
    expect(pagesReleaseJob).toContain('PUBLIC_DATASETS_API_URL: ""');
    expect(pagesReleaseJob).toContain('PUBLIC_DATASETS_REQUIRE_API: ""');
    expectTextInOrder(pagesReleaseJob, [
      "npx tsx scripts/maintenance/sync-digests.ts --output data/digests.json",
      "npx tsx scripts/maintenance/sync-depeg-events.ts --output data/depeg-events.json",
      "npm run generate:public-datasets",
      "npm run build",
      "npm run check:feature-flag-inlining",
      "npm run check:phishing-signatures",
      "npm run check:classifier-sensitive-copy",
      "npm run check:build-size",
      "Capture Pages release metrics",
      "npm run check:build-attribution",
      "Capture current production Pages deployment id",
      "Fail because automated Pages rollback is not armed",
      "Start local export smoke server",
      "Run local pre-publish checks with bounded browser concurrency",
      "npm run seo:check",
      "npm run test:a11y",
    ]);
  });

  it("forwards dedicated Pages data-sync secrets through the scheduled rebuild workflow", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/rebuild-pages.yml"), "utf8");
    const guardJob = extractJobBlock(workflow, "guard-production-ref", "pages-release");
    const pagesReleaseJob = extractJobBlock(workflow, "pages-release");

    expect(guardJob).toContain('if [ "${GITHUB_REF}" != "refs/heads/main" ]; then');
    expect(pagesReleaseJob).toContain("needs: guard-production-ref");
    expect(pagesReleaseJob).toContain("DEPEG_EVENTS_API_KEY:");
    expect(pagesReleaseJob).toContain("PUBLIC_DATASETS_API_KEY:");
  });

  it("keeps the critical coverage baseline aligned with the ratchet target list", () => {
    const baseline = JSON.parse(
      readFileSync(resolve(process.cwd(), ".ci/critical-coverage-baseline.json"), "utf8"),
    ) as { files: Record<string, number> };

    expect(Object.keys(baseline.files)).toEqual(CRITICAL_FILES);
  });
});
