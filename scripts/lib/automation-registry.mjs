import { SITEMAP_COMMIT_DERIVED_SOURCE_PATHS } from "./commit-derived-artifacts.mjs";

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

const PAGES_EXTRA_EXACT_PATHS = [
  "next.config.ts",
  "postcss.config.mjs",
  "scripts/maintenance/build-world-map-svg.ts",
  "scripts/maintenance/generate-docs-metadata.ts",
  "scripts/maintenance/generate-homepage-bootstrap.ts",
  "scripts/maintenance/generate-llms-txt.ts",
  "scripts/maintenance/generate-markdown-exports.ts",
  "scripts/maintenance/generate-openapi-spec.ts",
  "scripts/maintenance/generate-postman-collection.ts",
  "scripts/maintenance/serve-static-export.mjs",
  "scripts/maintenance/sync-depeg-events.ts",
  "scripts/maintenance/sync-digests.ts",
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
  "docs/listing-policy.md",
  "docs/mint-burn-flows.md",
  "docs/pricing-pipeline.md",
  "docs/redemption-backstops.md",
  "docs/report-cards.md",
  "docs/shadow-stablecoins.md",
  "docs/stability-index.md",
  "docs/worker-and-api-limits.md",
  "docs/yield-intelligence.md",
];

export const DEPLOY_IMPACT_REGISTRY = {
  fullDeployInfra: {
    exactPaths: [
      ".github/workflows/deploy-cloudflare.yml",
      "package-lock.json",
      "package.json",
      "scripts/ci/classify-deploy-changes.mjs",
      "scripts/lib/automation-registry.mjs",
      "scripts/lib/deploy-impact.mjs",
    ],
    prefixes: [],
  },
  fullDeployGuardrails: {
    exactPaths: [],
  },
  pages: {
    exactPaths: uniqueSorted([...PAGES_EXTRA_EXACT_PATHS, ...PUBLIC_DOC_SOURCE_PATHS]),
    prefixes: ["data/", "functions/", "public/", "shared/", "src/"],
    workflowOnlyExactPaths: [".github/workflows/pages-release.yml", ".github/workflows/rebuild-pages.yml"],
  },
  worker: {
    exactPaths: [],
    prefixes: ["worker/"],
    sharedExcludedPaths: [
      "shared/lib/pharosville-api-contract.ts",
      "shared/lib/public-docs.ts",
      "shared/types/pharosville.ts",
    ],
    sharedExcludedPrefixes: ["shared/data/funding/", "shared/lib/selector/"],
  },
  workerRelease: {
    excludedPaths: ["worker/migrations/MANIFEST.md"],
    exactPaths: [
      "package-lock.json",
      "package.json",
      "worker/package.json",
      "worker/tsconfig.json",
      "worker/wrangler.toml",
    ],
    prefixes: ["worker/assets/", "worker/migrations/", "worker/src/"],
    sharedExcludedPaths: [
      "shared/lib/pharosville-api-contract.ts",
      "shared/lib/public-docs.ts",
      "shared/types/pharosville.ts",
    ],
    sharedExcludedPrefixes: ["shared/data/funding/", "shared/lib/selector/"],
  },
};

export function findDuplicateDeployImpactExactPaths(registry = DEPLOY_IMPACT_REGISTRY) {
  const groups = [
    ["fullDeployInfra", registry.fullDeployInfra.exactPaths],
    ["fullDeployGuardrails", registry.fullDeployGuardrails.exactPaths],
    ["pages", registry.pages.exactPaths],
    ["pages.workflowOnlyExactPaths", registry.pages.workflowOnlyExactPaths],
    ["worker", registry.worker.exactPaths],
    ["worker.sharedExcludedPaths", registry.worker.sharedExcludedPaths],
    ["workerRelease.excludedPaths", registry.workerRelease.excludedPaths],
    ["workerRelease", registry.workerRelease.exactPaths],
    ["workerRelease.sharedExcludedPaths", registry.workerRelease.sharedExcludedPaths],
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

function generatedArtifact(definition) {
  return {
    ...definition,
    inputState: definition.inputState ?? "working-tree",
    sourcePaths: uniqueSorted([definition.script, ...(definition.sourcePaths ?? [])]),
    outputPaths: uniqueSorted(definition.outputPaths ?? []),
  };
}

export const GENERATED_ARTIFACT_REGISTRY = [
  generatedArtifact({
    id: "stablecoin-catalog",
    checkCommand: "tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts --check",
    command: "tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts",
    bootstrap: true,
    outputPaths: ["shared/data/stablecoins/coins.generated.json"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-stablecoin-per-coin-asset.ts",
    sourcePaths: ["shared/data/stablecoins/coins/**", "shared/data/stablecoins/domains/**"],
  }),
  generatedArtifact({
    id: "agents-doc",
    checkCommand: "node scripts/maintenance/generate-agents-doc.mjs --check",
    command: "node scripts/maintenance/generate-agents-doc.mjs",
    bootstrap: true,
    outputPaths: ["AGENTS.md"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-agents-doc.mjs",
    sourcePaths: ["CLAUDE.md"],
  }),
  generatedArtifact({
    id: "sitemap-dates",
    checkCommand: "tsx scripts/maintenance/generate-sitemap-dates.ts --check",
    command: "tsx scripts/maintenance/generate-sitemap-dates.ts",
    inputState: "committed-history",
    outputPaths: ["src/generated/sitemap-dates.json", "src/generated/sitemap-dates.json.d.ts"],
    phase: 0,
    reproducibility: "git-history-derived",
    script: "scripts/maintenance/generate-sitemap-dates.ts",
    sourcePaths: SITEMAP_COMMIT_DERIVED_SOURCE_PATHS,
  }),
  generatedArtifact({
    id: "case-study-client-index",
    checkCommand: "tsx scripts/maintenance/generate-case-study-client-index.ts --check",
    command: "tsx scripts/maintenance/generate-case-study-client-index.ts",
    bootstrap: true,
    outputPaths: ["src/app/learn/case-studies/content/client-index.ts"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-case-study-client-index.ts",
    sourcePaths: ["src/app/learn/case-studies/content/**"],
  }),
  generatedArtifact({
    id: "docs-metadata",
    checkCommand: "tsx scripts/maintenance/generate-docs-metadata.ts --check",
    command: "tsx scripts/maintenance/generate-docs-metadata.ts",
    inputState: "committed-history",
    outputPaths: ["src/generated/docs-metadata.json", "src/generated/docs-metadata.json.d.ts"],
    phase: 0,
    reproducibility: "git-history-derived",
    script: "scripts/maintenance/generate-docs-metadata.ts",
    sourcePaths: [...PUBLIC_DOC_SOURCE_PATHS, "shared/lib/public-docs.ts"],
  }),
  generatedArtifact({
    id: "depeg-event-search-data",
    checkCommand: "tsx scripts/maintenance/generate-depeg-event-search-data.ts --check",
    command: "tsx scripts/maintenance/generate-depeg-event-search-data.ts",
    bootstrap: true,
    outputPaths: [
      "src/generated/depeg-event-related-data.json",
      "src/generated/depeg-event-related-data.json.d.ts",
      "src/generated/depeg-event-search-data.json",
      "src/generated/depeg-event-search-data.json.d.ts",
    ],
    phase: 0,
    reproducibility: "pinned-input",
    script: "scripts/maintenance/generate-depeg-event-search-data.ts",
    sourcePaths: ["data/depeg-events.json", "src/app/depeg/[event]/config.ts"],
  }),
  generatedArtifact({
    id: "homepage-bootstrap",
    checkCommand: "tsx scripts/maintenance/generate-homepage-bootstrap.ts --check",
    command: "tsx scripts/maintenance/generate-homepage-bootstrap.ts",
    outputPaths: ["src/generated/homepage-bootstrap.json"],
    phase: 0,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-homepage-bootstrap.ts",
    sourcePaths: ["src/lib/api-query-descriptors.ts", "src/lib/homepage-bootstrap*.ts"],
  }),
  generatedArtifact({
    id: "postman",
    checkCommand: "tsx scripts/maintenance/generate-postman-collection.ts --check",
    command: "tsx scripts/maintenance/generate-postman-collection.ts",
    bootstrap: true,
    outputPaths: [
      "public/postman/pharos-api.postman_collection.json",
      "public/postman/pharos-api.postman_environment.json",
    ],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-postman-collection.ts",
    sourcePaths: ["scripts/lib/public-api-artifact-catalog.ts"],
  }),
  generatedArtifact({
    id: "openapi",
    checkCommand: "tsx scripts/maintenance/generate-openapi-spec.ts --check",
    command: "tsx scripts/maintenance/generate-openapi-spec.ts",
    bootstrap: true,
    outputPaths: ["public/openapi.json"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-openapi-spec.ts",
    sourcePaths: ["scripts/lib/public-api-artifact-catalog.ts"],
  }),
  generatedArtifact({
    id: "world-map",
    checkCommand: "tsx scripts/maintenance/build-world-map-svg.ts --check",
    command: "tsx scripts/maintenance/build-world-map-svg.ts",
    bootstrap: true,
    outputPaths: ["public/maps/world-countries.svg"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-world-map-svg.ts",
    sourcePaths: ["scripts/data/m49-to-iso2.ts", "scripts/data/world-countries-110m.json"],
  }),
  generatedArtifact({
    id: "safety-score-v9-shock-coverage-registry",
    checkCommand: "tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts --check",
    command: "tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts",
    bootstrap: true,
    outputPaths: ["shared/data/safety-score-v9/shock-coverage-measurements-v1.json"],
    phase: 0,
    reproducibility: "pinned-input",
    script: "scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts",
    sourcePaths: [
      "shared/data/safety-score-v9/mechanism-measurements/**/*-shock-coverage.json",
      "shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json",
    ],
  }),
  generatedArtifact({
    id: "safety-score-v9-evaluation-build",
    checkCommand: "tsx scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts --check",
    command: "tsx scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts",
    bootstrap: true,
    outputPaths: ["shared/data/safety-score-v9/evaluation-build-manifest-v1.ts"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts",
    sourcePaths: [
      "shared/lib/safety-score-v9/**",
      "shared/types/safety-score-v9*.ts",
      "worker/src/lib/safety-score-v9*.ts",
    ],
  }),
  generatedArtifact({
    id: "stablecoin-prevalidated-registry",
    checkCommand: "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs --check",
    command: "node scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    outputPaths: [
      "shared/data/stablecoins/coins.prevalidated.generated.ts",
      "shared/data/stablecoins/report-card-registry-fingerprint.generated.ts",
    ],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-stablecoin-prevalidated-registry.mjs",
    sourcePaths: [
      "shared/data/stablecoins/coins.generated.json",
      "shared/data/stablecoins/canonical-order.json",
      "shared/data/dead-stablecoins.json",
      "shared/lib/dead-stablecoins.ts",
      "shared/lib/sha256.ts",
      "shared/lib/stable-json.ts",
      "shared/lib/stablecoins/registry.ts",
      "shared/lib/stablecoins/status.ts",
    ],
  }),
  generatedArtifact({
    id: "legacy-stablecoin-redirects",
    checkCommand: "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs --check",
    command: "node scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    outputPaths: ["shared/data/stablecoins/legacy-llama-redirects.generated.json"],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-legacy-stablecoin-redirects.mjs",
    sourcePaths: ["shared/data/stablecoins/coins.generated.json"],
  }),
  generatedArtifact({
    id: "stablecoin-client-registry",
    checkCommand: "node scripts/build-data/build-client-registry.mjs --check",
    command: "node scripts/build-data/build-client-registry.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    outputPaths: [
      "shared/data/stablecoins/coins.client.generated.json",
      "shared/data/stablecoins/coins.compliance.generated.json",
      "shared/data/stablecoins/coins.telegram-mini-app.generated.json",
    ],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/build-data/build-client-registry.mjs",
    sourcePaths: ["shared/data/stablecoins/coins.generated.json"],
  }),
  generatedArtifact({
    id: "cemetery-dataset",
    checkCommand: "tsx scripts/maintenance/generate-cemetery-dataset.ts --check",
    command: "tsx scripts/maintenance/generate-cemetery-dataset.ts",
    dependsOn: ["stablecoin-prevalidated-registry"],
    outputPaths: ["public/datasets/stablecoin-cemetery.csv", "public/datasets/stablecoin-cemetery.json"],
    phase: 2,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-cemetery-dataset.ts",
    sourcePaths: ["shared/data/dead-stablecoins.json", "shared/lib/cemetery*.ts"],
  }),
  generatedArtifact({
    id: "public-datasets",
    checkCommand: "tsx scripts/maintenance/generate-public-datasets.ts --check",
    command: "tsx scripts/maintenance/generate-public-datasets.ts",
    dependsOn: ["stablecoin-prevalidated-registry"],
    outputPaths: ["public/datasets/**", "public/sheets/*.csv"],
    phase: 2,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-public-datasets.ts",
    sourcePaths: ["shared/lib/api-endpoints/datasets.ts", "shared/lib/stablecoins/registry.ts"],
  }),
  generatedArtifact({
    id: "llms-txt",
    checkCommand: "tsx scripts/maintenance/generate-llms-txt.ts --check",
    command: "tsx scripts/maintenance/generate-llms-txt.ts",
    dependsOn: ["stablecoin-prevalidated-registry"],
    outputPaths: ["public/llms.txt"],
    phase: 2,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-llms-txt.ts",
    sourcePaths: ["data/digests.json", "docs/*.md", "shared/lib/public-docs.ts", "src/app/learn/**"],
  }),
  generatedArtifact({
    id: "api-reference",
    checkCommand: "node scripts/maintenance/generate-api-reference.mjs --check",
    command: "node scripts/maintenance/generate-api-reference.mjs",
    dependsOn: ["openapi"],
    outputPaths: ["docs/api-reference.md"],
    phase: 2,
    reproducibility: "mixed",
    script: "scripts/maintenance/generate-api-reference.mjs",
    sourcePaths: ["public/openapi.json"],
  }),
  generatedArtifact({
    id: "og-editorial",
    checkCommand: "node scripts/maintenance/build-og-editorial.mjs --check",
    command: "node scripts/maintenance/build-og-editorial.mjs",
    outputPaths: ["public/og-*.png", "scripts/maintenance/state/og-editorial-signatures.json"],
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-editorial.mjs",
    sourcePaths: ["scripts/maintenance/state/og-editorial-signatures.json", "src/app/**"],
  }),
  generatedArtifact({
    id: "og-learn",
    checkCommand: "tsx scripts/maintenance/build-og-learn-images.ts --check",
    command: "tsx scripts/maintenance/build-og-learn-images.ts",
    outputPaths: ["agents/og-learn-staging/og-learn-*.svg", "public/og-learn-*.png"],
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-learn-images.ts",
    sourcePaths: ["src/app/learn/mechanisms/**"],
  }),
  generatedArtifact({
    id: "og-case-studies",
    checkCommand: "tsx scripts/maintenance/build-og-case-studies.ts --check",
    command: "tsx scripts/maintenance/build-og-case-studies.ts",
    dependsOn: ["cemetery-dataset"],
    outputPaths: ["public/og-learn-case-*.png", "scripts/maintenance/state/og-case-study-signatures.json"],
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-case-studies.ts",
    sourcePaths: ["data/logos.json", "public/datasets/stablecoin-cemetery.json", "src/app/learn/case-studies/**"],
  }),
];

function generatedArtifactById(registry = GENERATED_ARTIFACT_REGISTRY) {
  return new Map(registry.map((artifact) => [artifact.id, artifact]));
}

function assertKnownGeneratedArtifactIds(ids, registry = GENERATED_ARTIFACT_REGISTRY) {
  const knownIds = new Set(registry.map((artifact) => artifact.id));
  const unknownIds = uniqueSorted(ids.filter((id) => !knownIds.has(id)));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown generated artifact id(s): ${unknownIds.join(", ")}`);
  }
}

function assertKnownGeneratedArtifactPhases(phases, registry = GENERATED_ARTIFACT_REGISTRY) {
  const knownPhases = new Set(registry.map((artifact) => artifact.phase));
  const unknownPhases = uniqueSorted(phases.filter((phase) => !knownPhases.has(phase)));
  if (unknownPhases.length > 0) {
    throw new Error(`Unknown generated artifact phase(s): ${unknownPhases.join(", ")}`);
  }
}

/**
 * @param {{
 *   bootstrap?: boolean,
 *   only?: string[],
 *   phases?: number[],
 *   skip?: string[],
 * }} [options]
 */
export function selectGeneratedArtifacts({ bootstrap = false, only = [], phases = [], skip = [] } = {}) {
  assertKnownGeneratedArtifactIds([...only, ...skip]);
  assertKnownGeneratedArtifactPhases(phases);

  const artifactById = generatedArtifactById();
  const onlyIds = new Set(only);
  const phaseSet = new Set(phases);
  const skipIds = new Set(skip);
  const selectedIds = new Set();
  const usesExplicitIdSelection = onlyIds.size > 0;

  function isEligibleBaseArtifact(artifact) {
    return (
      !skipIds.has(artifact.id) &&
      (!bootstrap || artifact.bootstrap === true) &&
      (!usesExplicitIdSelection || onlyIds.has(artifact.id)) &&
      (phaseSet.size === 0 || phaseSet.has(artifact.phase))
    );
  }

  function includeWithDependencies(id) {
    if (skipIds.has(id) || selectedIds.has(id)) return;
    const artifact = artifactById.get(id);
    if (!artifact || (bootstrap && artifact.bootstrap !== true)) return;

    for (const dependency of artifact.dependsOn ?? []) {
      includeWithDependencies(dependency);
    }
    selectedIds.add(id);
  }

  for (const artifact of GENERATED_ARTIFACT_REGISTRY) {
    if (!isEligibleBaseArtifact(artifact)) continue;

    if (usesExplicitIdSelection) {
      includeWithDependencies(artifact.id);
      continue;
    }
    selectedIds.add(artifact.id);
  }

  return GENERATED_ARTIFACT_REGISTRY.filter((artifact) => selectedIds.has(artifact.id));
}

/** @param {{ bootstrap?: boolean, check?: boolean, only?: string[], phases?: number[], skip?: string[] }} [options] */
export function buildGeneratedArtifactCommands({
  bootstrap = false,
  check = false,
  only = [],
  phases = [],
  skip = [],
} = {}) {
  return selectGeneratedArtifacts({ bootstrap, only, phases, skip }).map((artifact) => {
    if (check && artifact.checkCommand) {
      return artifact.checkCommand;
    }
    return artifact.command;
  });
}

/** @param {{ bootstrap?: boolean, check?: boolean, only?: string[], phases?: number[], skip?: string[] }} [options] */
export function buildGeneratedArtifactPhases({
  bootstrap = false,
  check = false,
  only = [],
  phases: phaseFilters = [],
  skip = [],
} = {}) {
  const phaseGroups = new Map();

  for (const artifact of selectGeneratedArtifacts({ bootstrap, only, phases: phaseFilters, skip })) {
    const command = check && artifact.checkCommand ? artifact.checkCommand : artifact.command;
    const phaseArtifacts = phaseGroups.get(artifact.phase) ?? [];
    phaseArtifacts.push({ ...artifact, command });
    phaseGroups.set(artifact.phase, phaseArtifacts);
  }

  return [...phaseGroups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([phase, artifacts]) => ({ phase, artifacts }));
}
