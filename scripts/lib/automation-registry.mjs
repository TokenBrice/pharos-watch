import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VALIDATION_IMPACT_PATHS } from "./validation-lanes.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function getValidationCommandDeployImpactPaths(...impacts) {
  return [...new Set(impacts.flatMap((impact) => VALIDATION_IMPACT_PATHS[impact] ?? []))].sort();
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

// These Markdown sources are compiled into public /docs/* routes. Keep this
// list aligned with PUBLIC_DOCS; the classifier test fails on drift.
const PUBLIC_DOC_SOURCE_PATHS = [
  "docs/api-reference.md",
  "docs/architecture.md",
  "docs/chain-health.md",
  "docs/classification.md",
  "docs/data-flow-map.md",
  "docs/data-pipeline.md",
  "docs/depeg-detection.md",
  "docs/design-context.md",
  "docs/design-language.md",
  "docs/design-tokens.md",
  "docs/dews.md",
  "docs/dex-liquidity.md",
  "docs/mint-burn-flows.md",
  "docs/pricing-pipeline.md",
  "docs/redemption-backstops.md",
  "docs/report-cards.md",
  "docs/shadow-stablecoins.md",
  "docs/stability-index.md",
  "docs/worker-and-api-limits.md",
  "docs/yield-intelligence.md",
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
    exactPaths: uniqueSorted([
      ...getValidationCommandDeployImpactPaths("pages"),
      ...PAGES_EXTRA_EXACT_PATHS,
      ...PUBLIC_DOC_SOURCE_PATHS,
    ]),
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
    id: "stablecoin-catalog",
    checkCommand: "tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts --check",
    command: "tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-stablecoin-per-coin-asset.ts",
  },
  {
    id: "sitemap-dates",
    checkCommand: "tsx scripts/maintenance/generate-sitemap-dates.ts --check",
    command: "tsx scripts/maintenance/generate-sitemap-dates.ts",
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-sitemap-dates.ts",
  },
  {
    id: "case-study-client-index",
    checkCommand: "tsx scripts/maintenance/generate-case-study-client-index.ts --check",
    command: "tsx scripts/maintenance/generate-case-study-client-index.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-case-study-client-index.ts",
  },
  {
    id: "docs-metadata",
    checkCommand: "tsx scripts/maintenance/generate-docs-metadata.ts --check",
    command: "tsx scripts/maintenance/generate-docs-metadata.ts",
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-docs-metadata.ts",
  },
  {
    id: "depeg-event-search-data",
    checkCommand: "tsx scripts/maintenance/generate-depeg-event-search-data.ts --check",
    command: "tsx scripts/maintenance/generate-depeg-event-search-data.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "pinned-input",
    script: "scripts/maintenance/generate-depeg-event-search-data.ts",
  },
  {
    id: "homepage-bootstrap",
    checkCommand: "tsx scripts/maintenance/generate-homepage-bootstrap.ts --check",
    command: "tsx scripts/maintenance/generate-homepage-bootstrap.ts",
    phase: 0,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-homepage-bootstrap.ts",
  },
  {
    id: "postman",
    checkCommand: "tsx scripts/maintenance/generate-postman-collection.ts --check",
    command: "tsx scripts/maintenance/generate-postman-collection.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-postman-collection.ts",
  },
  {
    id: "openapi",
    checkCommand: "tsx scripts/maintenance/generate-openapi-spec.ts --check",
    command: "tsx scripts/maintenance/generate-openapi-spec.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-openapi-spec.ts",
  },
  {
    id: "world-map",
    checkCommand: "tsx scripts/maintenance/build-world-map-svg.ts --check",
    command: "tsx scripts/maintenance/build-world-map-svg.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-world-map-svg.ts",
  },
  {
    id: "safety-score-v8-evaluation-build",
    checkCommand: "tsx scripts/maintenance/generate-safety-score-v8-evaluation-build-manifest.ts --check",
    command: "tsx scripts/maintenance/generate-safety-score-v8-evaluation-build-manifest.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-safety-score-v8-evaluation-build-manifest.ts",
  },
  {
    id: "safety-score-v9-evaluation-build",
    checkCommand: "tsx scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts --check",
    command: "tsx scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts",
    bootstrap: true,
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts",
  },
  {
    id: "stablecoin-prevalidated-registry",
    checkCommand: "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs --check",
    command: "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
  },
  {
    id: "legacy-stablecoin-redirects",
    checkCommand: "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs --check",
    command: "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
  },
  {
    id: "stablecoin-client-registry",
    checkCommand: "node scripts/build-data/build-client-registry.mjs --check",
    command: "node scripts/build-data/build-client-registry.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/build-data/build-client-registry.mjs",
  },
  {
    id: "agent-code-map",
    checkCommand: "node scripts/maintenance/generate-agent-code-map.mjs --check",
    command: "node scripts/maintenance/generate-agent-code-map.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-prevalidated-registry", "legacy-stablecoin-redirects", "stablecoin-client-registry"],
    phase: 2,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-agent-code-map.mjs",
  },
  {
    id: "cemetery-dataset",
    checkCommand: "tsx scripts/maintenance/generate-cemetery-dataset.ts --check",
    command: "tsx scripts/maintenance/generate-cemetery-dataset.ts",
    dependsOn: ["stablecoin-prevalidated-registry"],
    phase: 2,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-cemetery-dataset.ts",
  },
  {
    id: "public-datasets",
    checkCommand: "tsx scripts/maintenance/generate-public-datasets.ts --check",
    command: "tsx scripts/maintenance/generate-public-datasets.ts",
    dependsOn: ["stablecoin-prevalidated-registry"],
    phase: 2,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-public-datasets.ts",
  },
  {
    id: "llms-txt",
    checkCommand: "tsx scripts/maintenance/generate-llms-txt.ts --check",
    command: "tsx scripts/maintenance/generate-llms-txt.ts",
    dependsOn: ["stablecoin-prevalidated-registry"],
    phase: 2,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-llms-txt.ts",
  },
  {
    id: "api-reference",
    checkCommand: "node scripts/maintenance/generate-api-reference.mjs --check",
    command: "node scripts/maintenance/generate-api-reference.mjs",
    dependsOn: ["openapi"],
    phase: 2,
    reproducibility: "mixed",
    script: "scripts/maintenance/generate-api-reference.mjs",
  },
  {
    id: "og-editorial",
    checkCommand: "node scripts/maintenance/build-og-editorial.mjs --check",
    command: "node scripts/maintenance/build-og-editorial.mjs",
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-editorial.mjs",
  },
  {
    id: "og-learn",
    checkCommand: "tsx scripts/maintenance/build-og-learn-images.ts --check",
    command: "tsx scripts/maintenance/build-og-learn-images.ts",
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-learn-images.ts",
  },
  {
    id: "og-case-studies",
    checkCommand: "tsx scripts/maintenance/build-og-case-studies.ts --check",
    command: "tsx scripts/maintenance/build-og-case-studies.ts",
    dependsOn: ["cemetery-dataset"],
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-case-studies.ts",
  },
];

/** @param {{ bootstrap?: boolean, check?: boolean, skip?: string[] }} [options] */
export function buildGeneratedArtifactCommands({ bootstrap = false, check = false, skip = [] } = {}) {
  const skipIds = new Set(skip);
  return GENERATED_ARTIFACT_REGISTRY.filter(
    (artifact) => !skipIds.has(artifact.id) && (!bootstrap || artifact.bootstrap === true),
  ).map((artifact) => {
    if (check && artifact.checkCommand) {
      return artifact.checkCommand;
    }
    return artifact.command;
  });
}

/** @param {{ bootstrap?: boolean, check?: boolean, skip?: string[] }} [options] */
export function buildGeneratedArtifactPhases({ bootstrap = false, check = false, skip = [] } = {}) {
  const skipIds = new Set(skip);
  const phases = new Map();

  for (const artifact of GENERATED_ARTIFACT_REGISTRY) {
    if (skipIds.has(artifact.id) || (bootstrap && artifact.bootstrap !== true)) continue;
    const command = check && artifact.checkCommand ? artifact.checkCommand : artifact.command;
    const phase = phases.get(artifact.phase) ?? [];
    phase.push({ ...artifact, command });
    phases.set(artifact.phase, phase);
  }

  return [...phases.entries()]
    .sort(([left], [right]) => left - right)
    .map(([phase, artifacts]) => ({ phase, artifacts }));
}
