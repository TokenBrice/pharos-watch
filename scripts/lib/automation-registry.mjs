export const DEPLOY_IMPACT_REGISTRY = {
  fullDeployInfra: {
    exactPaths: [
      ".github/workflows/deploy-cloudflare.yml",
      ".github/workflows/validate-ci.yml",
      "package-lock.json",
      "package.json",
      "scripts/classify-deploy-changes.mjs",
    ],
    prefixes: [
      ".github/actions/",
      "scripts/lib/",
    ],
  },
  fullDeployGuardrails: {
    exactPaths: [
      "scripts/audit-pricing-provider-config.ts",
      "scripts/check-critical-coverage.mjs",
      "scripts/check-cron-abort-contract.mjs",
      "scripts/check-cron-connection-budget.ts",
      "scripts/check-cron-schedule-sync.ts",
      "scripts/check-doc-source-paths.mjs",
      "scripts/check-doc-counts.mjs",
      "scripts/check-doc-sync.ts",
      "scripts/check-duplicate-exports.mjs",
      "scripts/check-env-contract.mjs",
      "scripts/check-hotspot-ratchet.mjs",
      "scripts/check-redemption-backstops.ts",
      "scripts/check-seo-static.mjs",
      "scripts/check-shared-cycles.mjs",
      "scripts/check-sql-interpolation-safety.mjs",
      "scripts/check-stablecoin-data.ts",
      "scripts/check-unused-code.mjs",
      "scripts/check-verified-doc-links.mjs",
      "scripts/check-worker-import-boundary.mjs",
      "scripts/check-worker-migrations.mjs",
      "scripts/generate-cemetery-dataset.ts",
      "scripts/rollback-pages-deployment.mjs",
      "scripts/run-critical-coverage.mjs",
      "scripts/run-generated-artifacts.mjs",
      "scripts/run-noncritical-tests.mjs",
      "scripts/run-validate-postbuild.mjs",
      "scripts/run-validate-prebuild.mjs",
      "scripts/smoke-api.mjs",
      "scripts/smoke-ops.mjs",
      "scripts/smoke-transport.mjs",
      "scripts/smoke-ui.mjs",
      "scripts/test-merge-gate.mjs",
    ],
  },
  pages: {
    exactPaths: [
      "next.config.ts",
      "postcss.config.mjs",
      "scripts/check-seo-static.mjs",
      "scripts/build-world-map-svg.ts",
      "scripts/generate-docs-metadata.ts",
      "scripts/generate-llms-txt.ts",
      "scripts/generate-markdown-exports.ts",
      "scripts/generate-openapi-spec.ts",
      "scripts/generate-postman-collection.ts",
      "scripts/run-generated-artifacts.mjs",
      "scripts/serve-static-export.mjs",
      "scripts/smoke-ui.mjs",
      "scripts/sync-digests.ts",
      "tsconfig.json",
    ],
    prefixes: [
      "data/",
      "functions/",
      "public/",
      "shared/",
      "src/",
    ],
    workflowOnlyExactPaths: [
      ".github/workflows/pages-prepare.yml",
      ".github/workflows/pages-publish.yml",
      ".github/workflows/pages-release.yml",
      ".github/workflows/rebuild-pages.yml",
    ],
  },
  worker: {
    exactPaths: [
      "scripts/check-cron-schedule-sync.ts",
      "scripts/check-worker-import-boundary.mjs",
      "scripts/check-worker-migrations.mjs",
      "scripts/smoke-api.mjs",
    ],
    prefixes: [
      "shared/",
      "worker/",
    ],
  },
  workerPromotion: {
    exactPaths: [
      "worker/package.json",
      "worker/tsconfig.json",
      "worker/wrangler.toml",
    ],
    prefixes: [
      "worker/assets/",
      "worker/migrations/",
      "worker/src/",
    ],
    sharedExcludedPaths: [
      "shared/lib/pharosville-api-contract.ts",
      "shared/lib/public-docs.ts",
      "shared/types/pharosville.ts",
    ],
  },
  workerRootRuntimePackages: [
    "@adraffy/ens-normalize",
    "@cf-wasm/resvg",
    "@noble/ciphers",
    "@noble/curves",
    "@noble/hashes",
    "@resvg/resvg-wasm",
    "@resvg/resvg-wasm-legacy",
    "@scure/base",
    "@scure/bip32",
    "@scure/bip39",
    "@shuding/opentype.js",
    "abitype",
    "base64-js",
    "camelize",
    "color-name",
    "css-background-parser",
    "css-box-shadow",
    "css-color-keywords",
    "css-gradient-parser",
    "css-to-react-native",
    "emoji-regex-xs",
    "escape-html",
    "eventemitter3",
    "fflate",
    "hex-rgb",
    "isows",
    "linebreak",
    "ox",
    "pako",
    "parse-css-color",
    "postcss-value-parser",
    "react",
    "satori",
    "string.prototype.codepointat",
    "tiny-inflate",
    "unicode-trie",
    "viem",
    "ws",
    "yoga-layout",
    "zod",
  ],
};

export const GENERATED_ARTIFACT_REGISTRY = [
  {
    id: "sitemap-dates",
    command: "tsx scripts/generate-sitemap-dates.ts",
    noncriticalTestPrerequisite: true,
    script: "scripts/generate-sitemap-dates.ts",
  },
  {
    id: "docs-metadata",
    command: "tsx scripts/generate-docs-metadata.ts",
    noncriticalTestPrerequisite: true,
    script: "scripts/generate-docs-metadata.ts",
  },
  {
    id: "cemetery-dataset",
    checkCommand: "tsx scripts/generate-cemetery-dataset.ts --check",
    command: "tsx scripts/generate-cemetery-dataset.ts",
    script: "scripts/generate-cemetery-dataset.ts",
  },
  {
    id: "postman",
    checkCommand: "tsx scripts/generate-postman-collection.ts --check",
    command: "tsx scripts/generate-postman-collection.ts",
    script: "scripts/generate-postman-collection.ts",
  },
  {
    id: "openapi",
    checkCommand: "tsx scripts/generate-openapi-spec.ts --check",
    command: "tsx scripts/generate-openapi-spec.ts",
    script: "scripts/generate-openapi-spec.ts",
  },
  {
    id: "llms-txt",
    checkCommand: "tsx scripts/generate-llms-txt.ts --check",
    command: "tsx scripts/generate-llms-txt.ts",
    script: "scripts/generate-llms-txt.ts",
  },
  {
    id: "stablecoin-frozen-registry",
    checkCommand: "node scripts/generate-stablecoin-frozen-registry.mjs --check",
    command: "node scripts/generate-stablecoin-frozen-registry.mjs",
    script: "scripts/generate-stablecoin-frozen-registry.mjs",
  },
  {
    id: "api-reference",
    checkCommand: "node scripts/generate-api-reference.mjs --check",
    command: "node scripts/generate-api-reference.mjs",
    script: "scripts/generate-api-reference.mjs",
  },
];

export function buildGeneratedArtifactCommands({ check = false } = {}) {
  return GENERATED_ARTIFACT_REGISTRY.map((artifact) => {
    if (check && artifact.checkCommand) {
      return artifact.checkCommand;
    }
    return artifact.command;
  });
}

export function getNoncriticalTestGeneratedPrerequisites() {
  return GENERATED_ARTIFACT_REGISTRY
    .filter((artifact) => artifact.noncriticalTestPrerequisite === true)
    .map((artifact) => artifact.script);
}
