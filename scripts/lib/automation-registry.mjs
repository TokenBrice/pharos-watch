import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY = [
  {
    command: "npm run validate:prebuild",
    deployImpact: "full",
    paths: ["scripts/maintenance/run-validate-prebuild.mjs", "scripts/lib/validate-contract.mjs"],
  },
  { command: "npm run audit:deps", deployImpact: "validation-only", paths: [] },
  {
    command: "npm run audit:pricing-providers",
    deployImpact: "full",
    paths: ["scripts/maintenance/audit-pricing-provider-config.ts"],
  },
  {
    command: "npm run check:provider-resilience",
    deployImpact: "full",
    paths: [
      "scripts/ci/check-provider-resilience.mjs",
      "scripts/lib/provider-resilience-registry.mjs",
    ],
  },
  { command: "npm run lint", deployImpact: "validation-only", paths: [] },
  { command: "npm run lint:typed", deployImpact: "validation-only", paths: [] },
  { command: "npm run typecheck", deployImpact: "validation-only", paths: [] },
  {
    command: "npm run check:agent-doc-sync",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-agent-doc-sync.mjs"],
  },
  {
    command: "npm run check:agent-skill-symlinks",
    deployImpact: "validation-only",
    paths: [
      "scripts/ci/check-agent-skill-symlinks.mjs",
      "scripts/lib/agent-skill-symlink-waivers.json",
    ],
  },
  {
    command: "npm run check:attestor-tier-coverage",
    deployImpact: "full",
    paths: ["scripts/ci/check-attestor-tier-coverage.ts"],
  },
  {
    command: "npm run check:cron-abort-contract",
    deployImpact: "full",
    paths: ["scripts/ci/check-cron-abort-contract.mjs"],
  },
  {
    command: "npm run check:cron-console-usage",
    deployImpact: "full",
    paths: [
      "scripts/ci/check-cron-console-usage.mjs",
      "scripts/lib/cron-console-usage-baseline.json",
    ],
  },
  {
    command: "npm run check:client-registry-imports",
    deployImpact: "pages",
    paths: ["scripts/ci/check-client-registry-imports.mjs"],
  },
  {
    command: "npm run check:cron-connections",
    deployImpact: "full",
    paths: ["scripts/ci/check-cron-connection-budget.ts"],
  },
  { command: "npm run check:cron-sync", deployImpact: "full", paths: ["scripts/ci/check-cron-schedule-sync.ts"] },
  {
    command: "npm run check:dependency-coverage",
    deployImpact: "full",
    paths: [
      "scripts/maintenance/generate-dependency-coverage-audit.ts",
      "scripts/lib/dependency-coverage-baseline.json",
    ],
  },
  { command: "npm run check:doc-counts", deployImpact: "validation-only", paths: ["scripts/ci/check-doc-counts.mjs"] },
  {
    command: "npm run check:doc-source-paths",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-doc-source-paths.mjs"],
  },
  { command: "npm run check:doc-sync", deployImpact: "validation-only", paths: ["scripts/ci/check-doc-sync.ts"] },
  {
    command: "npm run check:duplicate-exports",
    deployImpact: "full",
    paths: ["scripts/ci/check-duplicate-exports.mjs"],
  },
  { command: "npm run check:env-contract", deployImpact: "full", paths: ["scripts/ci/check-env-contract.mjs"] },
  {
    command: "npm run check:frozen-invariants",
    deployImpact: "full",
    paths: ["scripts/ci/check-frozen-invariants.ts"],
  },
  {
    command: "npm run check:generated-artifacts",
    deployImpact: "pages",
    paths: ["scripts/maintenance/run-generated-artifacts.mjs"],
  },
  {
    command: "npm run check:glossary-coverage",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-glossary-coverage.ts"],
  },
  {
    command: "npm run check:one-liner-coverage",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-one-liner-coverage.ts"],
  },
  {
    command: "npm run check:mechanism-archetype-coverage",
    deployImpact: "pages",
    paths: ["scripts/ci/check-mechanism-archetype-coverage.ts"],
  },
  {
    command: "npm run check:archetype-explainer-coverage",
    deployImpact: "pages",
    paths: ["scripts/ci/check-archetype-explainer-coverage.ts"],
  },
  {
    command: "npm run check:hook-polling-window",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-hook-polling-window.mjs"],
  },
  { command: "npm run check:hotspot-ratchet", deployImpact: "full", paths: ["scripts/ci/check-hotspot-ratchet.mjs"] },
  { command: "npm run check:migrations", deployImpact: "worker", paths: ["scripts/ci/check-worker-migrations.mjs"] },
  {
    command: "npm run check:price-bounds-parity",
    deployImpact: "full",
    paths: [
      "scripts/ci/check-price-bounds-parity.ts",
      "shared/lib/peg-price-bounds.ts",
      "shared/types/core.ts",
    ],
  },
  {
    command: "npm run check:redemption-backstops",
    deployImpact: "full",
    paths: ["scripts/ci/check-redemption-backstops.ts"],
  },
  {
    command: "npm run check:redemption-coverage-audit",
    deployImpact: "full",
    paths: [
      "scripts/maintenance/generate-redemption-coverage-audit.ts",
      "scripts/lib/redemption-coverage-audit-baseline.json",
    ],
  },
  {
    command: "npm run check:reserve-fixture-freshness",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-reserve-fixture-freshness.mjs"],
  },
  {
    command: "npm run check:selector-banned-phrases",
    deployImpact: "pages",
    paths: ["scripts/ci/check-selector-banned-phrases.mjs"],
  },
  {
    command: "npm run check:site-csp-sync",
    deployImpact: "full",
    paths: [
      "scripts/ci/check-site-csp-sync.ts",
      "shared/lib/site-csp.ts",
      "shared/lib/runtime-origins.json",
      "public/_headers",
    ],
  },
  { command: "npm run check:shared-cycles", deployImpact: "full", paths: ["scripts/ci/check-shared-cycles.mjs"] },
  {
    command: "npm run check:shared-types-imports",
    deployImpact: "full",
    paths: ["scripts/ci/check-shared-types-imports.mjs"],
  },
  {
    command: "npm run check:sql-safety",
    deployImpact: "worker",
    paths: ["scripts/ci/check-sql-interpolation-safety.mjs"],
  },
  {
    command: "npm run check:stale-flags",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-stale-flags.mjs"],
  },
  { command: "npm run check:stablecoin-data", deployImpact: "full", paths: ["scripts/ci/check-stablecoin-data.ts"] },
  {
    command: "npm run check:supply-helper-usage",
    deployImpact: "full",
    paths: ["scripts/ci/check-supply-helper-usage.mjs"],
  },
  {
    command: "npm run check:script-entrypoints",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-script-entrypoints.mjs"],
  },
  { command: "npm run check:unused-code", deployImpact: "full", paths: ["scripts/ci/check-unused-code.mjs"] },
  {
    command: "npm run check:verified-doc-links",
    deployImpact: "validation-only",
    paths: ["scripts/ci/check-verified-doc-links.mjs"],
  },
  { command: "npm run check:world-map", deployImpact: "pages", paths: ["scripts/maintenance/build-world-map-svg.ts"] },
  {
    command: "npm run check:worker-boundary",
    deployImpact: "full",
    paths: ["scripts/ci/check-worker-import-boundary.mjs"],
  },
  { command: "npm run build", deployImpact: "pages", paths: [] },
  { command: "npm run test:a11y", deployImpact: "pages", paths: [] },
  {
    command: "npm run check:feature-flag-inlining",
    deployImpact: "pages",
    paths: ["scripts/ci/check-feature-flag-inlining.mjs"],
  },
  { command: "npm run seo:check", deployImpact: "pages", paths: ["scripts/ci/check-seo-static.mjs"] },
  {
    command: "npm run check:phishing-signatures",
    deployImpact: "pages",
    paths: ["scripts/ci/check-phishing-signatures.mjs"],
  },
  {
    command: "npm run check:classifier-sensitive-copy",
    deployImpact: "pages",
    paths: ["scripts/ci/check-classifier-sensitive-copy.mjs"],
  },
  { command: "npm run check:build-size", deployImpact: "pages", paths: ["scripts/maintenance/report-build-size.mjs"] },
  {
    command: "npm run check:build-attribution",
    deployImpact: "pages",
    paths: ["scripts/ci/check-build-attribution.mjs"],
  },
  {
    command: "npm run test:noncritical",
    deployImpact: "full",
    paths: ["scripts/maintenance/run-noncritical-tests.mjs"],
  },
  {
    command: "npm run coverage:critical",
    deployImpact: "full",
    paths: ["scripts/maintenance/run-critical-coverage.mjs"],
  },
  { command: "npm run typecheck:worker", deployImpact: "worker", paths: [] },
  {
    command: "npm run validate:worker-scheduled-smoke",
    deployImpact: "worker",
    paths: ["worker/src/__tests__/index.scheduled.test.ts"],
  },
  {
    command: "npm run validate:pages-smoke",
    deployImpact: "pages",
    paths: ["scripts/maintenance/run-pages-smoke.mjs"],
  },
  {
    command: "npm run validate:worker-smoke",
    deployImpact: "worker",
    paths: ["scripts/maintenance/run-worker-smoke.mjs"],
  },
];

function getValidationCommandDeployImpactPaths(...impacts) {
  const impactSet = new Set(impacts);
  return [
    ...new Set(
      VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY.filter((entry) => impactSet.has(entry.deployImpact)).flatMap(
        (entry) => entry.paths,
      ),
    ),
  ].sort();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function readPackageLock(rootDir = REPO_ROOT) {
  return JSON.parse(readFileSync(resolve(rootDir, "package-lock.json"), "utf8"));
}

function packageLockKeyForPackageName(name) {
  return `node_modules/${name}`;
}

export function deriveWorkerRuntimePackageClosure(packageLock = readPackageLock()) {
  const packages = packageLock.packages ?? {};
  const workerPackage = packages.worker;
  const runtimePackages = new Set();

  function visitPackage(name) {
    if (runtimePackages.has(name)) return;
    runtimePackages.add(name);

    const entry = packages[packageLockKeyForPackageName(name)];
    if (!entry) return;

    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
    };
    for (const dependencyName of Object.keys(dependencies)) {
      visitPackage(dependencyName);
    }
  }

  for (const packageName of Object.keys(workerPackage?.dependencies ?? {})) {
    visitPackage(packageName);
  }

  return [...runtimePackages].sort();
}

const FULL_DEPLOY_GUARDRAIL_EXTRA_PATHS = [
  "scripts/ci/check-critical-coverage.mjs",
  "scripts/ci/check-seo-static.mjs",
  "scripts/ci/check-verified-doc-links.mjs",
  "scripts/maintenance/generate-cemetery-dataset.ts",
  "scripts/maintenance/generate-public-datasets.ts",
  "scripts/maintenance/rollback-pages-deployment.mjs",
  "scripts/maintenance/run-generated-artifacts.mjs",
  "scripts/maintenance/smoke-api.mjs",
  "scripts/maintenance/smoke-ops.mjs",
  "scripts/maintenance/smoke-transport.mjs",
  "scripts/maintenance/smoke-ui.mjs",
  "scripts/maintenance/test-merge-gate.mjs",
];

const PAGES_EXTRA_EXACT_PATHS = [
  "next.config.ts",
  "postcss.config.mjs",
  "scripts/maintenance/explain-build-chunks.mjs",
  "scripts/maintenance/generate-docs-metadata.ts",
  "scripts/maintenance/generate-homepage-bootstrap.ts",
  "scripts/maintenance/generate-llms-txt.ts",
  "scripts/maintenance/generate-markdown-exports.ts",
  "scripts/maintenance/generate-openapi-spec.ts",
  "scripts/maintenance/generate-postman-collection.ts",
  "scripts/maintenance/serve-static-export.mjs",
  "scripts/maintenance/sync-depeg-events.ts",
  "scripts/maintenance/sync-digests.ts",
  "scripts/maintenance/update-build-attribution-baseline.mjs",
  "tsconfig.json",
];

const WORKER_EXTRA_EXACT_PATHS = [
  "scripts/ci/check-cron-schedule-sync.ts",
  "scripts/ci/check-worker-import-boundary.mjs",
  "scripts/ci/check-worker-migrations.mjs",
  "scripts/maintenance/smoke-api.mjs",
];

export const DEPLOY_IMPACT_REGISTRY = {
  fullDeployInfra: {
    exactPaths: [
      ".github/workflows/deploy-cloudflare.yml",
      ".github/workflows/validate-ci.yml",
      "package-lock.json",
      "package.json",
      "scripts/ci/classify-deploy-changes.mjs",
    ],
    prefixes: [".github/actions/", ".github/scripts/", "scripts/lib/"],
  },
  fullDeployGuardrails: {
    exactPaths: uniqueSorted([
      ...getValidationCommandDeployImpactPaths("full", "validation-only", "worker"),
      ...FULL_DEPLOY_GUARDRAIL_EXTRA_PATHS,
    ]),
  },
  pages: {
    exactPaths: uniqueSorted([...getValidationCommandDeployImpactPaths("pages"), ...PAGES_EXTRA_EXACT_PATHS]),
    prefixes: ["data/", "functions/", "public/", "shared/", "src/"],
    workflowOnlyExactPaths: [
      ".github/workflows/pages-release.yml",
      ".github/workflows/rebuild-pages.yml",
    ],
  },
  worker: {
    exactPaths: uniqueSorted([...getValidationCommandDeployImpactPaths("worker"), ...WORKER_EXTRA_EXACT_PATHS]),
    prefixes: ["worker/"],
    sharedExcludedPaths: [
      "shared/lib/pharosville-api-contract.ts",
      "shared/lib/public-docs.ts",
      "shared/types/pharosville.ts",
    ],
    sharedExcludedPrefixes: [
      "shared/data/funding/",
      "shared/lib/selector/",
    ],
  },
  workerPromotion: {
    excludedPaths: ["worker/migrations/MANIFEST.md"],
    exactPaths: ["worker/package.json", "worker/tsconfig.json", "worker/wrangler.toml"],
    prefixes: ["worker/assets/", "worker/migrations/", "worker/src/"],
    sharedExcludedPaths: [
      "shared/lib/pharosville-api-contract.ts",
      "shared/lib/public-docs.ts",
      "shared/types/pharosville.ts",
    ],
    sharedExcludedPrefixes: [
      "shared/data/funding/",
      "shared/lib/selector/",
    ],
  },
  workerRootRuntimePackages: deriveWorkerRuntimePackageClosure(),
};

export function findDuplicateDeployImpactExactPaths(registry = DEPLOY_IMPACT_REGISTRY) {
  const groups = [
    ["fullDeployInfra", registry.fullDeployInfra.exactPaths],
    ["fullDeployGuardrails", registry.fullDeployGuardrails.exactPaths],
    ["pages", registry.pages.exactPaths],
    ["pages.workflowOnlyExactPaths", registry.pages.workflowOnlyExactPaths],
    ["worker", registry.worker.exactPaths],
    ["worker.sharedExcludedPaths", registry.worker.sharedExcludedPaths],
    ["workerPromotion.excludedPaths", registry.workerPromotion.excludedPaths],
    ["workerPromotion", registry.workerPromotion.exactPaths],
    ["workerPromotion.sharedExcludedPaths", registry.workerPromotion.sharedExcludedPaths],
  ];

  return groups.flatMap(([group, paths]) => {
    const seen = new Set();
    return paths
      .filter((path) => {
        if (seen.has(path)) return true;
        seen.add(path);
        return false;
      })
      .map((path) => `${group}:${path}`);
  });
}

export const GENERATED_ARTIFACT_REGISTRY = [
  {
    id: "agent-code-map",
    checkCommand: "node scripts/maintenance/generate-agent-code-map.mjs --check",
    command: "node scripts/maintenance/generate-agent-code-map.mjs",
    script: "scripts/maintenance/generate-agent-code-map.mjs",
  },
  {
    id: "sitemap-dates",
    checkCommand: "tsx scripts/maintenance/generate-sitemap-dates.ts --check",
    command: "tsx scripts/maintenance/generate-sitemap-dates.ts",
    noncriticalTestPrerequisite: true,
    script: "scripts/maintenance/generate-sitemap-dates.ts",
  },
  {
    id: "docs-metadata",
    checkCommand: "tsx scripts/maintenance/generate-docs-metadata.ts --check",
    command: "tsx scripts/maintenance/generate-docs-metadata.ts",
    noncriticalTestPrerequisite: true,
    script: "scripts/maintenance/generate-docs-metadata.ts",
  },
  {
    id: "depeg-event-search-data",
    checkCommand: "tsx scripts/maintenance/generate-depeg-event-search-data.ts --check",
    command: "tsx scripts/maintenance/generate-depeg-event-search-data.ts",
    script: "scripts/maintenance/generate-depeg-event-search-data.ts",
  },
  {
    id: "cemetery-dataset",
    checkCommand: "tsx scripts/maintenance/generate-cemetery-dataset.ts --check",
    command: "tsx scripts/maintenance/generate-cemetery-dataset.ts",
    script: "scripts/maintenance/generate-cemetery-dataset.ts",
  },
  {
    id: "public-datasets",
    checkCommand: "tsx scripts/maintenance/generate-public-datasets.ts --check",
    command: "tsx scripts/maintenance/generate-public-datasets.ts",
    script: "scripts/maintenance/generate-public-datasets.ts",
  },
  {
    id: "homepage-bootstrap",
    checkCommand: "tsx scripts/maintenance/generate-homepage-bootstrap.ts --check",
    command: "tsx scripts/maintenance/generate-homepage-bootstrap.ts",
    script: "scripts/maintenance/generate-homepage-bootstrap.ts",
  },
  {
    id: "postman",
    checkCommand: "tsx scripts/maintenance/generate-postman-collection.ts --check",
    command: "tsx scripts/maintenance/generate-postman-collection.ts",
    script: "scripts/maintenance/generate-postman-collection.ts",
  },
  {
    id: "openapi",
    checkCommand: "tsx scripts/maintenance/generate-openapi-spec.ts --check",
    command: "tsx scripts/maintenance/generate-openapi-spec.ts",
    script: "scripts/maintenance/generate-openapi-spec.ts",
  },
  {
    id: "llms-txt",
    checkCommand: "tsx scripts/maintenance/generate-llms-txt.ts --check",
    command: "tsx scripts/maintenance/generate-llms-txt.ts",
    script: "scripts/maintenance/generate-llms-txt.ts",
  },
  {
    id: "stablecoin-prevalidated-registry",
    checkCommand: "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs --check",
    command: "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
    script: "scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
  },
  {
    id: "legacy-stablecoin-redirects",
    checkCommand: "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs --check",
    command: "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
    script: "scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
  },
  {
    id: "stablecoin-client-registry",
    checkCommand: "node scripts/build-data/build-client-registry.mjs --check",
    command: "node scripts/build-data/build-client-registry.mjs",
    script: "scripts/build-data/build-client-registry.mjs",
  },
  {
    id: "api-reference",
    checkCommand: "node scripts/maintenance/generate-api-reference.mjs --check",
    command: "node scripts/maintenance/generate-api-reference.mjs",
    script: "scripts/maintenance/generate-api-reference.mjs",
  },
  {
    id: "og-editorial",
    checkCommand: "node scripts/maintenance/build-og-editorial.mjs --check",
    command: "node scripts/maintenance/build-og-editorial.mjs",
    script: "scripts/maintenance/build-og-editorial.mjs",
  },
  {
    id: "og-learn",
    checkCommand: "node scripts/maintenance/build-og-learn-images.mjs --check",
    command: "node scripts/maintenance/build-og-learn-images.mjs",
    script: "scripts/maintenance/build-og-learn-images.mjs",
  },
  {
    id: "og-case-studies",
    checkCommand: "node scripts/maintenance/build-og-case-studies.mjs --check",
    command: "node scripts/maintenance/build-og-case-studies.mjs",
    script: "scripts/maintenance/build-og-case-studies.mjs",
  },
];

export function buildGeneratedArtifactCommands({ check = false, skip = [] } = {}) {
  const skipIds = new Set(skip);
  return GENERATED_ARTIFACT_REGISTRY.filter((artifact) => !skipIds.has(artifact.id)).map((artifact) => {
    if (check && artifact.checkCommand) {
      return artifact.checkCommand;
    }
    return artifact.command;
  });
}

export function getNoncriticalTestGeneratedPrerequisites() {
  return GENERATED_ARTIFACT_REGISTRY.filter((artifact) => artifact.noncriticalTestPrerequisite === true).map(
    (artifact) => artifact.checkCommand,
  );
}
