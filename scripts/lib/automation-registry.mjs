import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY } from "./validation-command-registry.mjs";

export { VALIDATION_COMMAND_DEPLOY_IMPACT_REGISTRY };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
  "scripts/maintenance/run-merge-gate-discovery.mjs",
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
  "scripts/maintenance/wait-pages-release-marker.mjs",
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
    workflowOnlyExactPaths: [".github/workflows/pages-release.yml", ".github/workflows/rebuild-pages.yml"],
  },
  worker: {
    exactPaths: uniqueSorted([...getValidationCommandDeployImpactPaths("worker"), ...WORKER_EXTRA_EXACT_PATHS]),
    prefixes: ["worker/"],
    sharedExcludedPaths: [
      "shared/lib/pharosville-api-contract.ts",
      "shared/lib/public-docs.ts",
      "shared/types/pharosville.ts",
    ],
    sharedExcludedPrefixes: ["shared/data/funding/", "shared/lib/selector/"],
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
    sharedExcludedPrefixes: ["shared/data/funding/", "shared/lib/selector/"],
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
    id: "case-study-client-index",
    checkCommand: "tsx scripts/maintenance/generate-case-study-client-index.ts --check",
    command: "tsx scripts/maintenance/generate-case-study-client-index.ts",
    script: "scripts/maintenance/generate-case-study-client-index.ts",
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
    checkCommand: "tsx scripts/maintenance/build-og-learn-images.ts --check",
    command: "tsx scripts/maintenance/build-og-learn-images.ts",
    script: "scripts/maintenance/build-og-learn-images.ts",
  },
  {
    id: "og-case-studies",
    checkCommand: "tsx scripts/maintenance/build-og-case-studies.ts --check",
    command: "tsx scripts/maintenance/build-og-case-studies.ts",
    script: "scripts/maintenance/build-og-case-studies.ts",
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
