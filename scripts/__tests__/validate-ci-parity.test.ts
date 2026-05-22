import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCiValidateStepPlan,
  buildNoncriticalTestShardCommands,
  PAGES_VALIDATE_COMMANDS,
  NONCRITICAL_TEST_SHARD_COUNT,
  VALIDATE_PREBUILD_MAX_PARALLEL,
  VALIDATE_PREBUILD_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validate-contract.mjs";
import {
  GENERATED_ARTIFACT_REGISTRY,
  buildGeneratedArtifactCommands,
  deriveWorkerRuntimePackageClosure,
  findDuplicateDeployImpactExactPaths,
  getNoncriticalTestGeneratedPrerequisites,
  DEPLOY_IMPACT_REGISTRY,
} from "../lib/automation-registry.mjs";
import {
  buildCriticalCoverageArgs,
  buildNoncriticalTestArgs,
  CRITICAL_TEST_FILES,
} from "../lib/critical-test-files.mjs";
import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import { buildGeneratedArtifactExecutionBatches } from "../maintenance/run-generated-artifacts.mjs";

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

function expectTextInOrder(text: string, snippets: readonly string[]): void {
  let lastIndex = -1;
  for (const snippet of snippets) {
    const index = text.indexOf(snippet);
    expect(index, snippet).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
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
    const typecheckWorkerJob = extractJobBlock(workflow, "typecheck-worker", "validate");
    const setupWorkspaceRunSteps = extractRunSteps(setupWorkspaceAction).filter((step) => step.cmd === "npm ci");

    expect([...setupWorkspaceRunSteps, ...extractRunSteps(validatePrebuildJob)]).toEqual([
      { cmd: "npm ci", condition: null },
      { cmd: "npm run validate:prebuild", condition: null },
    ]);
    expect(extractRunSteps(pagesBuildJob)).toEqual(PAGES_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: null })));
    expect(extractRunSteps(testNoncriticalJob)).toEqual([
      { cmd: "npm run test:noncritical -- --shard=${{ matrix.shard }}/4", condition: null },
    ]);
    expect(extractRunSteps(coverageCriticalJob)).toEqual([{ cmd: "npm run coverage:critical", condition: null }]);
    expect(extractRunSteps(typecheckWorkerJob)).toEqual([{ cmd: "npm run typecheck:worker", condition: null }]);
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
    expect(workflow).toContain(
      "runs-on: ${{ vars.CI_VALIDATE_RUNNER != '' && vars.CI_VALIDATE_RUNNER || 'ubuntu-latest' }}",
    );
    expect(setupWorkspaceAction).toContain('default: "24"');
    expect(workflow).not.toContain("node-version: 25");
    expect(setupWorkspaceAction).not.toContain('default: "25"');
  });

  it("keeps validate:prebuild delegated to the shared registry", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["validate:prebuild"]).toBe("node scripts/maintenance/run-validate-prebuild.mjs");
    expect(packageJson.scripts.prebuild).toBe("node scripts/maintenance/run-generated-artifacts.mjs");
    expect(packageJson.scripts["check:generated-artifacts"]).toBe(
      "node scripts/maintenance/run-generated-artifacts.mjs --check",
    );
    expect(packageJson.scripts["test:noncritical"]).toBe("node scripts/maintenance/run-noncritical-tests.mjs");
    expect(packageJson.scripts["coverage:critical"]).toBe("node scripts/maintenance/run-critical-coverage.mjs");
    expect(VALIDATE_PREBUILD_COMMANDS).toEqual([
      "npm run audit:deps",
      "npm run audit:pricing-providers",
      "npm run lint",
      "npm run typecheck",
      "npm run check:agent-doc-sync",
      "npm run check:attestor-tier-coverage",
      "npm run check:cron-abort-contract",
      "npm run check:cron-connections",
      "npm run check:cron-sync",
      "npm run check:doc-counts",
      "npm run check:doc-source-paths",
      "npm run check:doc-sync",
      "npm run check:duplicate-exports",
      "npm run check:env-contract",
      "npm run check:frozen-invariants",
      "npm run check:generated-artifacts",
      "npm run check:glossary-coverage",
      "npm run check:one-liner-coverage",
      "npm run check:mechanism-archetype-coverage",
      "npm run check:archetype-explainer-coverage",
      "npm run check:hook-polling-window",
      "npm run check:hotspot-ratchet",
      "npm run check:migrations",
      "npm run check:redemption-backstops",
      "npm run check:reserve-fixture-freshness",
      "npm run check:selector-banned-phrases",
      "npm run check:shared-cycles",
      "npm run check:shared-types-imports",
      "npm run check:sql-safety",
      "npm run check:stale-flags",
      "npm run check:stablecoin-data",
      "npm run check:supply-helper-usage",
      "npm run check:unused-code",
      "npm run check:verified-doc-links",
      "npm run check:world-map",
      "npm run check:worker-boundary",
    ]);
  });

  it("preserves generated artifact order through the shared prebuild registry and runner", () => {
    const expectedCommands = [
      "tsx scripts/maintenance/generate-sitemap-dates.ts",
      "tsx scripts/maintenance/generate-docs-metadata.ts",
      "tsx scripts/maintenance/generate-depeg-event-search-data.ts",
      "tsx scripts/maintenance/generate-cemetery-dataset.ts",
      "tsx scripts/maintenance/generate-public-datasets.ts",
      "tsx scripts/maintenance/generate-postman-collection.ts",
      "tsx scripts/maintenance/generate-openapi-spec.ts",
      "tsx scripts/maintenance/generate-llms-txt.ts",
      "node scripts/maintenance/generate-stablecoin-frozen-registry.mjs",
      "node scripts/build-data/build-client-registry.mjs",
      "node scripts/maintenance/generate-api-reference.mjs",
      "node scripts/maintenance/build-og-editorial.mjs",
    ];
    const expectedCheckCommands = [
      "tsx scripts/maintenance/generate-sitemap-dates.ts --check",
      "tsx scripts/maintenance/generate-docs-metadata.ts --check",
      "tsx scripts/maintenance/generate-depeg-event-search-data.ts --check",
      "tsx scripts/maintenance/generate-cemetery-dataset.ts --check",
      "tsx scripts/maintenance/generate-public-datasets.ts --check",
      "tsx scripts/maintenance/generate-postman-collection.ts --check",
      "tsx scripts/maintenance/generate-openapi-spec.ts --check",
      "tsx scripts/maintenance/generate-llms-txt.ts --check",
      "node scripts/maintenance/generate-stablecoin-frozen-registry.mjs --check",
      "node scripts/build-data/build-client-registry.mjs --check",
      "node scripts/maintenance/generate-api-reference.mjs --check",
      "node scripts/maintenance/build-og-editorial.mjs --check",
    ];

    expect(GENERATED_ARTIFACT_REGISTRY.map((artifact) => artifact.id)).toEqual([
      "sitemap-dates",
      "docs-metadata",
      "depeg-event-search-data",
      "cemetery-dataset",
      "public-datasets",
      "postman",
      "openapi",
      "llms-txt",
      "stablecoin-frozen-registry",
      "stablecoin-client-registry",
      "api-reference",
      "og-editorial",
    ]);
    expect(buildGeneratedArtifactCommands()).toEqual(expectedCommands);
    expect(buildGeneratedArtifactCommands({ check: true })).toEqual(expectedCheckCommands);
    expect(getNoncriticalTestGeneratedPrerequisites()).toEqual([
      "scripts/maintenance/generate-sitemap-dates.ts",
      "scripts/maintenance/generate-docs-metadata.ts",
    ]);
    expect(buildGeneratedArtifactExecutionBatches().map((batch) => batch.map((unit) => unit.commands))).toEqual(
      expectedCommands.map((cmd) => [[cmd]]),
    );
    expect(
      buildGeneratedArtifactExecutionBatches({ check: true }).map((batch) => batch.map((unit) => unit.commands)),
    ).toEqual(expectedCheckCommands.map((cmd) => [[cmd]]));
  });

  it("keeps the prebuild runner bounded while preserving the shared command set", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const runner = readFileSync(resolve(process.cwd(), "scripts/maintenance/run-validate-prebuild.mjs"), "utf8");

    expect(packageJson.devDependencies).not.toHaveProperty("npm-run-all2");
    expect(runner).toContain("runParallelExecutionUnits");
    expect(runner).toContain("VALIDATE_PREBUILD_COMMANDS");
    expect(runner).toContain("VALIDATE_PREBUILD_MAX_PARALLEL");
    expect(runner).not.toContain("run-p");
    expect(VALIDATE_PREBUILD_MAX_PARALLEL).toBe(8);
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

  it("documents test:critical-contracts as a targeted runner instead of a separate CI lane", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const scriptsDoc = readFileSync(resolve(process.cwd(), "docs/scripts.md"), "utf8");
    const testingDoc = readFileSync(resolve(process.cwd(), "docs/testing.md"), "utf8");
    const ciCriticalSection = scriptsDoc.slice(
      scriptsDoc.indexOf("## CI-Critical Scripts"),
      scriptsDoc.indexOf("## Operational Notes"),
    );

    expect(workflow).not.toContain("npm run test:critical-contracts");
    expect(buildCiValidateStepPlan().map((entry) => entry.cmd)).not.toContain("npm run test:critical-contracts");
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

    expect(NONCRITICAL_TEST_SHARD_COUNT).toBe(4);
    expect(buildNoncriticalTestShardCommands()).toEqual([
      "npm run test:noncritical -- --shard=1/4",
      "npm run test:noncritical -- --shard=2/4",
      "npm run test:noncritical -- --shard=3/4",
      "npm run test:noncritical -- --shard=4/4",
    ]);
    expect(testNoncriticalJob).toContain("shard: [1, 2, 3, 4]");
    expect(testNoncriticalJob).toContain("fail-fast: false");
    expect(testNoncriticalJob).toContain("npm run test:noncritical -- --shard=${{ matrix.shard }}/4");
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
    const deployValidateJob = extractJobBlock(deployWorkflow, "validate", "no-deploy-required");
    expect(deployValidateJob).toContain("run_pages_build_and_seo: false");

    const uploadWorkerJob = extractJobBlock(deployWorkflow, "upload-worker-version", "deploy-worker");
    expect(uploadWorkerJob).not.toContain("- validate");
    expect(uploadWorkerJob).not.toContain("Apply production D1 migrations");
    expect(uploadWorkerJob).not.toContain("Smoke uploaded preview worker");
    expect(uploadWorkerJob).toContain('install-deps: "false"');
    expect(uploadWorkerJob).toContain("Upload prep is intentionally optimized");
    expect(uploadWorkerJob).toContain("npx --yes wrangler@4.91.0 deployments status --json");
    expect(uploadWorkerJob).toContain("npx --yes wrangler@4.91.0 versions upload");
    expect(uploadWorkerJob).toContain("entitlements.not_available \\\\[code: 10007\\\\]");
    expect(uploadWorkerJob).toContain("version_upload_unavailable=true");

    const deployWorkerJob = extractJobBlock(deployWorkflow, "deploy-worker", "pages-release");
    expect(deployWorkerJob).toContain(
      "runs-on: ${{ vars.CI_WORKER_DEPLOY_RUNNER != '' && vars.CI_WORKER_DEPLOY_RUNNER || vars.CI_VALIDATE_RUNNER != '' && vars.CI_VALIDATE_RUNNER || 'ubuntu-latest' }}",
    );
    expect(deployWorkerJob).toContain("Wait for validation gate");
    expect(deployWorkerJob).toContain("Rehearse D1 migrations locally");
    expect(deployWorkerJob).toContain("Apply production D1 migrations");
    expect(deployWorkerJob).toContain("Smoke uploaded preview worker");
    expect(deployWorkerJob).toContain("needs.upload-worker-version.outputs.version_upload_unavailable != 'true'");
    expect(deployWorkerJob).toContain("Smoke production worker");
    expect(deployWorkerJob).toContain("Deploy worker with legacy Wrangler deploy fallback");
    expect(deployWorkerJob).toContain("cd worker && npx --no-install wrangler deploy");
    expect(deployWorkerJob).toContain('SMOKE_API_SCOPE: "canary"');
    expect(deployWorkerJob).toContain("Run worker-only live smokes");
    expect(deployWorkerJob).not.toContain("- pages-prepare");
    expect(deployWorkerJob).not.toContain("needs.pages-prepare.result == 'success'");

    const pagesReleaseJob = extractJobBlock(deployWorkflow, "pages-release");
    expect(pagesReleaseJob).toContain("needs:");
    expect(pagesReleaseJob).toContain("- detect-changes");
    expect(pagesReleaseJob).not.toContain("- upload-worker-version");
    expect(pagesReleaseJob).toContain("uses: ./.github/workflows/pages-release.yml");
    expect(pagesReleaseJob).toContain("direct_publish: true");
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
    const directPagesReleaseJob = extractJobBlock(pagesReleaseWorkflow, "pages-release-direct");
    expect(pagesReleaseWorkflow).toContain("direct_publish:");
    expect(directPagesReleaseJob).toContain("if: ${{ inputs.direct_publish }}");
    expect(directPagesReleaseJob).toContain("DEPEG_EVENTS_API_URL:");
    expect(directPagesReleaseJob).toContain("PUBLIC_DATASETS_API_URL:");
    expect(directPagesReleaseJob).toContain('PUBLIC_DATASETS_REQUIRE_API: "1"');
    expect(directPagesReleaseJob).toContain('NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true"');
    expect(directPagesReleaseJob).toContain("Fetch digests from the target API environment");
    expect(directPagesReleaseJob).toContain("Fetch depeg events from the target API environment");
    expect(directPagesReleaseJob).toContain("Generate public dataset mirrors from the target API environment");
    expect(directPagesReleaseJob).toContain('PUBLIC_DATASETS_API_URL: ""');
    expect(directPagesReleaseJob).toContain('PUBLIC_DATASETS_REQUIRE_API: ""');
    expect(directPagesReleaseJob).toContain("Start local export smoke server");
    expect(directPagesReleaseJob).toContain("Run local pre-publish checks in parallel");
    expect(directPagesReleaseJob).toContain("PAGES_UI_CHANGED: ${{ inputs.pages_ui_changed }}");
    expect(directPagesReleaseJob).toContain('SMOKE_UI_OVERFLOW_WORKERS: "6"');
    expect(directPagesReleaseJob).toContain("SMOKE_UI_OVERFLOW_ROUTES:");
    expect(directPagesReleaseJob).toContain("npm run test:smoke-ui:mobile -- --url http://127.0.0.1:4173");
    expect(directPagesReleaseJob).toContain("Wait for validation gate");
    expect(directPagesReleaseJob).toContain("if: ${{ inputs.wait_for_validate_job }}");
    expect(directPagesReleaseJob).toContain("Wait for worker promotion gate");
    expect(directPagesReleaseJob).toContain("if: ${{ inputs.wait_for_worker_promotion }}");
    expect(directPagesReleaseJob).toContain("Deploy Pages with retry");
    expect(directPagesReleaseJob).toContain("Capture Pages release metrics");
    expect(directPagesReleaseJob).toContain("Run post-publish smokes in parallel");
    expect(directPagesReleaseJob).toContain("--mode live --skip-overflow");
    expect(directPagesReleaseJob).toContain('SMOKE_OPS_SCOPE: "canary"');
    expect(directPagesReleaseJob).toContain("steps.post-publish-smokes.outputs.ui_status != 'success'");
    expectTextInOrder(directPagesReleaseJob, [
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
      "Start local export smoke server",
      "Run local pre-publish checks in parallel",
      "npm run seo:check",
    ]);
    expect(directPagesReleaseJob).not.toContain("npm run check:methodology-pdfs");

    expect(deployWorkflow).not.toContain("  pages-prepare:");
    expect(deployWorkflow).not.toContain("  pages-publish:");
    expect(deployWorkflow).not.toContain("  smoke-api:");
    expect(deployWorkflow).not.toContain("  rollback-worker:");
  });

  it("keeps reusable Pages preparation aligned with required production prebuild sync and guardrails", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/pages-prepare.yml"), "utf8");
    const buildPagesJob = extractJobBlock(workflow, "build-pages");
    const runSteps = extractRunSteps(buildPagesJob).map((step) => step.cmd);

    expect(workflow).toContain("DEPEG_EVENTS_API_KEY:");
    expect(workflow).toContain("PUBLIC_DATASETS_API_KEY:");
    expect(buildPagesJob).toContain("DEPEG_EVENTS_API_URL:");
    expect(buildPagesJob).toContain("PUBLIC_DATASETS_API_URL:");
    expect(buildPagesJob).toContain('PUBLIC_DATASETS_REQUIRE_API: "1"');
    expect(buildPagesJob).toContain('NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true"');
    expect(buildPagesJob).toContain('PUBLIC_DATASETS_API_URL: ""');
    expect(buildPagesJob).toContain('PUBLIC_DATASETS_REQUIRE_API: ""');
    expectTextInOrder(buildPagesJob, [
      "npx tsx scripts/maintenance/sync-digests.ts --output data/digests.json",
      "npx tsx scripts/maintenance/sync-depeg-events.ts --output data/depeg-events.json",
      "npm run generate:public-datasets",
      "npm run build",
    ]);
    expect(runSteps.slice(0, 8)).toEqual([
      "npm run build",
      "npm run check:feature-flag-inlining",
      "npm run seo:check",
      "npm run check:phishing-signatures",
      "npm run check:classifier-sensitive-copy",
      "npm run check:build-size",
      "npm run check:build-attribution",
      "npm run check:methodology-pdfs",
    ]);
  });

  it("forwards dedicated Pages data-sync secrets through the scheduled rebuild workflow", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/rebuild-pages.yml"), "utf8");
    const pagesReleaseJob = extractJobBlock(workflow, "pages-release");

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
