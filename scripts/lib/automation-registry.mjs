import { SITEMAP_COMMIT_DERIVED_SOURCE_PATHS } from "./sitemap-source-paths.mts";
import { createRequire } from "node:module";

const PUBLIC_DOC_SOURCE_FILES = createRequire(import.meta.url)("../../shared/lib/public-doc-manifest.json");

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

const PAGES_EXTRA_EXACT_PATHS = [
  "next.config.ts",
  "postcss.config.mjs",
  "scripts/maintenance/build-world-map-svg.ts",
  "scripts/maintenance/generate-docs-metadata.ts",
  "scripts/maintenance/generate-llms-txt.ts",
  "scripts/maintenance/generate-markdown-exports.ts",
  "scripts/maintenance/generate-openapi-spec.ts",
  "scripts/maintenance/generate-postman-collection.ts",
  "scripts/maintenance/serve-static-export.ts",
  "scripts/maintenance/sync-depeg-events.ts",
  "scripts/maintenance/sync-digests.ts",
  "scripts/maintenance/wait-pages-release-marker.ts",
  "tsconfig.json",
];

const PUBLIC_DOC_SOURCE_PATHS = PUBLIC_DOC_SOURCE_FILES.map((source) => `docs/${source}`);

export const DEPLOY_IMPACT_REGISTRY = {
  fullDeployInfra: {
    exactPaths: [
      ".github/workflows/deploy-cloudflare.yml",
      "package-lock.json",
      "package.json",
      "scripts/ci/classify-deploy-changes.ts",
      "scripts/lib/automation-registry.mjs",
      "scripts/lib/deploy-impact.mts",
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
      "shared/lib/public-doc-manifest.json",
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
      "shared/lib/public-doc-manifest.json",
      "shared/types/pharosville.ts",
    ],
    sharedExcludedPrefixes: ["shared/data/funding/", "shared/lib/selector/"],
  },
};

export const GENERATED_ARTIFACT_BUILD_LIFECYCLES = ["compile-input", "post-refresh", "maintenance-only"];

function generatedArtifact(definition) {
  if (!GENERATED_ARTIFACT_BUILD_LIFECYCLES.includes(definition.buildLifecycle)) {
    throw new Error(
      `Generated artifact ${definition.id ?? "<unknown>"} must declare a valid buildLifecycle`,
    );
  }
  return {
    ...definition,
    autoStage: definition.autoStage ?? false,
    checkable: definition.checkable ?? true,
    inputState: definition.inputState ?? "working-tree",
    sourcePaths: uniqueSorted([definition.script, ...(definition.sourcePaths ?? [])]),
    outputPaths: uniqueSorted(definition.outputPaths ?? []),
  };
}

export const GENERATED_ARTIFACT_REGISTRY = [
  generatedArtifact({
    id: "stablecoin-catalog",
    buildLifecycle: "compile-input",
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
    buildLifecycle: "maintenance-only",
    autoStage: true,
    checkCommand: "node --import tsx scripts/maintenance/generate-agents-doc.ts --check",
    command: "node --import tsx scripts/maintenance/generate-agents-doc.ts",
    bootstrap: true,
    outputPaths: ["AGENTS.md"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-agents-doc.ts",
    sourcePaths: ["CLAUDE.md"],
  }),
  generatedArtifact({
    id: "sitemap-dates",
    buildLifecycle: "compile-input",
    checkCommand: "tsx scripts/maintenance/generate-sitemap-dates.ts --check",
    command: "tsx scripts/maintenance/generate-sitemap-dates.ts",
    checkable: false,
    inputState: "build-time",
    outputPaths: ["src/generated/sitemap-dates.json", "src/generated/sitemap-dates.json.d.ts"],
    phase: 0,
    reproducibility: "git-history-derived",
    script: "scripts/maintenance/generate-sitemap-dates.ts",
    sourcePaths: SITEMAP_COMMIT_DERIVED_SOURCE_PATHS,
  }),
  generatedArtifact({
    id: "case-study-client-index",
    buildLifecycle: "compile-input",
    checkCommand: "tsx scripts/maintenance/generate-case-study-client-index.ts --check",
    command: "tsx scripts/maintenance/generate-case-study-client-index.ts",
    bootstrap: true,
    outputPaths: ["src/lib/case-study-client-index.ts"],
    phase: 0,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-case-study-client-index.ts",
    sourcePaths: ["src/lib/case-studies/**"],
  }),
  generatedArtifact({
    id: "docs-metadata",
    buildLifecycle: "compile-input",
    checkCommand: "tsx scripts/maintenance/generate-docs-metadata.ts --check",
    command: "tsx scripts/maintenance/generate-docs-metadata.ts",
    checkable: false,
    inputState: "build-time",
    outputPaths: ["src/generated/docs-metadata.json", "src/generated/docs-metadata.json.d.ts"],
    phase: 0,
    reproducibility: "git-history-derived",
    script: "scripts/maintenance/generate-docs-metadata.ts",
    sourcePaths: [...PUBLIC_DOC_SOURCE_PATHS, "shared/lib/public-doc-manifest.json", "shared/lib/public-docs.ts"],
  }),
  generatedArtifact({
    id: "depeg-event-search-data",
    buildLifecycle: "post-refresh",
    // No autoStage: every output below is gitignored by `/src/generated/*`
    // since 0b76714f03 untracked them. Staging them aborts the commit.
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
    sourcePaths: ["data/depeg-events.json", "src/lib/depeg-event-config.ts"],
  }),
  generatedArtifact({
    id: "postman",
    buildLifecycle: "compile-input",
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
    buildLifecycle: "compile-input",
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
    buildLifecycle: "compile-input",
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
    buildLifecycle: "maintenance-only",
    autoStage: true,
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
    buildLifecycle: "maintenance-only",
    autoStage: true,
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
    id: "report-card-registry-fingerprint",
    buildLifecycle: "compile-input",
    checkCommand: "tsx scripts/maintenance/generate-report-card-registry-fingerprint.ts --check",
    command: "tsx scripts/maintenance/generate-report-card-registry-fingerprint.ts",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    outputPaths: ["shared/data/stablecoins/report-card-registry-fingerprint.generated.ts"],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-report-card-registry-fingerprint.ts",
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
    buildLifecycle: "compile-input",
    checkCommand: "node --import tsx scripts/maintenance/generate-legacy-stablecoin-redirects.ts --check",
    command: "node --import tsx scripts/maintenance/generate-legacy-stablecoin-redirects.ts",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    outputPaths: ["shared/data/stablecoins/legacy-llama-redirects.generated.json"],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-legacy-stablecoin-redirects.ts",
    sourcePaths: ["shared/data/stablecoins/coins.generated.json"],
  }),
  generatedArtifact({
    id: "stablecoin-client-registry",
    buildLifecycle: "compile-input",
    checkCommand: "node scripts/build-data/build-client-registry.mjs --check",
    command: "node scripts/build-data/build-client-registry.mjs",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    outputPaths: [
      "shared/data/stablecoins/coins.client.generated.json",
      "shared/data/stablecoins/coins.compliance.generated.json",
      "shared/data/stablecoins/coins.telegram-mini-app.generated.json",
      "shared/data/stablecoins/coins.worker-runtime.generated.json",
    ],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/build-data/build-client-registry.mjs",
    sourcePaths: [
      "shared/data/stablecoins/canonical-order.json",
      "shared/data/stablecoins/coins.generated.json",
    ],
  }),
  generatedArtifact({
    id: "stablecoin-client-projections",
    buildLifecycle: "compile-input",
    checkCommand: "node --import tsx scripts/build-data/generate-stablecoin-client-projections.ts --check",
    command: "node --import tsx scripts/build-data/generate-stablecoin-client-projections.ts",
    bootstrap: true,
    dependsOn: ["stablecoin-catalog"],
    outputPaths: [
      "src/generated/command-palette-search-data.ts",
      "src/generated/stablecoin-static-data.ts",
    ],
    phase: 1,
    reproducibility: "deterministic",
    script: "scripts/build-data/generate-stablecoin-client-projections.ts",
    sourcePaths: [
      "shared/data/dead-stablecoins.json",
      "shared/data/stablecoins/canonical-order.json",
      "shared/data/stablecoins/coins.generated.json",
      "shared/data/stablecoins/listing-decisions.json",
      "shared/lib/dead-stablecoins.ts",
      "shared/lib/stablecoins/aggregate-registry.ts",
      "shared/lib/stablecoins/aggregate-universe.ts",
      "shared/lib/stablecoins/listing-governance.ts",
      "shared/lib/stablecoins/registry.ts",
      "shared/lib/stablecoins/status.ts",
    ],
  }),
  generatedArtifact({
    id: "cemetery-dataset",
    buildLifecycle: "maintenance-only",
    autoStage: true,
    checkCommand: "tsx scripts/maintenance/generate-cemetery-dataset.ts --check",
    command: "tsx scripts/maintenance/generate-cemetery-dataset.ts",
    dependsOn: ["report-card-registry-fingerprint"],
    outputPaths: ["public/datasets/stablecoin-cemetery.csv", "public/datasets/stablecoin-cemetery.json"],
    phase: 2,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-cemetery-dataset.ts",
    sourcePaths: ["shared/data/dead-stablecoins.json", "shared/lib/cemetery*.ts"],
  }),
  generatedArtifact({
    id: "public-datasets",
    buildLifecycle: "maintenance-only",
    autoStage: true,
    checkCommand: "tsx scripts/maintenance/generate-public-datasets.ts --check",
    command: "tsx scripts/maintenance/generate-public-datasets.ts",
    dependsOn: ["report-card-registry-fingerprint"],
    outputPaths: ["public/_redirects", "public/datasets/**", "src/lib/datasets/public-dataset-current.ts"],
    phase: 2,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-public-datasets.ts",
    sourcePaths: ["shared/lib/api-endpoints/datasets.ts", "shared/lib/stablecoins/registry.ts"],
  }),
  generatedArtifact({
    id: "llms-txt",
    buildLifecycle: "post-refresh",
    checkCommand: "tsx scripts/maintenance/generate-llms-txt.ts --check",
    command: "tsx scripts/maintenance/generate-llms-txt.ts",
    dependsOn: ["report-card-registry-fingerprint"],
    outputPaths: ["public/llms.txt"],
    phase: 2,
    reproducibility: "network-derived",
    script: "scripts/maintenance/generate-llms-txt.ts",
    sourcePaths: [
      "data/digests.json",
      "docs/*.md",
      "shared/lib/public-docs.ts",
      "src/lib/case-studies/**",
      "src/lib/glossary-content.ts",
      "src/lib/mechanism-explainers/**",
    ],
  }),
  generatedArtifact({
    id: "api-reference",
    buildLifecycle: "maintenance-only",
    checkCommand: "node --import tsx scripts/maintenance/generate-api-reference.ts --check",
    command: "node --import tsx scripts/maintenance/generate-api-reference.ts",
    dependsOn: ["openapi"],
    outputPaths: ["docs/api-reference.md"],
    phase: 2,
    reproducibility: "mixed",
    script: "scripts/maintenance/generate-api-reference.ts",
    sourcePaths: ["public/openapi.json"],
  }),
  generatedArtifact({
    id: "changelog-registry",
    buildLifecycle: "maintenance-only",
    autoStage: true,
    checkCommand: "node --import tsx scripts/maintenance/generate-changelog-registry.ts --check",
    command: "node --import tsx scripts/maintenance/generate-changelog-registry.ts",
    outputPaths: ["src/data/changelogs/index.ts"],
    phase: 2,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-changelog-registry.ts",
    sourcePaths: ["src/data/changelogs/*.ts"],
  }),
  generatedArtifact({
    id: "editorial-style",
    buildLifecycle: "compile-input",
    autoStage: true,
    checkCommand: "node --import tsx scripts/maintenance/generate-editorial-style.ts --check",
    command: "node --import tsx scripts/maintenance/generate-editorial-style.ts",
    outputPaths: ["shared/lib/editorial-style.generated.ts"],
    phase: 2,
    reproducibility: "deterministic",
    script: "scripts/maintenance/generate-editorial-style.ts",
    sourcePaths: ["docs/editorial-style.md"],
  }),
  generatedArtifact({
    id: "og-editorial",
    buildLifecycle: "maintenance-only",
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
    buildLifecycle: "maintenance-only",
    checkCommand: "tsx scripts/maintenance/build-og-learn-images.ts --check",
    command: "tsx scripts/maintenance/build-og-learn-images.ts",
    outputPaths: ["agents/og-learn-staging/og-learn-*.svg", "public/og-learn-*.png"],
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-learn-images.ts",
    sourcePaths: [
      "src/components/stablecoin-detail/mechanism-diagrams/**",
      "src/lib/mechanism-explainer-registry.ts",
    ],
  }),
  generatedArtifact({
    id: "og-case-studies",
    buildLifecycle: "maintenance-only",
    checkCommand: "tsx scripts/maintenance/build-og-case-studies.ts --check",
    command: "tsx scripts/maintenance/build-og-case-studies.ts",
    dependsOn: ["cemetery-dataset"],
    outputPaths: ["public/og-learn-case-*.png", "scripts/maintenance/state/og-case-study-signatures.json"],
    phase: 3,
    reproducibility: "deterministic",
    script: "scripts/maintenance/build-og-case-studies.ts",
    sourcePaths: ["data/logos.json", "public/datasets/stablecoin-cemetery.json", "src/lib/case-studies/**"],
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

function assertKnownGeneratedArtifactBuildLifecycles(lifecycles) {
  const knownLifecycles = new Set(GENERATED_ARTIFACT_BUILD_LIFECYCLES);
  const unknownLifecycles = uniqueSorted(lifecycles.filter((lifecycle) => !knownLifecycles.has(lifecycle)));
  if (unknownLifecycles.length > 0) {
    throw new Error(`Unknown generated artifact build lifecycle(s): ${unknownLifecycles.join(", ")}`);
  }
}

/**
 * Split selected artifact ids into those the pre-commit hook may regenerate and
 * stage on its own, and those a human must handle. Network-derived artifacts,
 * browser-rendered OG images, and gitignored outputs are normally manual: a
 * commit hook must not make network calls, take minutes, or stage nothing.
 * Offline-safe generators that preserve checked-in data may opt in explicitly.
 *
 * @param {readonly string[]} ids
 * @returns {{ autoStage: string[], manual: string[] }}
 */
export function selectAutoStageArtifactIds(ids) {
  assertKnownGeneratedArtifactIds([...ids]);
  const selected = new Set(ids);
  const autoStage = [];
  const manual = [];

  for (const artifact of GENERATED_ARTIFACT_REGISTRY) {
    if (!selected.has(artifact.id)) continue;
    (artifact.autoStage === true ? autoStage : manual).push(artifact.id);
  }

  return { autoStage, manual };
}

/**
 * @param {{
 *   bootstrap?: boolean,
 *   buildLifecycles?: string[],
 *   check?: boolean,
 *   only?: string[],
 *   phases?: number[],
 * }} [options]
 */
export function selectGeneratedArtifacts({
  bootstrap = false,
  buildLifecycles = [],
  check = false,
  only = [],
  phases = [],
} = {}) {
  assertKnownGeneratedArtifactIds(only);
  assertKnownGeneratedArtifactPhases(phases);
  assertKnownGeneratedArtifactBuildLifecycles(buildLifecycles);

  const artifactById = generatedArtifactById();
  const buildLifecycleSet = new Set(buildLifecycles);
  const onlyIds = new Set(only);
  const phaseSet = new Set(phases);
  const selectedIds = new Set();
  const usesExplicitIdSelection = onlyIds.size > 0;
  const usesLifecycleSelection = buildLifecycleSet.size > 0;

  // `checkable: false` artifacts are gitignored build-time projections. They
  // are regenerated moments before any check would run, so verifying them
  // compares a file against itself; exclude them from check selection outright,
  // including when another artifact reaches them through dependsOn.
  function isCheckEligible(artifact) {
    return !check || artifact.checkable !== false;
  }

  function isEligibleBaseArtifact(artifact) {
    return (
      isCheckEligible(artifact) &&
      (!bootstrap || artifact.bootstrap === true) &&
      (buildLifecycleSet.size === 0 || buildLifecycleSet.has(artifact.buildLifecycle)) &&
      (!usesExplicitIdSelection || onlyIds.has(artifact.id)) &&
      (phaseSet.size === 0 || phaseSet.has(artifact.phase))
    );
  }

  function includeWithDependencies(id) {
    if (selectedIds.has(id)) return;
    const artifact = artifactById.get(id);
    if (
      !artifact ||
      (bootstrap && artifact.bootstrap !== true) ||
      !isCheckEligible(artifact)
    ) return;

    for (const dependency of artifact.dependsOn ?? []) {
      includeWithDependencies(dependency);
    }
    selectedIds.add(id);
  }

  for (const artifact of GENERATED_ARTIFACT_REGISTRY) {
    if (!isEligibleBaseArtifact(artifact)) continue;

    if (usesExplicitIdSelection || usesLifecycleSelection) {
      includeWithDependencies(artifact.id);
      continue;
    }
    selectedIds.add(artifact.id);
  }

  return GENERATED_ARTIFACT_REGISTRY.filter((artifact) => selectedIds.has(artifact.id));
}

/** @param {{ bootstrap?: boolean, buildLifecycles?: string[], check?: boolean, only?: string[], phases?: number[] }} [options] */
export function buildGeneratedArtifactPhases({
  bootstrap = false,
  buildLifecycles = [],
  check = false,
  only = [],
  phases: phaseFilters = [],
} = {}) {
  const phaseGroups = new Map();

  for (const artifact of selectGeneratedArtifacts({ bootstrap, buildLifecycles, check, only, phases: phaseFilters })) {
    const command = check && artifact.checkCommand ? artifact.checkCommand : artifact.command;
    const phaseArtifacts = phaseGroups.get(artifact.phase) ?? [];
    phaseArtifacts.push({ ...artifact, command });
    phaseGroups.set(artifact.phase, phaseArtifacts);
  }

  return [...phaseGroups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([phase, artifacts]) => ({ phase, artifacts }));
}
